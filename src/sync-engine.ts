import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { RemoteConfig } from "./config.js"
import type { ManifestManager } from "./manifest.js"
import type { PathMapper } from "./path-mapper.js"
import { quoteShell } from "./shell-quote.js"
import type { SSHPool } from "./ssh-pool.js"
import { SftpFileNotFoundError } from "./ssh/sftp.js"

const FILE_TRANSFER_TIMEOUT_MS = 30_000
const REMOTE_COMMAND_TIMEOUT_MS = 10_000

interface FileBaseline {
  exists: boolean
  sha256: string
  mode?: string
}

interface ValidatedFile {
  remotePath: string
  baseline: FileBaseline
  mode?: string
}

interface UploadSnapshot {
  remotePath: string
  uploadPath: string
  baseline: FileBaseline
  sha256: string
  changed: boolean
}

export interface SyncTransaction {
  pull(remotePath: string, signal?: AbortSignal): Promise<boolean>
  push(remotePath: string, signal?: AbortSignal): Promise<void>
  pushMany(remotePaths: readonly string[], signal?: AbortSignal): Promise<void>
}

export class RemoteFileConflict extends Error {
  readonly code = "REMOTE_FILE_CONFLICT"
  readonly remotePath: string
  readonly expectedExists: boolean
  readonly actualExists: boolean

  constructor(remotePath: string, expectedExists: boolean, actualExists: boolean) {
    super(
      `Remote file changed since it was pulled: ${remotePath} ` +
        `(expected ${expectedExists ? "existing content" : "no file"}, found ${
          actualExists ? "different content" : "no file"
        })`
    )
    this.name = "RemoteFileConflict"
    this.remotePath = remotePath
    this.expectedExists = expectedExists
    this.actualExists = actualExists
  }
}

export class RemoteFileLockError extends Error {
  readonly code = "REMOTE_FILE_LOCKED"
  readonly remotePath: string
  readonly lockPath: string

  constructor(remotePath: string, lockPath: string, detail: string) {
    super(
      `Remote file is locked by another mutation: ${remotePath}${
        detail ? ` (${detail.trim()})` : ""
      }`
    )
    this.name = "RemoteFileLockError"
    this.remotePath = remotePath
    this.lockPath = lockPath
  }
}

export class SyncEngine {
  private mutex = Promise.resolve()
  private readonly baselines = new Map<string, FileBaseline>()

  constructor(
    _config: RemoteConfig,
    private pathMapper: PathMapper,
    private manifest: ManifestManager,
    private sshPool: SSHPool
  ) {}

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutex
    let release!: () => void
    this.mutex = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** Hold the local operation mutex while using the unlocked transaction facade. */
  async transaction<T>(
    operation: (transaction: SyncTransaction) => Promise<T>
  ): Promise<T> {
    return this.withLock(() =>
      operation({
        pull: (remotePath, signal) => this.pullUnlocked(remotePath, signal),
        push: (remotePath, signal) => this.pushManyUnlocked([remotePath], signal),
        pushMany: (remotePaths, signal) => this.pushManyUnlocked(remotePaths, signal),
      })
    )
  }

  /** Register and download one remote file, recording its conflict baseline. */
  async pull(remotePath: string, signal?: AbortSignal): Promise<boolean> {
    return this.transaction((transaction) => transaction.pull(remotePath, signal))
  }

  /** Conflict-check and atomically replace one remote file. */
  async push(remotePath: string, signal?: AbortSignal): Promise<void> {
    await this.transaction((transaction) => transaction.push(remotePath, signal))
  }

  /** Validate every baseline before uploading any file. */
  async pushMany(remotePaths: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.transaction((transaction) => transaction.pushMany(remotePaths, signal))
  }

  /** Register a new remote file and ensure its parent directory exists locally. */
  async register(remotePath: string): Promise<string> {
    return this.transaction(() => this.registerUnlocked(this.normalizeRemotePath(remotePath)))
  }

  private async pullUnlocked(remotePath: string, signal?: AbortSignal): Promise<boolean> {
    const normalized = this.normalizeRemotePath(remotePath)
    await this.registerUnlocked(normalized)
    this.baselines.delete(normalized)

    const localPath = this.pathMapper.toLocal(normalized)
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    const tempDirectory = await fs.mkdtemp(path.join(path.dirname(localPath), ".pull-"))
    const tempPath = path.join(tempDirectory, "content")

    try {
      try {
        await this.sshPool.download(normalized, tempPath, {
          signal,
          timeout: FILE_TRANSFER_TIMEOUT_MS,
        })
      } catch (error) {
        if (!(error instanceof SftpFileNotFoundError)) throw error
        await fs.writeFile(localPath, "")
        this.baselines.set(normalized, {
          exists: false,
          sha256: sha256(Buffer.alloc(0)),
        })
        return false
      }

      const content = await fs.readFile(tempPath)
      const mode = await this.readRemoteMode(normalized, signal)
      await fs.rename(tempPath, localPath)
      this.baselines.set(normalized, {
        exists: true,
        sha256: sha256(content),
        mode,
      })
      return true
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true })
    }
  }

  private async pushManyUnlocked(
    remotePaths: readonly string[],
    signal?: AbortSignal
  ): Promise<void> {
    const paths = Array.from(
      new Set(remotePaths.map((remotePath) => this.normalizeRemotePath(remotePath)))
    ).sort()
    if (paths.length === 0) return

    const baselines = paths.map((remotePath) => {
      const baseline = this.baselines.get(remotePath)
      if (!baseline) {
        throw new Error(`Cannot push ${remotePath} without first pulling a conflict baseline`)
      }
      return { remotePath, baseline }
    })

    const snapshotDirectories: string[] = []
    const snapshots: UploadSnapshot[] = []
    try {
      for (const item of baselines) {
        const localPath = this.pathMapper.toLocal(item.remotePath)
        const snapshotDirectory = await fs.mkdtemp(
          path.join(path.dirname(localPath), ".upload-")
        )
        snapshotDirectories.push(snapshotDirectory)
        const uploadPath = path.join(snapshotDirectory, "content")
        await fs.copyFile(localPath, uploadPath)
        const localSha256 = sha256(await fs.readFile(uploadPath))
        snapshots.push({
          ...item,
          uploadPath,
          sha256: localSha256,
          changed: !item.baseline.exists || localSha256 !== item.baseline.sha256,
        })
      }

      const remoteDirectories = Array.from(
        new Set(paths.map((remotePath) => path.posix.dirname(remotePath)))
      ).sort()
      for (const remoteDirectory of remoteDirectories) {
        await this.execChecked(
          `mkdir -p ${quoteShell(remoteDirectory)}`,
          `create remote directory ${remoteDirectory}`,
          signal
        )
      }

      await this.withRemoteLocks(paths, signal, async () => {
        const validated = new Map<string, ValidatedFile>()
        for (const item of baselines) {
          validated.set(
            item.remotePath,
            await this.validateBaseline(item.remotePath, item.baseline, signal)
          )
        }

        for (const snapshot of snapshots) {
          const current = validated.get(snapshot.remotePath)
          if (!current) throw new Error(`Missing validation for ${snapshot.remotePath}`)
          if (!snapshot.changed) {
            this.baselines.set(snapshot.remotePath, {
              ...snapshot.baseline,
              mode: current.mode,
            })
            continue
          }

          await this.uploadAtomically({ ...snapshot, mode: current.mode }, signal)
          this.baselines.set(snapshot.remotePath, {
            exists: true,
            sha256: snapshot.sha256,
            mode: current.mode,
          })
        }
      })
    } finally {
      await Promise.all(
        snapshotDirectories.map((directory) =>
          fs.rm(directory, { recursive: true, force: true })
        )
      )
    }
  }

  private async registerUnlocked(remotePath: string): Promise<string> {
    const rel = this.manifest.register(remotePath)
    const localPath = this.pathMapper.toLocal(remotePath)
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    await this.manifest.save()
    return rel
  }

  private async validateBaseline(
    remotePath: string,
    baseline: FileBaseline,
    signal?: AbortSignal
  ): Promise<ValidatedFile> {
    const localPath = this.pathMapper.toLocal(remotePath)
    const tempDirectory = await fs.mkdtemp(path.join(path.dirname(localPath), ".validate-"))
    const tempPath = path.join(tempDirectory, "content")

    try {
      let exists = true
      let currentSha256 = ""
      let mode: string | undefined
      try {
        await this.sshPool.download(remotePath, tempPath, {
          signal,
          timeout: FILE_TRANSFER_TIMEOUT_MS,
        })
        currentSha256 = sha256(await fs.readFile(tempPath))
        mode = await this.readRemoteMode(remotePath, signal)
      } catch (error) {
        if (!(error instanceof SftpFileNotFoundError)) throw error
        exists = false
        currentSha256 = sha256(Buffer.alloc(0))
      }

      if (exists !== baseline.exists || currentSha256 !== baseline.sha256) {
        throw new RemoteFileConflict(remotePath, baseline.exists, exists)
      }

      return { remotePath, baseline, mode: mode ?? baseline.mode }
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true })
    }
  }

  private async uploadAtomically(
    file: UploadSnapshot & { mode?: string },
    signal?: AbortSignal
  ): Promise<void> {
    const remoteDirectory = path.posix.dirname(file.remotePath)
    const remoteTemp = path.posix.join(
      remoteDirectory,
      `.${path.posix.basename(file.remotePath)}.opencode-${randomBytes(12).toString("hex")}.tmp`
    )
    let renamed = false

    try {
      await this.sshPool.upload(file.uploadPath, remoteTemp, {
        signal,
        timeout: FILE_TRANSFER_TIMEOUT_MS,
      })
      if (file.mode) {
        await this.execChecked(
          `chmod ${file.mode} ${quoteShell(remoteTemp)}`,
          `preserve mode for ${file.remotePath}`,
          signal
        )
      }
      await this.validateBaseline(file.remotePath, file.baseline, signal)
      await this.execChecked(
        `mv -f ${quoteShell(remoteTemp)} ${quoteShell(file.remotePath)}`,
        `replace remote file ${file.remotePath}`,
        signal
      )
      renamed = true
    } finally {
      if (!renamed) {
        await this.sshPool
          .exec(`rm -f ${quoteShell(remoteTemp)}`, {
            timeout: REMOTE_COMMAND_TIMEOUT_MS,
          })
          .catch(() => {})
      }
    }
  }

  private async withRemoteLocks<T>(
    remotePaths: readonly string[],
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const acquired: Array<{ remotePath: string; lockPath: string }> = []
    let completed = false

    try {
      for (const remotePath of remotePaths) {
        const lockPath = this.remoteLockPath(remotePath)
        const result = await this.sshPool.exec(`mkdir ${quoteShell(lockPath)}`, {
          timeout: REMOTE_COMMAND_TIMEOUT_MS,
          signal,
        })
        if (result.exitCode !== 0) {
          throw new RemoteFileLockError(
            remotePath,
            lockPath,
            result.stderr || result.stdout
          )
        }
        acquired.push({ remotePath, lockPath })
      }

      const result = await operation()
      completed = true
      return result
    } finally {
      let releaseError: unknown
      for (let index = acquired.length - 1; index >= 0; index--) {
        const lock = acquired[index]
        try {
          await this.execChecked(
            `rmdir ${quoteShell(lock.lockPath)}`,
            `release remote lock for ${lock.remotePath}`
          )
        } catch (error) {
          releaseError ??= error
        }
      }
      if (completed && releaseError !== undefined) throw releaseError
    }
  }

  private remoteLockPath(remotePath: string): string {
    const hash = createHash("sha256").update(remotePath, "utf8").digest("hex")
    return path.posix.join(path.posix.dirname(remotePath), `.opencode-lock-${hash}`)
  }

  private async readRemoteMode(
    remotePath: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const result = await this.sshPool.exec(
      `stat -c %a ${quoteShell(remotePath)} 2>/dev/null`,
      { timeout: REMOTE_COMMAND_TIMEOUT_MS, signal }
    )
    if (result.exitCode !== 0) return undefined
    const mode = result.stdout.trim()
    return /^[0-7]{3,4}$/.test(mode) ? mode : undefined
  }

  private async execChecked(
    command: string,
    action: string,
    signal?: AbortSignal
  ): Promise<void> {
    const result = await this.sshPool.exec(command, {
      timeout: REMOTE_COMMAND_TIMEOUT_MS,
      signal,
    })
    if (result.exitCode !== 0) {
      throw new Error(`Failed to ${action}: ${result.stderr || result.stdout}`)
    }
  }

  private normalizeRemotePath(remotePath: string): string {
    const normalized = path.posix.normalize(remotePath)
    this.pathMapper.toLocal(normalized)
    return normalized
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}
