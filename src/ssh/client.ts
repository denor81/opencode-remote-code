import { posix } from "node:path"
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  spawnProcess,
  type ProcessResult,
} from "../process.js"
import { quoteShell } from "../shell-quote.js"

export interface ExecOptions {
  cwd?: string
  timeout?: number
  signal?: AbortSignal
  onStdout?: (chunk: Buffer) => void
  onStderr?: (chunk: Buffer) => void
}

export interface RemoteCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  signal: NodeJS.Signals | null
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface SshClientOptions {
  sshBinary?: string
  env?: NodeJS.ProcessEnv
  killGraceMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export class SshClientError extends Error {
  readonly alias: string
  readonly result: ProcessResult | undefined

  constructor(
    message: string,
    alias: string,
    result?: ProcessResult,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "SshClientError"
    this.alias = alias
    this.result = result
  }
}

/** Opens one-shot command channels through a launcher-owned OpenSSH master. */
export class SshClient {
  readonly alias: string
  readonly socketPath: string
  readonly sshBinary: string

  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly killGraceMs: number
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number

  constructor(alias: string, socketPath: string, options: SshClientOptions = {}) {
    this.alias = requireString("alias", alias)
    this.socketPath = requireString("socketPath", socketPath)
    this.sshBinary = requireString("sshBinary", options.sshBinary ?? "ssh")
    this.env = options.env
    this.killGraceMs = nonNegativeNumber(
      "killGraceMs",
      options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    )
    this.maxStdoutBytes = byteLimit(
      "maxStdoutBytes",
      options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    )
    this.maxStderrBytes = byteLimit(
      "maxStderrBytes",
      options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    )
  }

  async exec(command: string, options: ExecOptions = {}): Promise<RemoteCommandResult> {
    if (typeof command !== "string") throw new TypeError("command must be a string")
    if (options.cwd !== undefined) validateShellPath("cwd", options.cwd)
    if (options.timeout !== undefined) nonNegativeNumber("timeout", options.timeout)

    const args = [
      "-T",
      "-S",
      this.socketPath,
      "-o",
      "ControlMaster=no",
      "-o",
      "BatchMode=yes",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "ProxyCommand=false",
      "--",
      this.alias,
      "sh",
      "-s",
    ]
    const script =
      options.cwd === undefined
        ? command
        : `cd ${quoteShell(options.cwd)} || exit $?\n${command}`

    let result: ProcessResult
    try {
      result = await spawnProcess(this.sshBinary, args, {
        env: this.env,
        input: script,
        signal: options.signal,
        timeoutMs: options.timeout,
        killGraceMs: this.killGraceMs,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      })
    } catch (cause) {
      if (options.signal?.aborted) {
        throw commandChannelError(
          `SSH command was aborted for ${JSON.stringify(this.alias)}; the remote process may still be running`,
          "AbortError",
          this.alias,
          undefined,
          cause
        )
      }
      throw new SshClientError(
        `Failed to start SSH command transport for ${JSON.stringify(this.alias)}`,
        this.alias,
        undefined,
        { cause }
      )
    }

    if (result.termination === "timeout") {
      throw commandChannelError(
        `SSH command timed out for ${JSON.stringify(this.alias)}; the remote process may still be running`,
        "TimeoutError",
        this.alias,
        result
      )
    }
    if (result.termination === "abort") {
      throw commandChannelError(
        `SSH command was aborted for ${JSON.stringify(this.alias)}; the remote process may still be running`,
        "AbortError",
        this.alias,
        result
      )
    }
    if (result.termination !== null || result.signal !== null || result.exitCode === null) {
      throw new SshClientError(
        `SSH command transport terminated unexpectedly for ${JSON.stringify(this.alias)}`,
        this.alias,
        result
      )
    }
    // OpenSSH reserves 255 for failures before a remote command status is available.
    if (result.exitCode === 255) {
      throw new SshClientError(
        `SSH transport failed for ${JSON.stringify(this.alias)} (exit code 255)`,
        this.alias,
        result
      )
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    }
  }

  /** Resolve an existing absolute remote directory without interpolating it as shell code. */
  async canonicalizeWorkdir(
    requested: string,
    signal?: AbortSignal
  ): Promise<string> {
    validateAbsolutePosixPath("requested workdir", requested)

    const result = await this.exec("pwd -P", { cwd: requested, signal })
    if (result.exitCode !== 0) {
      throw new SshClientError(
        `Remote workdir ${JSON.stringify(requested)} is not an existing directory (exit code ${result.exitCode})`,
        this.alias
      )
    }
    if (result.stdoutTruncated) {
      throw new SshClientError(
        `Canonical remote workdir output was truncated for ${JSON.stringify(requested)}`,
        this.alias
      )
    }

    const canonical = result.stdout.endsWith("\n")
      ? result.stdout.slice(0, -1)
      : result.stdout
    if (!posix.isAbsolute(canonical) || canonical.includes("\0")) {
      throw new SshClientError(
        `Remote pwd -P returned an invalid absolute path for ${JSON.stringify(requested)}`,
        this.alias
      )
    }
    return canonical
  }
}

function validateAbsolutePosixPath(name: string, value: string): void {
  validateShellPath(name, value)
  if (!posix.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute POSIX path`)
  }
}

function validateShellPath(name: string, value: string): void {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`)
  if (value.includes("\0")) throw new TypeError(`${name} must not contain NUL`)
}

function requireString(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function nonNegativeNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`)
  }
  return value
}

function byteLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function commandChannelError(
  message: string,
  name: "AbortError" | "TimeoutError",
  alias: string,
  result?: ProcessResult,
  cause?: unknown
): SshClientError {
  const error = new SshClientError(message, alias, result, { cause })
  error.name = name
  return error
}
