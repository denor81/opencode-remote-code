import type { ProcessResult, ProcessTermination } from "../process.js"

const MAX_PARTIAL_LINE_BYTES = 8 * 1024

export type ControlMasterChannelFailureReason =
  | "administratively-prohibited"
  | "connect-failed"
  | "resource-shortage"
  | "unknown-channel-type"
  | "other"

export type ControlMasterMessageCategory =
  | "authentication"
  | "configuration"
  | "connection"
  | "host-key"
  | "other"

export type ControlMasterDiagnostic =
  | {
      kind: "channel-open-failed"
      reason: ControlMasterChannelFailureReason
    }
  | {
      kind: "master-message"
      category: ControlMasterMessageCategory
    }

export type SSHTransport = "ssh" | "sftp"

export type SSHTransportFailureKind =
  | "channel-open-refused"
  | "master-unavailable"
  | "spawn-failed"
  | "timeout"
  | "terminated"
  | "exit-255"
  | "sftp-failed"
  | "unknown"

export interface SSHTransportFailureDiagnostic {
  transport: SSHTransport
  failureKind: SSHTransportFailureKind
  exitCode: number | null
  termination: ProcessTermination
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface ControlMasterDiagnosticParser {
  write(chunk: Buffer): void
  end(): void
}

/** Convert arbitrary OpenSSH stderr into bounded, privacy-safe categories. */
export function createControlMasterDiagnosticParser(
  onDiagnostic: (diagnostic: ControlMasterDiagnostic) => boolean | void
): ControlMasterDiagnosticParser {
  let pending = Buffer.alloc(0)
  let discarding = false
  let stopped = false

  const emit = (diagnostic: ControlMasterDiagnostic): void => {
    try {
      if (onDiagnostic(diagnostic) === false) stopped = true
    } catch {
      // Diagnostics must never affect SSH process handling.
    }
  }

  const emitLine = (line: Buffer): void => {
    const withoutCarriageReturn =
      line.at(-1) === 0x0d ? line.subarray(0, line.length - 1) : line
    if (withoutCarriageReturn.length === 0) return
    const diagnostic = classifyControlMasterLine(withoutCarriageReturn.toString("utf8"))
    if (diagnostic) emit(diagnostic)
  }

  const write = (chunk: Buffer): void => {
    if (stopped) return
    let offset = 0
    while (!stopped && offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline === -1 ? chunk.length : newline
      const segment = chunk.subarray(offset, end)
      let discardedCurrentLine = discarding

      if (!discarding) {
        if (pending.length + segment.length > MAX_PARTIAL_LINE_BYTES) {
          pending = Buffer.alloc(0)
          discardedCurrentLine = true
          emit({ kind: "master-message", category: "other" })
        } else if (segment.length > 0) {
          pending = Buffer.concat([pending, segment], pending.length + segment.length)
        }
      }

      if (newline !== -1) {
        if (!discardedCurrentLine) emitLine(pending)
        pending = Buffer.alloc(0)
        discarding = false
        offset = newline + 1
      } else {
        discarding = discardedCurrentLine
        break
      }
    }
  }

  return {
    write,
    end() {
      if (!stopped && !discarding && pending.length > 0) emitLine(pending)
      pending = Buffer.alloc(0)
      discarding = false
    },
  }
}

export function classifyControlMasterLine(
  line: string
): ControlMasterDiagnostic | undefined {
  const channelFailure = /^channel \d+: open failed: ([^:]+)(?::.*)?$/iu.exec(line.trim())
  if (channelFailure) {
    return {
      kind: "channel-open-failed",
      reason: channelFailureReason(channelFailure[1] ?? ""),
    }
  }

  const normalized = line.toLowerCase()
  if (/^debug[123]:/u.test(normalized.trimStart())) return undefined
  if (/permission denied|authentication failed|no supported authentication/u.test(normalized)) {
    return { kind: "master-message", category: "authentication" }
  }
  if (/host key|remote host identification has changed/u.test(normalized)) {
    return { kind: "master-message", category: "host-key" }
  }
  if (/bad configuration option|could not resolve hostname|identity file/u.test(normalized)) {
    return { kind: "master-message", category: "configuration" }
  }
  if (
    /broken pipe|connection (?:closed|refused|reset|timed out)|network is unreachable|no route to host/u.test(
      normalized
    )
  ) {
    return { kind: "master-message", category: "connection" }
  }
  return { kind: "master-message", category: "other" }
}

export function classifySSHTransportFailure(
  error: unknown,
  transport: SSHTransport
): SSHTransportFailureDiagnostic | undefined {
  const name = errorName(error)
  if (name === "AbortError" || name === "SftpFileNotFoundError") return undefined

  const result = processResult(error)
  return {
    transport,
    failureKind: transportFailureKind(name, result, transport),
    exitCode: result?.exitCode ?? null,
    termination: result?.termination ?? null,
    stdoutTruncated: result?.stdoutTruncated ?? false,
    stderrTruncated: result?.stderrTruncated ?? false,
  }
}

function channelFailureReason(value: string): ControlMasterChannelFailureReason {
  switch (value.trim().toLowerCase().replaceAll("_", "-")) {
    case "administratively prohibited":
    case "administratively-prohibited":
      return "administratively-prohibited"
    case "connect failed":
    case "connect-failed":
      return "connect-failed"
    case "resource shortage":
    case "resource-shortage":
      return "resource-shortage"
    case "unknown channel type":
    case "unknown-channel-type":
      return "unknown-channel-type"
    default:
      return "other"
  }
}

function transportFailureKind(
  name: string | undefined,
  result: ProcessResult | undefined,
  transport: SSHTransport
): SSHTransportFailureKind {
  if (name === "TimeoutError" || result?.termination === "timeout") return "timeout"
  if (!result) return "spawn-failed"

  const stderr = result.stderr
  if (/channel \d+: open failed:|session request failed|master refused session request/iu.test(stderr)) {
    return "channel-open-refused"
  }
  if (
    /master is dead|control socket connect[^\n]*(?:no such file or directory|connection refused)?/iu.test(
      stderr
    )
  ) {
    return "master-unavailable"
  }
  if (result.termination !== null || result.signal !== null || result.exitCode === null) {
    return "terminated"
  }
  if (result.exitCode === 255) return "exit-255"
  if (transport === "sftp") return "sftp-failed"
  return "unknown"
}

function errorName(error: unknown): string | undefined {
  try {
    return error instanceof Error ? error.name : undefined
  } catch {
    return undefined
  }
}

function processResult(error: unknown): ProcessResult | undefined {
  try {
    if (error === null || typeof error !== "object" || !("result" in error)) return undefined
    const result = error.result
    return isProcessResult(result) ? result : undefined
  } catch {
    return undefined
  }
}

function isProcessResult(value: unknown): value is ProcessResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "exitCode" in value &&
    (typeof value.exitCode === "number" || value.exitCode === null) &&
    "stderr" in value &&
    typeof value.stderr === "string" &&
    "stdoutTruncated" in value &&
    typeof value.stdoutTruncated === "boolean" &&
    "stderrTruncated" in value &&
    typeof value.stderrTruncated === "boolean" &&
    "termination" in value &&
    (value.termination === null ||
      value.termination === "abort" ||
      value.termination === "requested" ||
      value.termination === "timeout")
  )
}
