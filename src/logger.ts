import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { types } from "node:util"

const APPLICATION_NAME = "opencode-ssh"
const LOG_DIRECTORY_NAME = "logs"
const LOG_FILE_PATTERN = /^opencode-ssh-(\d{4}-\d{2}-\d{2})\.jsonl$/
const EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const DEFAULT_LOCAL_IO_TIMEOUT_MS = 500
const MAX_LOCAL_IO_TIMEOUT_MS = 60_000
const MAX_EVENT_NAME_BYTES = 128
const MAX_ERROR_NAME_BYTES = 128
const MAX_ERROR_MESSAGE_BYTES = 4 * 1024
const MAX_ERROR_STACK_BYTES = 16 * 1024
const MAX_LOG_RECORD_BYTES = 64 * 1024
const RETAINED_UTC_DAYS = 5
const UTC_DAY_MILLISECONDS = 24 * 60 * 60 * 1_000
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

export const LOGGER_CHILD_ENV = {
  directory: "OPENCODE_SSH_LOG_DIRECTORY",
  startupID: "OPENCODE_SSH_LOG_STARTUP_ID",
} as const

export type LogLevel = "debug" | "info" | "warn" | "error"

export type JsonLogValue =
  | null
  | boolean
  | number
  | string
  | JsonLogValue[]
  | { [key: string]: JsonLogValue }

export interface StructuredLogEntry {
  level: LogLevel
  event: string
  fields?: Readonly<Record<string, unknown>>
  error?: unknown
}

export interface LogDirectoryOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

export interface DailyLogFilePathOptions extends LogDirectoryOptions {
  /** Absolute launcher-owned directory, passed explicitly to child processes. */
  logDirectory?: string
  now?: Date
}

export interface FileLoggerOptions extends LogDirectoryOptions {
  /** Absolute launcher-owned directory, passed explicitly to child processes. */
  logDirectory?: string
  now?: () => Date
  localIOTimeoutMs?: number
}

export interface FileLoggerDependencies {
  /** Narrow test seam for deterministic deadline coverage. */
  operation?: (entry: StructuredLogEntry) => Promise<boolean>
}

export interface FileLogger {
  /** Resolves false on any serialization, filesystem, or maintenance failure. */
  log(entry: StructuredLogEntry): Promise<boolean>
}

interface LogLocations {
  directory: string
  privateDirectories: readonly string[]
}

interface StoredLogRecord {
  timestamp: string
  level: LogLevel
  event: string
  pid: number
  fields?: Record<string, JsonLogValue>
  error?: Record<string, JsonLogValue>
}

function assertAbsoluteLocalPath(value: string, name: string): void {
  if (!path.isAbsolute(value) || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${name} must be an absolute local path`)
  }
}

function xdgHome(value: string | undefined, fallback: string): string {
  if (value && path.isAbsolute(value) && !CONTROL_CHARACTERS.test(value)) {
    return value
  }
  return fallback
}

/** Resolve the persistent application log directory without creating it. */
export function resolveDefaultLogDirectory(options: LogDirectoryOptions = {}): string {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? env.HOME ?? os.homedir()
  assertAbsoluteLocalPath(homeDir, "Home directory")
  const stateHome = xdgHome(env.XDG_STATE_HOME, path.join(homeDir, ".local", "state"))
  return path.join(stateHome, APPLICATION_NAME, LOG_DIRECTORY_NAME)
}

function resolveSelectedLogDirectory(
  options: LogDirectoryOptions & { logDirectory?: string }
): string {
  if (options.logDirectory === undefined) return resolveDefaultLogDirectory(options)
  assertAbsoluteLocalPath(options.logDirectory, "Log directory")
  return options.logDirectory
}

function utcDay(now: Date): string {
  const day = now.toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Log date is outside the supported range")
  return day
}

function dailyLogFileName(day: string): string {
  return `${APPLICATION_NAME}-${day}.jsonl`
}

/** Resolve today's daily log path without creating directories or files. */
export function resolveDailyLogFilePath(options: DailyLogFilePathOptions = {}): string {
  const directory = resolveSelectedLogDirectory(options)
  return path.join(directory, dailyLogFileName(utcDay(options.now ?? new Date())))
}

function resolveLogLocations(options: FileLoggerOptions): LogLocations {
  const directory = resolveSelectedLogDirectory(options)
  return {
    directory,
    privateDirectories:
      options.logDirectory === undefined ? [path.dirname(directory), directory] : [directory],
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stats = await lstat(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Log path is not a private directory: ${directory}`)
  }
  await chmod(directory, 0o700)
}

function emptyJsonObject(): Record<string, JsonLogValue> {
  return Object.create(null) as Record<string, JsonLogValue>
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value

  let lower = 0
  let upper = Math.min(value.length, maxBytes)
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2)
    if (Buffer.byteLength(value.slice(0, candidate), "utf8") <= maxBytes) {
      lower = candidate
    } else {
      upper = candidate - 1
    }
  }
  if (lower > 0 && /[\ud800-\udbff]/.test(value[lower - 1])) lower--
  return value.slice(0, lower)
}

function serializeError(error: Error): Record<string, JsonLogValue> {
  const serialized = emptyJsonObject()
  const name = typeof error.name === "string" && error.name ? error.name : "Error"
  serialized.name = truncateUtf8(name, MAX_ERROR_NAME_BYTES)
  serialized.message = truncateUtf8(
    typeof error.message === "string" ? error.message : "",
    MAX_ERROR_MESSAGE_BYTES
  )
  if (typeof error.stack === "string") {
    serialized.stack = truncateUtf8(error.stack, MAX_ERROR_STACK_BYTES)
  }
  return serialized
}

function serializeThrownValue(error: unknown): Record<string, JsonLogValue> {
  if (types.isNativeError(error)) return serializeError(error)

  const serialized = emptyJsonObject()
  serialized.name = "NonError"
  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    serialized.message = truncateUtf8(String(error), MAX_ERROR_MESSAGE_BYTES)
  } else {
    serialized.message = "Non-Error value thrown"
  }
  return serialized
}

function toJsonLogValue(
  value: unknown,
  ancestors: WeakSet<object>
): JsonLogValue | undefined {
  if (value === null) return null

  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      return Number.isFinite(value) ? value : null
    case "bigint":
      return value.toString()
    case "undefined":
    case "function":
    case "symbol":
      return undefined
    case "object":
      break
  }

  if (types.isNativeError(value)) return serializeError(value)
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (ancestors.has(value)) return "[Circular]"

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toJsonLogValue(item, ancestors) ?? null)
    }

    const serialized = emptyJsonObject()
    for (const key of Object.keys(value)) {
      const item = toJsonLogValue((value as Record<string, unknown>)[key], ancestors)
      if (item !== undefined) serialized[key] = item
    }
    return serialized
  } finally {
    ancestors.delete(value)
  }
}

function serializeFields(fields: Readonly<Record<string, unknown>>): Record<string, JsonLogValue> {
  const serialized = emptyJsonObject()
  const ancestors = new WeakSet<object>([fields])
  for (const key of Object.keys(fields)) {
    const value = toJsonLogValue(fields[key], ancestors)
    if (value !== undefined) serialized[key] = value
  }
  return serialized
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

function validateLogEntry(entry: StructuredLogEntry): void {
  if (!isLogLevel(entry.level)) throw new Error("Invalid log level")
  if (
    typeof entry.event !== "string" ||
    !EVENT_NAME_PATTERN.test(entry.event) ||
    Buffer.byteLength(entry.event, "utf8") > MAX_EVENT_NAME_BYTES
  ) {
    throw new Error("Invalid log event name")
  }
  if (
    entry.fields !== undefined &&
    (entry.fields === null || typeof entry.fields !== "object" || Array.isArray(entry.fields))
  ) {
    throw new Error("Log fields must be an object")
  }
}

function logDayFromFileName(fileName: string): string | undefined {
  const match = LOG_FILE_PATTERN.exec(fileName)
  if (!match) return undefined

  const day = match[1]
  const parsed = new Date(`${day}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    return undefined
  }
  return day
}

function createLogLine(entry: StructuredLogEntry, now: Date): {
  day: string
  line: Buffer
} {
  validateLogEntry(entry)
  const timestamp = now.toISOString()
  const day = utcDay(now)
  const record: StoredLogRecord = {
    timestamp,
    level: entry.level,
    event: entry.event,
    pid: process.pid,
  }
  if (entry.fields !== undefined) record.fields = serializeFields(entry.fields)
  if (entry.error !== undefined) record.error = serializeThrownValue(entry.error)
  const line = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(line, "utf8") > MAX_LOG_RECORD_BYTES) {
    throw new Error("Log record exceeds the size limit")
  }
  return {
    day,
    line: Buffer.from(line, "utf8"),
  }
}

async function appendLogLine(filePath: string, line: Buffer): Promise<void> {
  const flags =
    constants.O_APPEND |
    constants.O_CREAT |
    constants.O_WRONLY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK
  const handle = await open(filePath, flags, 0o600)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(`Log path is not a regular file: ${filePath}`)
    await handle.chmod(0o600)

    // One O_APPEND write keeps complete records from separate processes from overwriting each other.
    const { bytesWritten } = await handle.write(line)
    if (bytesWritten !== line.byteLength) {
      throw new Error(`Incomplete log write: ${bytesWritten} of ${line.byteLength} bytes`)
    }
  } finally {
    await handle.close()
  }
}

function errnoIs(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function retainedUtcDays(currentDay: string): Set<string> {
  const current = new Date(`${currentDay}T00:00:00.000Z`)
  return new Set(
    Array.from({ length: RETAINED_UTC_DAYS }, (_, offset) =>
      utcDay(new Date(current.getTime() - offset * UTC_DAY_MILLISECONDS))
    )
  )
}

async function pruneDailyLogs(directory: string, currentDay: string): Promise<void> {
  const retainedDays = retainedUtcDays(currentDay)
  const entries = await readdir(directory, { withFileTypes: true })
  const staleFiles = entries.flatMap((entry) => {
    if (!entry.isFile()) return []
    const day = logDayFromFileName(entry.name)
    return day !== undefined && !retainedDays.has(day) ? [entry.name] : []
  })

  for (const fileName of staleFiles) {
    try {
      await unlink(path.join(directory, fileName))
    } catch (error) {
      if (!errnoIs(error, "ENOENT")) throw error
    }
  }
}

function resolveLocalIOTimeout(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= MAX_LOCAL_IO_TIMEOUT_MS
    ? value
    : DEFAULT_LOCAL_IO_TIMEOUT_MS
}

/** Create an instance with no global state; launcher and plugin processes may each own one. */
export function createFileLogger(
  options: FileLoggerOptions = {},
  dependencies: FileLoggerDependencies = {}
): FileLogger {
  const now = options.now ?? (() => new Date())
  const localIOTimeoutMs = resolveLocalIOTimeout(options.localIOTimeoutMs)
  const prunedDays = new Set<string>()
  const pruneAttempts = new Map<string, Promise<boolean>>()
  let suppressed = false

  function pruneOnceForDay(directory: string, day: string): Promise<boolean> {
    if (prunedDays.has(day)) return Promise.resolve(true)
    const activeAttempt = pruneAttempts.get(day)
    if (activeAttempt) return activeAttempt

    const attempt = pruneDailyLogs(directory, day)
      .then(
        () => {
          prunedDays.add(day)
          return true
        },
        () => false
      )
      .finally(() => {
        pruneAttempts.delete(day)
      })
    pruneAttempts.set(day, attempt)
    return attempt
  }

  async function performLogOperation(entry: StructuredLogEntry): Promise<boolean> {
    const { day, line } = createLogLine(entry, now())
    const locations = resolveLogLocations(options)
    for (const directory of new Set(locations.privateDirectories)) {
      await ensurePrivateDirectory(directory)
    }
    await appendLogLine(path.join(locations.directory, dailyLogFileName(day)), line)

    // A fresh day prevents a pre-midnight append from pruning a next-day peer's file.
    return await pruneOnceForDay(locations.directory, utcDay(now()))
  }

  const operation = dependencies.operation ?? performLogOperation

  return {
    async log(entry): Promise<boolean> {
      if (suppressed) return false

      let timeout: NodeJS.Timeout | undefined
      try {
        const completion = Promise.resolve()
          .then(() => operation(entry))
          .then(
            (result) => ({ type: "complete" as const, result }),
            () => ({ type: "complete" as const, result: false })
          )
        const deadline = new Promise<{ type: "timeout" }>((resolve) => {
          timeout = setTimeout(() => {
            suppressed = true
            resolve({ type: "timeout" })
          }, localIOTimeoutMs)
          timeout.unref()
        })
        const result = await Promise.race([completion, deadline])
        return result.type === "complete" ? result.result : false
      } catch {
        return false
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    },
  }
}
