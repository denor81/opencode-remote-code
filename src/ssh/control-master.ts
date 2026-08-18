import {
  spawnManaged,
  spawnProcess,
  type ManagedProcess,
  type ProcessResult,
} from "../process.js"

export interface OpenSshBinaries {
  ssh: string
  sftp: string
}

export const SYSTEM_OPENSSH_BINARIES: Readonly<OpenSshBinaries> = Object.freeze({
  ssh: "ssh",
  sftp: "sftp",
})

export interface ControlMasterOptions {
  sshBinary?: string
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  pollIntervalMs?: number
  checkTimeoutMs?: number
  closeTimeoutMs?: number
  killGraceMs?: number
}

interface ResolvedControlMasterOptions {
  sshBinary: string
  env: NodeJS.ProcessEnv | undefined
  startupTimeoutMs: number
  pollIntervalMs: number
  checkTimeoutMs: number
  closeTimeoutMs: number
  killGraceMs: number
}

interface MasterCompletion {
  kind: "master"
  result?: ProcessResult
  error?: unknown
}

type CheckCompletion =
  | { kind: "check"; result: ProcessResult }
  | { kind: "check-error"; error: unknown }

type PollCompletion = MasterCompletion | { kind: "delay" } | { kind: "abort" }

const DEFAULT_OPTIONS: Omit<ResolvedControlMasterOptions, "env"> = {
  sshBinary: SYSTEM_OPENSSH_BINARIES.ssh,
  startupTimeoutMs: 30_000,
  pollIntervalMs: 100,
  checkTimeoutMs: 1_000,
  closeTimeoutMs: 5_000,
  killGraceMs: 3_000,
}

export class ControlMasterError extends Error {
  readonly alias: string
  readonly socketPath: string

  constructor(message: string, alias: string, socketPath: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ControlMasterError"
    this.alias = alias
    this.socketPath = socketPath
  }
}

/** A launcher-owned foreground OpenSSH multiplexing master. */
export class ControlMaster {
  readonly alias: string
  readonly socketPath: string
  readonly sshBinary: string

  private readonly options: ResolvedControlMasterOptions
  private readonly master: ManagedProcess
  private readonly masterDone: Promise<MasterCompletion>
  private masterSettled = false
  private closePromise: Promise<void> | undefined

  private constructor(
    alias: string,
    socketPath: string,
    master: ManagedProcess,
    options: ResolvedControlMasterOptions
  ) {
    this.alias = alias
    this.socketPath = socketPath
    this.sshBinary = options.sshBinary
    this.master = master
    this.options = options
    this.masterDone = master.result.then(
      (result): MasterCompletion => {
        this.masterSettled = true
        return { kind: "master", result }
      },
      (error: unknown): MasterCompletion => {
        this.masterSettled = true
        return { kind: "master", error }
      }
    )
  }

  static async start(
    alias: string,
    socketPath: string,
    signal: AbortSignal,
    options: ControlMasterOptions = {}
  ): Promise<ControlMaster> {
    const resolved = resolveOptions(options)
    if (signal.aborted) throw abortedError(alias, socketPath, signal.reason)

    let process: ManagedProcess
    try {
      process = spawnManaged(resolved.sshBinary, masterArgs(alias, socketPath), {
        env: resolved.env,
        signal,
        killGraceMs: resolved.killGraceMs,
        stdio: {
          stdin: "inherit",
          stdout: "ignore",
          stderr: "inherit",
        },
      })
    } catch (cause) {
      if (signal.aborted) throw abortedError(alias, socketPath, signal.reason)
      throw new ControlMasterError(
        `Failed to start SSH ControlMaster for ${JSON.stringify(alias)}`,
        alias,
        socketPath,
        { cause }
      )
    }

    const controlMaster = new ControlMaster(alias, socketPath, process, resolved)
    try {
      await controlMaster.waitUntilReady(signal)
      return controlMaster
    } catch (cause) {
      await process.terminate().catch(() => undefined)
      if (signal.aborted) throw abortedError(alias, socketPath, signal.reason)
      if (cause instanceof ControlMasterError) throw cause
      throw new ControlMasterError(
        `Failed to start SSH ControlMaster for ${JSON.stringify(alias)}`,
        alias,
        socketPath,
        { cause }
      )
    }
  }

  get isClosed(): boolean {
    return this.closePromise !== undefined
  }

  /** Resolve when the foreground master exits, or reject on a spawn failure. */
  async wait(): Promise<ProcessResult> {
    const completion = await this.masterDone
    if (completion.error !== undefined) throw completion.error
    if (!completion.result) {
      throw new ControlMasterError(
        `SSH ControlMaster for ${JSON.stringify(this.alias)} exited without a result`,
        this.alias,
        this.socketPath
      )
    }
    return completion.result
  }

  /** Ask OpenSSH to close the master once. Concurrent and repeated calls share one cleanup. */
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeOnce()
    return this.closePromise
  }

  private async waitUntilReady(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs

    while (true) {
      if (signal.aborted) throw abortedError(this.alias, this.socketPath, signal.reason)
      if (this.masterSettled) throw await this.masterExitError()

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new ControlMasterError(
          `Timed out waiting for SSH ControlMaster for ${JSON.stringify(this.alias)}`,
          this.alias,
          this.socketPath
        )
      }

      const check = spawnManaged(this.sshBinary, controlArgs(this.socketPath, "check", this.alias), {
        env: this.options.env,
        signal,
        timeoutMs: Math.max(1, Math.min(this.options.checkTimeoutMs, remaining)),
        killGraceMs: this.options.killGraceMs,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      })
      const checked: Promise<CheckCompletion> = check.result.then(
        (result): CheckCompletion => ({ kind: "check", result }),
        (error: unknown): CheckCompletion => ({ kind: "check-error", error })
      )
      const completion = await Promise.race<CheckCompletion | MasterCompletion>([
        checked,
        this.masterDone,
      ])

      if (completion.kind === "master") {
        await check.terminate().catch(() => undefined)
        if (signal.aborted) throw abortedError(this.alias, this.socketPath, signal.reason)
        throw this.masterCompletionError(completion)
      }
      if (signal.aborted) throw abortedError(this.alias, this.socketPath, signal.reason)
      if (completion.kind === "check-error") {
        throw new ControlMasterError(
          `Failed to check SSH ControlMaster for ${JSON.stringify(this.alias)}`,
          this.alias,
          this.socketPath,
          { cause: completion.error }
        )
      }
      if (isSuccessful(completion.result)) return
      if (this.masterSettled) throw await this.masterExitError()

      const delayMs = Math.min(this.options.pollIntervalMs, Math.max(0, deadline - Date.now()))
      const pollCompletion = await this.waitForNextPoll(delayMs, signal)
      if (pollCompletion.kind === "abort") {
        throw abortedError(this.alias, this.socketPath, signal.reason)
      }
      if (pollCompletion.kind === "master") {
        throw this.masterCompletionError(pollCompletion)
      }
    }
  }

  private async waitForNextPoll(
    delayMs: number,
    signal: AbortSignal
  ): Promise<PollCompletion> {
    let timer: NodeJS.Timeout | undefined
    let abortHandler: (() => void) | undefined

    const delay = new Promise<PollCompletion>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "delay" }), delayMs)
    })
    const aborted = new Promise<PollCompletion>((resolve) => {
      abortHandler = () => resolve({ kind: "abort" })
      signal.addEventListener("abort", abortHandler, { once: true })
      if (signal.aborted) resolve({ kind: "abort" })
    })

    const completion = await Promise.race<PollCompletion>([delay, aborted, this.masterDone])
    if (timer) clearTimeout(timer)
    if (abortHandler) signal.removeEventListener("abort", abortHandler)
    return completion
  }

  private async masterExitError(): Promise<ControlMasterError> {
    return this.masterCompletionError(await this.masterDone)
  }

  private masterCompletionError(completion: MasterCompletion): ControlMasterError {
    if (completion.error !== undefined) {
      return new ControlMasterError(
        `SSH ControlMaster for ${JSON.stringify(this.alias)} failed before becoming ready`,
        this.alias,
        this.socketPath,
        { cause: completion.error }
      )
    }

    return new ControlMasterError(
      `SSH ControlMaster for ${JSON.stringify(this.alias)} exited before becoming ready (${describeExit(
        completion.result
      )})`,
      this.alias,
      this.socketPath
    )
  }

  private async closeOnce(): Promise<void> {
    await spawnProcess(this.sshBinary, controlArgs(this.socketPath, "exit", this.alias), {
      env: this.options.env,
      timeoutMs: this.options.closeTimeoutMs,
      killGraceMs: this.options.killGraceMs,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    }).catch(() => undefined)

    if (this.masterSettled) return
    const exited = await this.waitForMasterExit(this.options.closeTimeoutMs)
    if (!exited) await this.master.terminate().catch(() => undefined)
  }

  private async waitForMasterExit(timeoutMs: number): Promise<boolean> {
    if (this.masterSettled) return true
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const exited = this.masterDone.then(() => true as const)
    const result = await Promise.race([exited, timedOut])
    if (timer) clearTimeout(timer)
    return result
  }
}

function resolveOptions(options: ControlMasterOptions): ResolvedControlMasterOptions {
  return {
    sshBinary: options.sshBinary ?? DEFAULT_OPTIONS.sshBinary,
    env: options.env,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_OPTIONS.startupTimeoutMs,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_OPTIONS.pollIntervalMs,
    checkTimeoutMs: options.checkTimeoutMs ?? DEFAULT_OPTIONS.checkTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_OPTIONS.closeTimeoutMs,
    killGraceMs: options.killGraceMs ?? DEFAULT_OPTIONS.killGraceMs,
  }
}

function masterArgs(alias: string, socketPath: string): string[] {
  return [
    "-MN",
    "-o",
    "ControlMaster=yes",
    "-o",
    "ControlPersist=no",
    "-o",
    `ControlPath=${socketPath}`,
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "--",
    alias,
  ]
}

function controlArgs(socketPath: string, operation: "check" | "exit", alias: string): string[] {
  return ["-S", socketPath, "-O", operation, "--", alias]
}

function isSuccessful(result: ProcessResult): boolean {
  return result.exitCode === 0 && result.signal === null && result.termination === null
}

function describeExit(result: ProcessResult | undefined): string {
  if (!result) return "unknown status"
  if (result.signal) return `signal ${result.signal}`
  return `code ${result.exitCode ?? "unknown"}`
}

function abortedError(alias: string, socketPath: string, cause?: unknown): ControlMasterError {
  const error = new ControlMasterError(
    `SSH ControlMaster startup was aborted for ${JSON.stringify(alias)}`,
    alias,
    socketPath,
    { cause }
  )
  error.name = "AbortError"
  return error
}
