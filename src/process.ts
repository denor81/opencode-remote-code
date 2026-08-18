import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
export const DEFAULT_KILL_GRACE_MS = 3_000

export type ProcessOutputMode = "capture" | "inherit" | "ignore"
export type ProcessInputMode = "pipe" | "inherit" | "ignore"
export type ProcessTermination = "abort" | "requested" | "timeout" | null

export interface ProcessStdioOptions {
  stdin?: ProcessInputMode
  stdout?: ProcessOutputMode
  stderr?: ProcessOutputMode
}

export interface ProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Data written to stdin. Supplying input makes the default stdin mode `pipe`. */
  input?: string | Uint8Array
  stdio?: ProcessStdioOptions
  signal?: AbortSignal
  timeoutMs?: number
  killGraceMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  onStdout?: (chunk: Buffer) => void
  onStderr?: (chunk: Buffer) => void
}

export interface ProcessResult {
  command: string
  args: string[]
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  termination: ProcessTermination
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

export interface ManagedProcess {
  readonly pid: number | undefined
  readonly result: Promise<ProcessResult>
  wait(): Promise<ProcessResult>
  /** Request SIGTERM now and SIGKILL after `killGraceMs` if the child remains alive. */
  terminate(): Promise<ProcessResult>
}

export class ProcessError extends Error {
  readonly command: string
  readonly args: string[]
  readonly result: ProcessResult | undefined

  constructor(
    message: string,
    command: string,
    args: readonly string[],
    result?: ProcessResult,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ProcessError"
    this.command = command
    this.args = [...args]
    this.result = result
  }
}

export class ProcessAbortError extends ProcessError {
  constructor(command: string, args: readonly string[], cause?: unknown) {
    super(`Process was aborted before it started: ${formatCommand(command, args)}`, command, args, undefined, {
      cause,
    })
    this.name = "AbortError"
  }
}

interface BoundedCapture {
  readonly text: () => string
  readonly truncated: () => boolean
}

/**
 * Spawn a process without a shell and return a handle that can be terminated.
 * Non-zero exits are represented in `result`; only spawn failures reject it.
 */
export function spawnManaged(
  command: string,
  args: readonly string[] = [],
  options: ProcessOptions = {}
): ManagedProcess {
  const processArgs = [...args]
  if (options.signal?.aborted) {
    throw new ProcessAbortError(command, processArgs, options.signal.reason)
  }

  const timeoutMs = durationOption("timeoutMs", options.timeoutMs, 0)
  const killGraceMs = durationOption("killGraceMs", options.killGraceMs, DEFAULT_KILL_GRACE_MS)
  const maxStdoutBytes = byteLimitOption(
    "maxStdoutBytes",
    options.maxStdoutBytes,
    DEFAULT_MAX_OUTPUT_BYTES
  )
  const maxStderrBytes = byteLimitOption(
    "maxStderrBytes",
    options.maxStderrBytes,
    DEFAULT_MAX_OUTPUT_BYTES
  )

  const stdinMode = options.stdio?.stdin ?? (options.input === undefined ? "ignore" : "pipe")
  const stdoutMode = options.stdio?.stdout ?? "capture"
  const stderrMode = options.stdio?.stderr ?? "capture"
  if (options.input !== undefined && stdinMode !== "pipe") {
    throw new TypeError("Process input requires stdio.stdin to be 'pipe'")
  }

  let child: ChildProcess
  try {
    child = spawn(command, processArgs, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: [stdinMode, outputMode(stdoutMode), outputMode(stderrMode)],
    })
  } catch (cause) {
    throw new ProcessError(
      `Failed to spawn process: ${formatCommand(command, processArgs)}`,
      command,
      processArgs,
      undefined,
      { cause }
    )
  }

  const startedAt = Date.now()
  const stdout = capture(child.stdout, stdoutMode, maxStdoutBytes, options.onStdout)
  const stderr = capture(child.stderr, stderrMode, maxStderrBytes, options.onStderr)
  let settled = false
  let termination: ProcessTermination = null
  let timeout: NodeJS.Timeout | undefined
  let killTimeout: NodeJS.Timeout | undefined
  let termSent = false
  let resolveResult!: (value: ProcessResult) => void
  let rejectResult!: (reason: ProcessError) => void

  const result = new Promise<ProcessResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const cleanup = (): void => {
    if (timeout) clearTimeout(timeout)
    if (killTimeout) clearTimeout(killTimeout)
    options.signal?.removeEventListener("abort", abortHandler)
  }

  const requestTermination = (reason: Exclude<ProcessTermination, null>): void => {
    if (settled) return
    if (termination === null) termination = reason
    if (termSent) return
    termSent = true

    try {
      child.kill("SIGTERM")
    } catch {
      // A concurrent process exit is observed through the close event.
    }

    killTimeout = setTimeout(() => {
      if (settled) return
      try {
        child.kill("SIGKILL")
      } catch {
        // A concurrent process exit is observed through the close event.
      }
    }, killGraceMs)
  }

  const abortHandler = (): void => requestTermination("abort")

  child.once("error", (cause: Error) => {
    if (settled) return
    settled = true
    cleanup()
    rejectResult(
      new ProcessError(
        `Failed to spawn process: ${formatCommand(command, processArgs)}`,
        command,
        processArgs,
        undefined,
        { cause }
      )
    )
  })

  child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return
    settled = true
    cleanup()
    resolveResult({
      command,
      args: processArgs,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
      exitCode,
      signal,
      termination,
      timedOut: termination === "timeout",
      aborted: termination === "abort",
      durationMs: Date.now() - startedAt,
    })
  })

  if (options.input !== undefined) {
    child.stdin?.on("error", () => {
      // EPIPE is reflected by the child's eventual exit status.
    })
    child.stdin?.end(
      typeof options.input === "string" ? options.input : Buffer.from(options.input)
    )
  } else if (stdinMode === "pipe") {
    child.stdin?.end()
  }

  if (timeoutMs > 0) {
    timeout = setTimeout(() => requestTermination("timeout"), timeoutMs)
  }

  options.signal?.addEventListener("abort", abortHandler, { once: true })
  if (options.signal?.aborted) abortHandler()

  return {
    get pid() {
      return child.pid
    },
    result,
    wait: () => result,
    terminate: () => {
      requestTermination("requested")
      return result
    },
  }
}

/** Spawn without a shell and return the exit result, including non-zero exits. */
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  return spawnManaged(command, args, options).result
}

/** Spawn without a shell and reject unless the process exits normally with code zero. */
export async function spawnChecked(
  command: string,
  args: readonly string[] = [],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const result = await spawnProcess(command, args, options)
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    result.termination === null
  ) {
    return result
  }

  throw new ProcessError(
    `Process ${describeResult(result)}: ${formatCommand(command, args)}`,
    command,
    args,
    result
  )
}

function capture(
  stream: Readable | null,
  mode: ProcessOutputMode,
  limit: number,
  observer?: (chunk: Buffer) => void
): BoundedCapture {
  const chunks: Buffer[] = []
  let length = 0
  let wasTruncated = false

  if (mode === "capture" && stream) {
    stream.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      observer?.(chunk)
      const remaining = limit - length
      if (remaining > 0) {
        const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
        chunks.push(kept)
        length += kept.length
      }
      if (chunk.length > remaining) wasTruncated = true
    })
  }

  return {
    text: () => Buffer.concat(chunks, length).toString("utf8"),
    truncated: () => wasTruncated,
  }
}

function outputMode(mode: ProcessOutputMode): "pipe" | "inherit" | "ignore" {
  return mode === "capture" ? "pipe" : mode
}

function durationOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`)
  }
  return resolved
}

function byteLimitOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return resolved
}

function describeResult(result: ProcessResult): string {
  if (result.termination === "timeout") return "timed out"
  if (result.termination === "abort") return "was aborted"
  if (result.termination === "requested") return "was terminated"
  if (result.signal) return `was killed by ${result.signal}`
  return `exited with code ${result.exitCode ?? "unknown"}`
}

function formatCommand(command: string, args: readonly string[]): string {
  return JSON.stringify([command, ...args])
}
