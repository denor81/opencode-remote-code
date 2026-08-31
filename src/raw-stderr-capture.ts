import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { resolveDefaultLogDirectory } from "./logger.js"

const RAW_DIRECTORY_NAME = "raw"
const RAW_FILE_PATTERN =
  /^opencode-host-stderr-(\d{4}-\d{2}-\d{2})-([0-9a-f]{32})\.bin$/
const STARTUP_ID_PATTERN = /^[0-9a-f]{32}$/
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const RETAINED_UTC_DAYS = 5
const UTC_DAY_MILLISECONDS = 24 * 60 * 60 * 1_000

export const RAW_STDERR_CAPTURE_MAX_BYTES = 1024 * 1024

export type RawStderrStorageStatus =
  | "empty"
  | "complete"
  | "capture-failed"
  | "open-failed"
  | "write-failed"
  | "close-failed"

export type RawStderrRetentionStatus = "completed" | "failed" | "not-attempted"

export interface RawStderrCaptureSummary {
  observedBytes: number
  capturedBytes: number
  writtenBytes: number
  truncated: boolean
  storageStatus: RawStderrStorageStatus
  retentionStatus: RawStderrRetentionStatus
  filePath?: string
}

export interface RawStderrCapture {
  /** Observe a stderr chunk and retain the bounded exact prefix delivered here. */
  accept(chunk: Buffer): void
  /** Stop accepting bytes and settle all best-effort local filesystem work. */
  finalize(): Promise<RawStderrCaptureSummary>
  /** Stop accepting bytes and release the capture without filesystem work. */
  discard(): Promise<RawStderrCaptureSummary>
}

interface FileStatsLike {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

interface DirectoryEntryLike {
  readonly name: string
  isFile(): boolean
}

interface RawStderrFileSystem {
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<void>
  lstat(filePath: string): Promise<FileStatsLike>
  chmod(filePath: string, mode: number): Promise<void>
  open(filePath: string, flags: number, mode: number): Promise<unknown>
  fstat(handle: unknown): Promise<FileStatsLike>
  fchmod(handle: unknown, mode: number): Promise<void>
  write(
    handle: unknown,
    buffer: Buffer,
    offset: number,
    length: number
  ): Promise<number>
  close(handle: unknown): Promise<void>
  readdir(directory: string): Promise<readonly DirectoryEntryLike[]>
  unlink(filePath: string): Promise<void>
}

interface RawStderrCaptureOptions {
  env?: NodeJS.ProcessEnv
  startupID: string
  maxBytes?: number
  now?: () => Date
  /** Test seam; production callers allocate the bounded buffer with Buffer.alloc. */
  allocate?: (size: number) => Buffer
  /** Test seam; production callers use the secure Node filesystem implementation. */
  fileSystem?: Partial<RawStderrFileSystem>
}

interface CaptureSnapshot {
  observedBytes: number
  capturedBytes: number
  truncated: boolean
  captureFailed: boolean
}

interface FinalizationOptions {
  env?: NodeJS.ProcessEnv
  startupID: string | undefined
  now: () => Date
}

interface RawLocations {
  directory: string
  privateDirectories: readonly string[]
}

interface StorageResult {
  storageStatus: Exclude<RawStderrStorageStatus, "empty" | "capture-failed">
  writtenBytes: number
  filePath?: string
}

const DEFAULT_FILE_SYSTEM: RawStderrFileSystem = {
  async mkdir(directory, options) {
    await mkdir(directory, options)
  },
  async lstat(filePath) {
    return await lstat(filePath)
  },
  async chmod(filePath, mode) {
    await chmod(filePath, mode)
  },
  async open(filePath, flags, mode) {
    return await open(filePath, flags, mode)
  },
  async fstat(handle) {
    return await asFileHandle(handle).stat()
  },
  async fchmod(handle, mode) {
    await asFileHandle(handle).chmod(mode)
  },
  async write(handle, buffer, offset, length) {
    const result = await asFileHandle(handle).write(buffer, offset, length, null)
    return result.bytesWritten
  },
  async close(handle) {
    await asFileHandle(handle).close()
  },
  async readdir(directory) {
    return await readdir(directory, { withFileTypes: true })
  },
  async unlink(filePath) {
    await unlink(filePath)
  },
}

function asFileHandle(handle: unknown): FileHandle {
  return handle as FileHandle
}

function utcDay(now: Date): string {
  const day = now.toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Raw stderr finalization date is outside the supported range")
  }
  return day
}

function validUtcDay(value: string): boolean {
  try {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value
  } catch {
    return false
  }
}

function oldestRetainedDay(currentDay: string): string {
  const current = new Date(`${currentDay}T00:00:00.000Z`)
  return utcDay(new Date(current.getTime() - (RETAINED_UTC_DAYS - 1) * UTC_DAY_MILLISECONDS))
}

function staleRawFileName(fileName: string, currentDay: string): boolean {
  const match = RAW_FILE_PATTERN.exec(fileName)
  const day = match?.[1]
  if (day === undefined || !validUtcDay(day)) return false

  // Future files may reflect clock skew and are preserved rather than treated as stale.
  return day < oldestRetainedDay(currentDay)
}

function errnoIs(error: unknown, code: string): boolean {
  try {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === code
    )
  } catch {
    return false
  }
}

function resolveLocations(env: NodeJS.ProcessEnv | undefined): RawLocations {
  const logDirectory = resolveDefaultLogDirectory({ env })
  const directory = path.join(logDirectory, RAW_DIRECTORY_NAME)
  return {
    directory,
    privateDirectories: [path.dirname(logDirectory), logDirectory, directory],
  }
}

async function ensurePrivateDirectory(
  fileSystem: RawStderrFileSystem,
  directory: string
): Promise<void> {
  await fileSystem.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const beforeChmod = await fileSystem.lstat(directory)
  if (!beforeChmod.isDirectory() || beforeChmod.isSymbolicLink()) {
    throw new Error(`Raw stderr path is not a private directory: ${directory}`)
  }
  await fileSystem.chmod(directory, PRIVATE_DIRECTORY_MODE)
  const afterChmod = await fileSystem.lstat(directory)
  if (!afterChmod.isDirectory() || afterChmod.isSymbolicLink()) {
    throw new Error(`Raw stderr path stopped being a private directory: ${directory}`)
  }
}

async function ensurePrivateDirectories(
  fileSystem: RawStderrFileSystem,
  directories: readonly string[]
): Promise<void> {
  for (const directory of new Set(directories)) {
    await ensurePrivateDirectory(fileSystem, directory)
  }
}

async function storeCapture(
  fileSystem: RawStderrFileSystem,
  filePath: string,
  buffer: Buffer,
  capturedBytes: number
): Promise<StorageResult> {
  const flags =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
  let handle: unknown
  try {
    handle = await fileSystem.open(filePath, flags, PRIVATE_FILE_MODE)
  } catch {
    return { storageStatus: "open-failed", writtenBytes: 0 }
  }

  let storageStatus: StorageResult["storageStatus"] = "complete"
  let writtenBytes = 0
  try {
    try {
      const stats = await fileSystem.fstat(handle)
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Raw stderr path is not a regular file: ${filePath}`)
      }
      await fileSystem.fchmod(handle, PRIVATE_FILE_MODE)
    } catch {
      storageStatus = "open-failed"
    }

    if (storageStatus === "complete") {
      try {
        while (writtenBytes < capturedBytes) {
          const remaining = capturedBytes - writtenBytes
          const bytesWritten = await fileSystem.write(
            handle,
            buffer,
            writtenBytes,
            remaining
          )
          if (
            !Number.isSafeInteger(bytesWritten) ||
            bytesWritten <= 0 ||
            bytesWritten > remaining
          ) {
            throw new Error("Invalid raw stderr write result")
          }
          writtenBytes += bytesWritten
        }
      } catch {
        storageStatus = "write-failed"
      }
    }
  } finally {
    try {
      await fileSystem.close(handle)
    } catch {
      if (storageStatus === "complete") storageStatus = "close-failed"
    }
  }

  return { storageStatus, writtenBytes, filePath }
}

async function pruneRawCaptures(
  fileSystem: RawStderrFileSystem,
  directory: string,
  currentDay: string
): Promise<boolean> {
  let entries: readonly DirectoryEntryLike[]
  try {
    entries = await fileSystem.readdir(directory)
  } catch {
    return false
  }

  let failed = false
  for (const entry of entries) {
    let fileName: string
    try {
      if (!entry.isFile()) continue
      fileName = entry.name
      if (!staleRawFileName(fileName, currentDay)) continue
    } catch {
      failed = true
      continue
    }

    const filePath = path.join(directory, fileName)
    try {
      const stats = await fileSystem.lstat(filePath)
      if (!stats.isFile() || stats.isSymbolicLink()) continue
    } catch (error) {
      if (!errnoIs(error, "ENOENT")) failed = true
      continue
    }

    try {
      await fileSystem.unlink(filePath)
    } catch (error) {
      if (!errnoIs(error, "ENOENT")) failed = true
    }
  }
  return !failed
}

function unstoredStatus(
  snapshot: CaptureSnapshot,
  startupID: string | undefined
): RawStderrStorageStatus {
  if (snapshot.observedBytes === 0) return "empty"
  if (
    snapshot.captureFailed ||
    snapshot.capturedBytes === 0 ||
    startupID === undefined
  ) {
    return "capture-failed"
  }
  return "open-failed"
}

function fallbackSummary(
  snapshot: CaptureSnapshot,
  startupID: string | undefined
): RawStderrCaptureSummary {
  return {
    observedBytes: snapshot.observedBytes,
    capturedBytes: snapshot.capturedBytes,
    writtenBytes: 0,
    truncated: snapshot.truncated,
    storageStatus: unstoredStatus(snapshot, startupID),
    retentionStatus: "failed",
  }
}

function discardedSummary(snapshot: CaptureSnapshot): RawStderrCaptureSummary {
  return {
    observedBytes: snapshot.observedBytes,
    capturedBytes: snapshot.capturedBytes,
    writtenBytes: 0,
    truncated: snapshot.truncated,
    storageStatus: snapshot.observedBytes === 0 ? "empty" : "capture-failed",
    retentionStatus: "not-attempted",
  }
}

async function performFinalization(
  options: FinalizationOptions,
  fileSystem: RawStderrFileSystem,
  snapshot: CaptureSnapshot,
  buffer: Buffer | undefined
): Promise<RawStderrCaptureSummary> {
  const startupID = options.startupID
  let currentDay: string
  let locations: RawLocations
  try {
    currentDay = utcDay(options.now())
    locations = resolveLocations(options.env)
  } catch {
    return fallbackSummary(snapshot, startupID)
  }

  let directoriesReady = false
  try {
    await ensurePrivateDirectories(fileSystem, locations.privateDirectories)
    directoriesReady = true
  } catch {
    // Unsafe or unavailable directories block both storage and pruning.
  }

  let storageStatus = unstoredStatus(snapshot, startupID)
  let writtenBytes = 0
  let filePath: string | undefined
  if (
    snapshot.capturedBytes > 0 &&
    buffer !== undefined &&
    startupID !== undefined &&
    directoriesReady
  ) {
    try {
      const result = await storeCapture(
        fileSystem,
        path.join(
          locations.directory,
          `opencode-host-stderr-${currentDay}-${startupID}.bin`
        ),
        buffer,
        snapshot.capturedBytes
      )
      storageStatus =
        result.storageStatus === "complete" && snapshot.captureFailed
          ? "capture-failed"
          : result.storageStatus
      writtenBytes = result.writtenBytes
      filePath = result.filePath
    } catch {
      storageStatus = "write-failed"
    }
  }

  const retentionStatus: RawStderrRetentionStatus =
    directoriesReady &&
    (await pruneRawCaptures(fileSystem, locations.directory, currentDay).catch(() => false))
      ? "completed"
      : "failed"
  const summary: RawStderrCaptureSummary = {
    observedBytes: snapshot.observedBytes,
    capturedBytes: snapshot.capturedBytes,
    writtenBytes,
    truncated: snapshot.truncated,
    storageStatus,
    retentionStatus,
  }
  if (filePath !== undefined) summary.filePath = filePath
  return summary
}

function resolveMaxBytes(value: number | undefined): number {
  if (value === undefined) return RAW_STDERR_CAPTURE_MAX_BYTES
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > RAW_STDERR_CAPTURE_MAX_BYTES
  ) {
    throw new RangeError(
      `maxBytes must be a positive safe integer no greater than ${RAW_STDERR_CAPTURE_MAX_BYTES}`
    )
  }
  return value
}

function saturatingAdd(value: number, increment: number): number {
  return increment >= Number.MAX_SAFE_INTEGER - value
    ? Number.MAX_SAFE_INTEGER
    : value + increment
}

/** Create a bounded, launch-scoped raw stderr capture. */
export function createRawStderrCapture(options: RawStderrCaptureOptions): RawStderrCapture {
  const maxBytes = resolveMaxBytes(options.maxBytes)
  const selectedStartupID =
    typeof options.startupID === "string" && STARTUP_ID_PATTERN.test(options.startupID)
      ? options.startupID
      : undefined
  const fileSystem: RawStderrFileSystem = {
    ...DEFAULT_FILE_SYSTEM,
    ...options.fileSystem,
  }
  const finalizationOptions: FinalizationOptions = {
    env: options.env,
    startupID: selectedStartupID,
    now: options.now ?? (() => new Date()),
  }
  let captureBuffer: Buffer | undefined
  let observedBytes = 0
  let capturedBytes = 0
  let truncated = false
  let captureFailed = false
  let accepting = true
  let settlement: Promise<RawStderrCaptureSummary> | undefined

  try {
    const allocated =
      options.allocate === undefined ? Buffer.alloc(maxBytes) : options.allocate(maxBytes)
    if (!Buffer.isBuffer(allocated) || allocated.byteLength !== maxBytes) {
      throw new Error("Raw stderr allocation returned an invalid buffer")
    }
    captureBuffer = allocated
  } catch {
    captureFailed = true
  }

  function snapshot(): CaptureSnapshot {
    return {
      observedBytes,
      capturedBytes,
      truncated: truncated || observedBytes > capturedBytes,
      captureFailed,
    }
  }

  return {
    accept(chunk): void {
      if (!accepting) return
      try {
        if (!Buffer.isBuffer(chunk)) return
        const chunkBytes = chunk.byteLength
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0) return
        observedBytes = saturatingAdd(observedBytes, chunkBytes)
        if (chunkBytes === 0) return

        if (captureFailed || captureBuffer === undefined) {
          truncated = true
          return
        }
        const remaining = maxBytes - capturedBytes
        if (remaining <= 0) {
          truncated = true
          return
        }

        const bytesToCopy = Math.min(remaining, chunkBytes)
        let copied = 0
        try {
          copied = chunk.copy(captureBuffer, capturedBytes, 0, bytesToCopy)
        } catch {
          captureFailed = true
          truncated = true
          return
        }
        if (!Number.isSafeInteger(copied) || copied < 0 || copied > bytesToCopy) {
          captureFailed = true
          truncated = true
          return
        }
        capturedBytes += copied
        if (copied !== bytesToCopy) {
          captureFailed = true
          truncated = true
        }
        if (bytesToCopy < chunkBytes) truncated = true
      } catch {
        // Observer failures must not affect stderr draining or launcher cleanup.
      }
    },

    finalize(): Promise<RawStderrCaptureSummary> {
      if (settlement !== undefined) return settlement
      accepting = false
      const finalSnapshot = snapshot()
      const buffer = captureBuffer
      captureBuffer = undefined
      const fallback = fallbackSummary(finalSnapshot, selectedStartupID)
      settlement = Promise.resolve()
        .then(() => performFinalization(finalizationOptions, fileSystem, finalSnapshot, buffer))
        .catch(() => fallback)
      return settlement
    },

    discard(): Promise<RawStderrCaptureSummary> {
      if (settlement !== undefined) return settlement
      accepting = false
      const finalSnapshot = snapshot()
      captureBuffer = undefined
      settlement = Promise.resolve(discardedSummary(finalSnapshot))
      return settlement
    },
  }
}
