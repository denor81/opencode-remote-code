import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { RemoteConfig } from "./config.js"
import type { ManifestManager } from "./manifest.js"
import type { PathMapper } from "./path-mapper.js"
import type { ResolvedMutationPath } from "./remote-path-resolver.js"
import { quoteShell } from "./shell-quote.js"
import type { SSHPool } from "./ssh-pool.js"
import { SftpFileNotFoundError } from "./ssh/sftp.js"

const FILE_TRANSFER_TIMEOUT_MS = 30_000
const REMOTE_COMMAND_TIMEOUT_MS = 10_000
const LOCK_TOKEN_MISMATCH_EXIT = 73
const TEMP_NOT_CREATED_EXIT = 74
const LOCK_ALREADY_EXISTS_EXIT = 75
const LOCK_OWNER_WRITE_CLEANED_EXIT = 76
const LOCK_OWNER_WRITE_CLEANUP_FAILED_EXIT = 77
const LOCK_CREATE_FAILED_EXIT = 78
const TEMP_CREATED_MODE_FAILED_EXIT = 79

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

interface OwnedRemoteLock {
  remotePath: string
  lockPath: string
  ownerPath: string
  token: string
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

  constructor(
    remotePath: string,
    lockPath: string,
    detail: string,
    options?: ErrorOptions
  ) {
    super(
      `Remote file is locked by another mutation: ${remotePath}${
        detail ? ` (${detail.trim()})` : ""
      }`,
      options
    )
    this.name = "RemoteFileLockError"
    this.remotePath = remotePath
    this.lockPath = lockPath
  }
}

export class RemoteArtifactCleanupError extends Error {
  readonly code = "REMOTE_ARTIFACT_CLEANUP_FAILED"

  constructor(
    message: string,
    readonly artifactPaths: readonly string[],
    options?: ErrorOptions
  ) {
    super(`${message}; possible remote artifact paths: ${artifactPaths.join(", ")}`, options)
    this.name = "RemoteArtifactCleanupError"
  }
}

export class SyncPartialCommitError extends Error {
  readonly code = "SYNC_PARTIAL_COMMIT"

  constructor(
    readonly committedPaths: readonly string[],
    readonly failedPaths: readonly string[],
    readonly uncertainPaths: readonly string[],
    readonly unattemptedPaths: readonly string[],
    options: ErrorOptions
  ) {
    super(
      `Remote multi-file mutation stopped after a partial result; committed: ${
        committedPaths.join(", ") || "none"
      }; failed: ${failedPaths.join(", ") || "none"}; uncertain: ${
        uncertainPaths.join(", ") || "none"
      }; unattempted: ${unattemptedPaths.join(", ") || "none"}. ` +
        "No automatic rollback or retry was attempted.",
      options
    )
    this.name = "SyncPartialCommitError"
  }
}

class RemoteCommitUncertainError extends Error {
  readonly code = "REMOTE_COMMIT_UNCERTAIN"

  constructor(readonly remotePath: string, cause: unknown) {
    super(
      `Remote replacement result is uncertain for ${remotePath}: ${errorDetail(cause)}`,
      { cause }
    )
    this.name = "RemoteCommitUncertainError"
  }
}

export class SyncEngine {
  private mutex: Promise<void> = Promise.resolve()
  private readonly baselines = new Map<string, FileBaseline>()

  constructor(
    _config: RemoteConfig,
    private pathMapper: PathMapper,
    private manifest: ManifestManager,
    private sshPool: SSHPool
  ) {}

  private withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))

    const previous = this.mutex
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.mutex = previous.then(() => gate)

    return new Promise<T>((resolve, reject) => {
      let canceled = false
      const onAbort = () => {
        canceled = true
        reject(abortReason(signal as AbortSignal))
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      void previous.then(async () => {
        if (canceled || signal?.aborted) {
          signal?.removeEventListener("abort", onAbort)
          if (!canceled && signal) reject(abortReason(signal))
          release()
          return
        }

        signal?.removeEventListener("abort", onAbort)
        try {
          resolve(await fn())
        } catch (error) {
          reject(error)
        } finally {
          release()
        }
      })
    })
  }

  /** Hold the local operation mutex while using the unlocked transaction facade. */
  async transaction<T>(
    operation: (transaction: SyncTransaction) => Promise<T>,
    signal?: AbortSignal,
    mutationPaths: readonly ResolvedMutationPath[] = []
  ): Promise<T> {
    return this.withLock(async () => {
      await this.revalidateMutationPaths(mutationPaths, signal)
      return operation({
        pull: (remotePath, operationSignal) =>
          this.pullUnlocked(remotePath, operationSignal),
        push: (remotePath, operationSignal) =>
          this.pushManyUnlocked([remotePath], mutationPaths, operationSignal),
        pushMany: (remotePaths, operationSignal) =>
          this.pushManyUnlocked(remotePaths, mutationPaths, operationSignal),
      })
    }, signal)
  }

  /** Register and download one remote file, recording its conflict baseline. */
  async pull(remotePath: string, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(
      (transaction) => transaction.pull(remotePath, signal),
      signal
    )
  }

  /** Conflict-check and atomically replace one remote file. */
  async push(remotePath: string, signal?: AbortSignal): Promise<void> {
    await this.transaction(
      (transaction) => transaction.push(remotePath, signal),
      signal
    )
  }

  /** Validate every baseline before uploading any file. */
  async pushMany(
    remotePaths: readonly string[],
    signal?: AbortSignal
  ): Promise<void> {
    await this.transaction(
      (transaction) => transaction.pushMany(remotePaths, signal),
      signal
    )
  }

  /** Register a new remote file and ensure its parent directory exists locally. */
  async register(remotePath: string): Promise<string> {
    return this.transaction(() =>
      this.registerUnlocked(this.normalizeRemotePath(remotePath))
    )
  }

  private async pullUnlocked(
    remotePath: string,
    signal?: AbortSignal
  ): Promise<boolean> {
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
    mutationPaths: readonly ResolvedMutationPath[],
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
    const createdRemoteDirectories: string[] = []
    const committedPaths: string[] = []

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

      try {
        await this.revalidateMutationPathsFor(paths, mutationPaths, signal)

        // Detect stale content before any avoidable remote directory creation.
        for (const item of baselines) {
          await this.validateBaseline(item.remotePath, item.baseline, signal)
        }

        await this.createRemoteParents(paths, createdRemoteDirectories, signal)
        await this.revalidateMutationPathsFor(paths, mutationPaths, signal)

        await this.withRemoteLocks(paths, signal, async () => {
          await this.revalidateMutationPathsFor(paths, mutationPaths, signal)
          const validated = new Map<string, ValidatedFile>()
          for (const item of baselines) {
            validated.set(
              item.remotePath,
              await this.validateBaseline(item.remotePath, item.baseline, signal)
            )
          }

          for (let index = 0; index < snapshots.length; index++) {
            const snapshot = snapshots[index]
            const current = validated.get(snapshot.remotePath)
            if (!current) throw new Error(`Missing validation for ${snapshot.remotePath}`)
            if (!snapshot.changed) {
              this.baselines.set(snapshot.remotePath, {
                ...snapshot.baseline,
                mode: current.mode,
              })
              continue
            }

            try {
              await this.revalidateMutationPathsFor(
                [snapshot.remotePath],
                mutationPaths,
                signal
              )
              const finalMode = await this.uploadAtomically(
                snapshot,
                mutationPaths.filter(
                  (mutationPath) => mutationPath.remotePath === snapshot.remotePath
                ),
                signal
              )
              committedPaths.push(snapshot.remotePath)
              this.baselines.set(snapshot.remotePath, {
                exists: true,
                sha256: snapshot.sha256,
                mode: finalMode,
              })
            } catch (error) {
              if (paths.length > 1) {
                const uncertain = containsUncertainCommit(error)
                throw new SyncPartialCommitError(
                  [...committedPaths],
                  uncertain ? [] : [snapshot.remotePath],
                  uncertain ? [snapshot.remotePath] : [],
                  snapshots
                    .slice(index + 1)
                    .filter((item) => item.changed)
                    .map((item) => item.remotePath),
                  { cause: error }
                )
              }
              throw error
            }
          }
        })
      } catch (error) {
        const cleanupErrors = await this.cleanupCreatedRemoteDirectories(
          createdRemoteDirectories,
          committedPaths
        )
        if (cleanupErrors.length > 0) {
          throw combineFailure(
            error,
            cleanupErrors,
            "Remote mutation failed and parent-directory cleanup was incomplete"
          )
        }
        throw error
      }
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

      return { remotePath, baseline, mode }
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true })
    }
  }

  private async uploadAtomically(
    file: UploadSnapshot,
    mutationPaths: readonly ResolvedMutationPath[],
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const remoteDirectory = path.posix.dirname(file.remotePath)
    const suffix = randomBytes(12).toString("hex")
    if (!/^[a-f0-9]{24}$/.test(suffix)) {
      throw new Error("Generated an invalid remote temporary suffix")
    }
    const remoteTemp = path.posix.join(
      remoteDirectory,
      `.${path.posix.basename(file.remotePath)}.opencode-${suffix}.tmp`
    )
    let cleanupRequired = false
    let renamed = false
    let finalMode: string | undefined
    let failure: unknown
    let failed = false

    try {
      let creationResult
      try {
        creationResult = await this.sshPool.exec(
          `if (umask 077; set -C; : > ${quoteShell(remoteTemp)}); then ` +
            `if chmod 600 -- ${quoteShell(remoteTemp)}; then exit 0; ` +
            `else exit ${TEMP_CREATED_MODE_FAILED_EXIT}; fi; ` +
            `else exit ${TEMP_NOT_CREATED_EXIT}; fi`,
          { timeout: REMOTE_COMMAND_TIMEOUT_MS, signal }
        )
      } catch (cause) {
        throw combineFailure(
          cause,
          [
            new RemoteArtifactCleanupError(
              "Remote sibling creation result is uncertain; no unowned path was deleted",
              [remoteTemp]
            ),
          ],
          "Remote sibling creation transport failed with an uncertain artifact result"
        )
      }
      cleanupRequired =
        creationResult.exitCode === 0 ||
        creationResult.exitCode === TEMP_CREATED_MODE_FAILED_EXIT
      if (creationResult.exitCode !== 0) {
        const creationError = new Error(
          `Failed to create private remote sibling for ${file.remotePath}: ${
            creationResult.stderr || creationResult.stdout
          }`
        )
        if (
          creationResult.exitCode !== TEMP_NOT_CREATED_EXIT &&
          creationResult.exitCode !== TEMP_CREATED_MODE_FAILED_EXIT
        ) {
          throw combineFailure(
            creationError,
            [
              new RemoteArtifactCleanupError(
                "Remote sibling creation returned an unknown ownership result; no path was deleted",
                [remoteTemp]
              ),
            ],
            "Remote sibling creation returned an unknown ownership result"
          )
        }
        throw creationError
      }
      await this.sshPool.upload(file.uploadPath, remoteTemp, {
        signal,
        timeout: FILE_TRANSFER_TIMEOUT_MS,
      })

      await this.revalidateMutationPaths(mutationPaths, signal)
      const finalValidation = await this.validateBaseline(
        file.remotePath,
        file.baseline,
        signal
      )
      finalMode = finalValidation.mode ?? (file.baseline.exists ? undefined : "600")
      if (file.baseline.exists && finalValidation.mode === undefined) {
        throw new Error(
          `Failed to read the final numeric mode before replacing ${file.remotePath}`
        )
      }
      if (finalValidation.mode) {
        await this.execChecked(
          `chmod ${finalValidation.mode} -- ${quoteShell(remoteTemp)}`,
          `preserve final numeric mode for ${file.remotePath}`,
          signal
        )
      }

      let result
      try {
        result = await this.sshPool.exec(
          `mv -fT -- ${quoteShell(remoteTemp)} ${quoteShell(file.remotePath)}`,
          { timeout: REMOTE_COMMAND_TIMEOUT_MS, signal }
        )
      } catch (cause) {
        throw new RemoteCommitUncertainError(file.remotePath, cause)
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to replace remote file ${file.remotePath}: ${
            result.stderr || result.stdout
          }`
        )
      }
      renamed = true
    } catch (error) {
      failed = true
      failure = error
    }

    const cleanupErrors: RemoteArtifactCleanupError[] = []
    if (cleanupRequired && !renamed) {
      try {
        const result = await this.sshPool.exec(`rm -f -- ${quoteShell(remoteTemp)}`, {
          timeout: REMOTE_COMMAND_TIMEOUT_MS,
        })
        if (result.exitCode !== 0) {
          cleanupErrors.push(
            new RemoteArtifactCleanupError(
              `Failed to remove remote sibling after commit failure: ${
                result.stderr || result.stdout
              }`,
              [remoteTemp]
            )
          )
        }
      } catch (cause) {
        cleanupErrors.push(
          new RemoteArtifactCleanupError(
            "Failed to determine whether the remote sibling was removed",
            [remoteTemp],
            { cause }
          )
        )
      }
    }

    if (failed) {
      if (cleanupErrors.length > 0) {
        throw combineFailure(
          failure,
          cleanupErrors,
          "Remote replacement failed and sibling cleanup was incomplete"
        )
      }
      throw failure
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
    return finalMode
  }

  private async withRemoteLocks<T>(
    remotePaths: readonly string[],
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const acquired: OwnedRemoteLock[] = []
    let value!: T
    let failure: unknown
    let failed = false

    try {
      for (const remotePath of remotePaths) {
        acquired.push(await this.acquireRemoteLock(remotePath, signal))
      }
      value = await operation()
    } catch (error) {
      failed = true
      failure = error
    }

    const releaseErrors: RemoteArtifactCleanupError[] = []
    for (let index = acquired.length - 1; index >= 0; index--) {
      const releaseError = await this.releaseRemoteLock(acquired[index])
      if (releaseError) releaseErrors.push(releaseError)
    }

    if (failed) {
      if (releaseErrors.length > 0) {
        throw combineFailure(
          failure,
          releaseErrors,
          "Remote mutation failed and owned-lock release was incomplete"
        )
      }
      throw failure
    }
    if (releaseErrors.length === 1) throw releaseErrors[0]
    if (releaseErrors.length > 1) {
      throw new AggregateError(
        releaseErrors,
        "Remote mutation committed but multiple owned locks may remain"
      )
    }
    return value
  }

  private async acquireRemoteLock(
    remotePath: string,
    signal?: AbortSignal
  ): Promise<OwnedRemoteLock> {
    const lockPath = this.remoteLockPath(remotePath)
    const ownerPath = path.posix.join(lockPath, "owner")
    const token = randomBytes(32).toString("hex")
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new Error("Generated an invalid remote lock owner token")
    }
    const lock = { remotePath, lockPath, ownerPath, token }
    const command =
      `if mkdir -- ${quoteShell(lockPath)} 2>/dev/null; then ` +
      `if (umask 077; set -C; printf %s ${quoteShell(token)} > ${quoteShell(
        ownerPath
      )}); then exit 0; fi; ` +
      `if rmdir -- ${quoteShell(lockPath)} 2>/dev/null; then ` +
      `exit ${LOCK_OWNER_WRITE_CLEANED_EXIT}; else ` +
      `exit ${LOCK_OWNER_WRITE_CLEANUP_FAILED_EXIT}; fi; ` +
      `elif [ -e ${quoteShell(lockPath)} ]; then ` +
      `exit ${LOCK_ALREADY_EXISTS_EXIT}; else exit ${LOCK_CREATE_FAILED_EXIT}; fi`

    let result
    try {
      result = await this.sshPool.exec(command, {
        timeout: REMOTE_COMMAND_TIMEOUT_MS,
        signal,
      })
    } catch (cause) {
      const primary = new RemoteFileLockError(
        remotePath,
        lockPath,
        `lock acquisition was uncertain: ${errorDetail(
          cause
        )}; the lock path may be an artifact`,
        { cause }
      )
      const cleanupError = await this.cleanupPossiblyOwnedLock(lock)
      if (cleanupError) {
        throw combineFailure(
          primary,
          [cleanupError],
          "Remote lock acquisition was uncertain and conditional cleanup failed"
        )
      }
      throw primary
    }

    if (result.exitCode !== 0) {
      const primary = new RemoteFileLockError(
        remotePath,
        lockPath,
        result.stderr || result.stdout || lockAcquisitionResult(result.exitCode)
      )
      if (result.exitCode === LOCK_OWNER_WRITE_CLEANUP_FAILED_EXIT) {
        throw combineFailure(
          primary,
          [
            new RemoteArtifactCleanupError(
              "Remote lock owner write failed and its shell self-clean did not remove the lock",
              [lockPath]
            ),
          ],
          "Remote lock owner publication and self-clean both failed"
        )
      }
      if (
        result.exitCode !== LOCK_ALREADY_EXISTS_EXIT &&
        result.exitCode !== LOCK_OWNER_WRITE_CLEANED_EXIT &&
        result.exitCode !== LOCK_CREATE_FAILED_EXIT
      ) {
        throw combineFailure(
          primary,
          [
            new RemoteArtifactCleanupError(
              "Remote lock acquisition returned an unknown result; no unverified lock was deleted",
              [lockPath]
            ),
          ],
          "Remote lock acquisition returned an unknown ownership result"
        )
      }
      throw primary
    }

    return lock
  }

  private async cleanupPossiblyOwnedLock(
    lock: OwnedRemoteLock
  ): Promise<RemoteArtifactCleanupError | undefined> {
    try {
      const result = await this.sshPool.exec(this.ownedLockRemovalCommand(lock), {
        timeout: REMOTE_COMMAND_TIMEOUT_MS,
      })
      if (result.exitCode === 0) return undefined
      if (result.exitCode === LOCK_TOKEN_MISMATCH_EXIT) {
        return new RemoteArtifactCleanupError(
          "Uncertain remote lock acquisition had no matching owner token; no lock was deleted",
          [lock.lockPath]
        )
      }
      return new RemoteArtifactCleanupError(
        `Conditional cleanup of an uncertain remote lock failed: ${
          result.stderr || result.stdout
        }`,
        [lock.lockPath]
      )
    } catch (cause) {
      return new RemoteArtifactCleanupError(
        "Conditional cleanup of an uncertain remote lock could not be confirmed",
        [lock.lockPath],
        { cause }
      )
    }
  }

  private async releaseRemoteLock(
    lock: OwnedRemoteLock
  ): Promise<RemoteArtifactCleanupError | undefined> {
    try {
      const result = await this.sshPool.exec(this.ownedLockRemovalCommand(lock), {
        timeout: REMOTE_COMMAND_TIMEOUT_MS,
      })
      if (result.exitCode === 0) return undefined
      return new RemoteArtifactCleanupError(
        `Owned remote lock was not released because its owner token did not match or cleanup failed: ${
          result.stderr || result.stdout
        }`,
        [lock.lockPath]
      )
    } catch (cause) {
      return new RemoteArtifactCleanupError(
        "Owned remote lock release could not be confirmed",
        [lock.lockPath],
        { cause }
      )
    }
  }

  private ownedLockRemovalCommand(lock: OwnedRemoteLock): string {
    return (
      `if [ "$(cat -- ${quoteShell(lock.ownerPath)} 2>/dev/null)" = ${quoteShell(
        lock.token
      )} ]; then ` +
      `rm -f -- ${quoteShell(lock.ownerPath)} && rmdir -- ${quoteShell(
        lock.lockPath
      )}; else exit ${LOCK_TOKEN_MISMATCH_EXIT}; fi`
    )
  }

  private remoteLockPath(remotePath: string): string {
    const hash = createHash("sha256").update(remotePath, "utf8").digest("hex")
    return path.posix.join(path.posix.dirname(remotePath), `.opencode-lock-${hash}`)
  }

  private async createRemoteParents(
    remotePaths: readonly string[],
    created: string[],
    signal?: AbortSignal
  ): Promise<void> {
    const directories = Array.from(
      new Set(
        remotePaths.flatMap((remotePath) =>
          remoteDirectoryAncestors(path.posix.dirname(remotePath))
        )
      )
    ).sort((left, right) => {
      const depth = remotePathDepth(left) - remotePathDepth(right)
      return depth || left.localeCompare(right)
    })

    for (const directory of directories) {
      const quoted = quoteShell(directory)
      let result
      try {
        result = await this.sshPool.exec(
          `if mkdir -- ${quoted} 2>/dev/null; then printf CREATED; ` +
            `elif [ -d ${quoted} ]; then printf EXISTS; else exit 1; fi`,
          { timeout: REMOTE_COMMAND_TIMEOUT_MS, signal }
        )
      } catch (cause) {
        throw new RemoteArtifactCleanupError(
          "Remote parent creation result is uncertain",
          [directory],
          { cause }
        )
      }
      if (result.exitCode !== 0 || result.stdoutTruncated) {
        throw new Error(
          `Failed to create remote directory ${directory}; it may require manual inspection: ${
            result.stderr || result.stdout
          }`
        )
      }
      if (result.stdout === "CREATED") {
        created.push(directory)
      } else if (result.stdout !== "EXISTS") {
        throw new Error(
          `Remote directory creation returned an invalid result for ${directory}`
        )
      }
    }
  }

  private async cleanupCreatedRemoteDirectories(
    directories: readonly string[],
    committedPaths: readonly string[]
  ): Promise<RemoteArtifactCleanupError[]> {
    const errors: RemoteArtifactCleanupError[] = []
    for (let index = directories.length - 1; index >= 0; index--) {
      const directory = directories[index]
      if (
        committedPaths.some(
          (remotePath) =>
            remotePath === directory || remotePath.startsWith(`${directory}/`)
        )
      ) {
        continue
      }

      try {
        const result = await this.sshPool.exec(`rmdir -- ${quoteShell(directory)}`, {
          timeout: REMOTE_COMMAND_TIMEOUT_MS,
        })
        if (result.exitCode !== 0) {
          errors.push(
            new RemoteArtifactCleanupError(
              `Failed to remove an owned empty remote parent: ${
                result.stderr || result.stdout
              }`,
              [directory]
            )
          )
        }
      } catch (cause) {
        errors.push(
          new RemoteArtifactCleanupError(
            "Owned remote parent cleanup could not be confirmed",
            [directory],
            { cause }
          )
        )
      }
    }
    return errors
  }

  private async revalidateMutationPathsFor(
    remotePaths: readonly string[],
    mutationPaths: readonly ResolvedMutationPath[],
    signal?: AbortSignal
  ): Promise<void> {
    const selected = new Set(remotePaths)
    await this.revalidateMutationPaths(
      mutationPaths.filter((mutationPath) => selected.has(mutationPath.remotePath)),
      signal
    )
  }

  private async revalidateMutationPaths(
    mutationPaths: readonly ResolvedMutationPath[],
    signal?: AbortSignal
  ): Promise<void> {
    if (mutationPaths.length > 0 && !signal) {
      throw new Error("Mutation path revalidation requires an AbortSignal")
    }
    for (const mutationPath of mutationPaths) {
      await mutationPath.revalidate(signal as AbortSignal)
    }
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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("Operation aborted"), { name: "AbortError" })
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lockAcquisitionResult(exitCode: number): string {
  switch (exitCode) {
    case LOCK_ALREADY_EXISTS_EXIT:
      return "the deterministic lock path already exists"
    case LOCK_OWNER_WRITE_CLEANED_EXIT:
      return "owner token publication failed and the new empty lock was removed"
    case LOCK_OWNER_WRITE_CLEANUP_FAILED_EXIT:
      return "owner token publication failed and the new lock could not be removed"
    case LOCK_CREATE_FAILED_EXIT:
      return "the lock path could not be created and was not observed to exist"
    default:
      return `unexpected lock acquisition exit code ${exitCode}`
  }
}

function combineFailure(
  primary: unknown,
  cleanupErrors: readonly Error[],
  message: string
): AggregateError {
  return new AggregateError([primary, ...cleanupErrors], message, { cause: primary })
}

function containsUncertainCommit(error: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return false
  seen.add(error)
  if (error instanceof RemoteCommitUncertainError) return true
  if (error instanceof AggregateError) {
    return error.errors.some((nested) => containsUncertainCommit(nested, seen))
  }
  return error instanceof Error
    ? containsUncertainCommit(error.cause, seen)
    : false
}

function remoteDirectoryAncestors(directory: string): string[] {
  if (directory === "/") return []
  const components = directory.split("/").filter(Boolean)
  const ancestors: string[] = []
  let current = ""
  for (const component of components) {
    current = `${current}/${component}`
    ancestors.push(current)
  }
  return ancestors
}

function remotePathDepth(remotePath: string): number {
  return remotePath.split("/").filter(Boolean).length
}
