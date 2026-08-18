import { isAbsolute, posix } from "node:path"
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  spawnProcess,
  type ProcessResult,
} from "../process.js"

export interface SftpClientOptions {
  sftpBinary?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  killGraceMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export interface SftpTransferOptions {
  signal?: AbortSignal
  timeout?: number
}

export const DEFAULT_SFTP_TIMEOUT_MS = 30_000

export type SftpOperation = "download" | "upload"

export class SftpClientError extends Error {
  readonly alias: string
  readonly operation: SftpOperation
  readonly result: ProcessResult | undefined

  constructor(
    message: string,
    alias: string,
    operation: SftpOperation,
    result?: ProcessResult,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "SftpClientError"
    this.alias = alias
    this.operation = operation
    this.result = result
  }
}

export class SftpFileNotFoundError extends SftpClientError {
  readonly code = "ENOENT"

  constructor(message: string, alias: string, result?: ProcessResult) {
    super(message, alias, "download", result)
    this.name = "SftpFileNotFoundError"
  }
}

/** Quotes one path for OpenSSH's SFTP batch-command parser. */
export function quoteSftpPath(path: string): string {
  validateRepresentablePath("path", path)
  // OpenSSH preserves backslashes before glob characters inside double quotes.
  // Escape batch-parser metacharacters as one unquoted word instead.
  return path.replace(/[\\\s"'*?\[\]]/gu, "\\$&")
}

/** Performs one transfer per system SFTP process through an existing control socket. */
export class SftpClient {
  readonly alias: string
  readonly socketPath: string
  readonly sftpBinary: string

  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly timeout: number
  private readonly killGraceMs: number
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number

  constructor(alias: string, socketPath: string, options: SftpClientOptions = {}) {
    this.alias = requireString("alias", alias)
    this.socketPath = requireString("socketPath", socketPath)
    this.sftpBinary = requireString("sftpBinary", options.sftpBinary ?? "sftp")
    this.env = options.env
    this.timeout = nonNegativeNumber(
      "timeout",
      options.timeout ?? DEFAULT_SFTP_TIMEOUT_MS
    )
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

  async download(
    remote: string,
    local: string,
    options: SftpTransferOptions = {}
  ): Promise<void> {
    validateRemotePath(remote)
    validateLocalPath(local)
    await this.transfer(
      "download",
      `get ${quoteSftpPath(remote)} ${quoteSftpPath(local)}\n`,
      options
    )
  }

  async upload(
    local: string,
    remote: string,
    options: SftpTransferOptions = {}
  ): Promise<void> {
    validateLocalPath(local)
    validateRemotePath(remote)
    await this.transfer(
      "upload",
      `put ${quoteSftpPath(local)} ${quoteSftpPath(remote)}\n`,
      options
    )
  }

  private async transfer(
    operation: SftpOperation,
    batchCommand: string,
    options: SftpTransferOptions
  ): Promise<void> {
    const timeout = nonNegativeNumber("timeout", options.timeout ?? this.timeout)
    const args = [
      "-b",
      "-",
      "-o",
      `ControlPath=${this.socketPath}`,
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
    ]
    let result: ProcessResult

    try {
      result = await spawnProcess(this.sftpBinary, args, {
        env: this.env,
        input: batchCommand,
        signal: options.signal,
        timeoutMs: timeout,
        killGraceMs: this.killGraceMs,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes,
      })
    } catch (cause) {
      if (options.signal?.aborted) {
        throw transferChannelError(
          `SFTP ${operation} was aborted for ${JSON.stringify(this.alias)}`,
          "AbortError",
          this.alias,
          operation,
          undefined,
          cause
        )
      }
      throw new SftpClientError(
        `Failed to start SFTP ${operation} for ${JSON.stringify(this.alias)}`,
        this.alias,
        operation,
        undefined,
        { cause }
      )
    }

    if (result.termination === "timeout") {
      throw transferChannelError(
        `SFTP ${operation} timed out for ${JSON.stringify(this.alias)}`,
        "TimeoutError",
        this.alias,
        operation,
        result
      )
    }
    if (result.termination === "abort") {
      throw transferChannelError(
        `SFTP ${operation} was aborted for ${JSON.stringify(this.alias)}`,
        "AbortError",
        this.alias,
        operation,
        result
      )
    }
    if (
      result.termination !== null ||
      result.signal !== null ||
      result.exitCode === null ||
      result.exitCode !== 0
    ) {
      const detail = result.stderr.trim() || result.stdout.trim()
      if (
        operation === "download" &&
        result.termination === null &&
        result.signal === null &&
        result.exitCode !== null &&
        result.exitCode !== 255 &&
        isRemoteFileNotFound(detail)
      ) {
        throw new SftpFileNotFoundError(
          `Remote file was not found during SFTP download for ${JSON.stringify(
            this.alias
          )}: ${detail}`,
          this.alias,
          result
        )
      }
      throw new SftpClientError(
        `SFTP ${operation} failed for ${JSON.stringify(this.alias)} (${describeResult(result)})${
          detail ? `: ${detail}` : ""
        }`,
        this.alias,
        operation,
        result
      )
    }
  }
}

function isRemoteFileNotFound(detail: string): boolean {
  return /(?:^|\n)(?:File .+ not found\.?|remote (?:open|stat).*: No such file or directory|Couldn't stat remote file: No such file or directory)(?:\n|$)/i.test(
    detail
  )
}

function transferChannelError(
  message: string,
  name: "AbortError" | "TimeoutError",
  alias: string,
  operation: SftpOperation,
  result?: ProcessResult,
  cause?: unknown
): SftpClientError {
  const error = new SftpClientError(message, alias, operation, result, { cause })
  error.name = name
  return error
}

function validateLocalPath(path: string): void {
  validateRepresentablePath("local path", path)
  if (!isAbsolute(path)) throw new TypeError("local path must be absolute")
}

function validateRemotePath(path: string): void {
  validateRepresentablePath("remote path", path)
  if (!posix.isAbsolute(path)) throw new TypeError("remote path must be an absolute POSIX path")
}

function validateRepresentablePath(name: string, path: string): void {
  if (typeof path !== "string") throw new TypeError(`${name} must be a string`)
  if (/[\r\n\0]/.test(path)) {
    throw new TypeError(`${name} must not contain CR, LF, or NUL`)
  }
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

function describeResult(result: ProcessResult): string {
  if (result.signal) return `signal ${result.signal}`
  if (result.termination) return result.termination
  return `exit code ${result.exitCode ?? "unknown"}`
}
