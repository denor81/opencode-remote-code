import type { PluginInput } from "@opencode-ai/plugin"
import { spawnProcess, type ProcessResult } from "./process.js"

const VERSION_TIMEOUT_MS = 5_000
const VERSION_OUTPUT_BYTES = 4_096
const PLAIN_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

export const OPEN_CODE_RUNTIME_OBSERVATION_FAILURE_CODES = Object.freeze(
  [
    "health-unavailable",
    "legacy-transport-invalid",
    "health-request-failed",
    "health-timeout",
    "health-aborted",
    "health-response-invalid",
    "executable-version-invalid",
  ] as const
)

export type OpenCodeRuntimeObservationFailureCode =
  (typeof OPEN_CODE_RUNTIME_OBSERVATION_FAILURE_CODES)[number]

const FAILURE_MESSAGES: Record<
  OpenCodeRuntimeObservationFailureCode,
  string
> = {
  "health-unavailable":
    "OpenCode runtime health is unavailable in this loader process",
  "legacy-transport-invalid":
    "OpenCode legacy client transport has an invalid shape",
  "health-request-failed": "OpenCode runtime health request failed",
  "health-timeout": "OpenCode runtime health request timed out",
  "health-aborted": "OpenCode runtime health request was aborted",
  "health-response-invalid": "OpenCode global health response was invalid",
  "executable-version-invalid":
    "OpenCode runtime executable returned an ambiguous version result",
}

const preservedAbortCodes = new WeakMap<
  object,
  OpenCodeRuntimeObservationFailureCode
>()

export class OpenCodeRuntimeObservationError extends Error {
  readonly code: OpenCodeRuntimeObservationFailureCode

  constructor(
    code: OpenCodeRuntimeObservationFailureCode,
    message = FAILURE_MESSAGES[code]
  ) {
    super(message)
    this.name = "OpenCodeRuntimeObservationError"
    this.code = code
  }
}

export function classifyOpenCodeRuntimeObservationFailure(
  error: unknown
): OpenCodeRuntimeObservationFailureCode | undefined {
  if (isWeakKey(error)) {
    const preservedCode = preservedAbortCodes.get(error)
    if (preservedCode) return preservedCode
  }
  return error instanceof OpenCodeRuntimeObservationError
    ? error.code
    : undefined
}

export type OpenCodeRuntimeVersionSource =
  | "client.global.health"
  | "client._client.get"
  | "runtime-executable"

export interface OpenCodeRuntimeVersionObservation {
  version: string
  source: OpenCodeRuntimeVersionSource
}

export interface OpenCodeRuntimeVersionOptions {
  signal?: AbortSignal
  allowRuntimeExecutableFallback?: boolean
  healthTimeoutMs?: number
}

export type RuntimeExecutableVersionResult = Pick<
  ProcessResult,
  | "stdout"
  | "stderr"
  | "stdoutTruncated"
  | "stderrTruncated"
  | "exitCode"
  | "signal"
  | "termination"
  | "timedOut"
  | "aborted"
>

export async function observeOpenCodeRuntimeVersion(
  input: PluginInput,
  options: OpenCodeRuntimeVersionOptions = {}
): Promise<OpenCodeRuntimeVersionObservation> {
  if (options.signal?.aborted) throw callerAbortReason(options.signal)
  const candidate = input as unknown as {
    client?: unknown
  }
  const client = candidate.client
  const globalValue = isRecord(client)
    ? ownDataValue(client, "global")
    : { found: false as const, value: undefined }
  const globalClient = globalValue.found && isRecord(globalValue.value)
    ? globalValue.value
    : undefined
  let publicHealth: unknown
  try {
    publicHealth = globalClient?.health
  } catch {
    throw runtimeObservationError("health-request-failed")
  }
  if (typeof publicHealth === "function") {
    const response = await requestRuntimeHealth(
      (signal) => publicHealth.call(globalClient, { signal }),
      options
    )
    return {
      version: parsePublicClientHealthResponse(response),
      source: "client.global.health",
    }
  }

  const legacyTransport = inspectLegacyClientTransport(client)
  if (legacyTransport.kind === "invalid") throw legacyTransport.error
  if (legacyTransport.kind === "available") {
    const response = await requestRuntimeHealth(
      (signal) =>
        legacyTransport.get.call(legacyTransport.transport, {
          url: "/global/health",
          signal,
        }),
      options
    )
    return {
      version: parseLegacyClientHealthResponse(response),
      source: "client._client.get",
    }
  }

  const unavailable = runtimeObservationError("health-unavailable")
  if (!options.allowRuntimeExecutableFallback) {
    throw unavailable
  }
  return await observeRuntimeExecutableVersion(options.signal)
}

export function isOpenCodeVersion(value: unknown): value is string {
  return typeof value === "string" && PLAIN_VERSION.test(value)
}

export function parseRuntimeExecutableVersionResult(
  result: RuntimeExecutableVersionResult
): string {
  const version = result.stdout.trim()
  if (
    result.termination !== null ||
    result.timedOut ||
    result.aborted ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.stdoutTruncated ||
    result.stderrTruncated ||
    !isOpenCodeVersion(version)
  ) {
    throw runtimeObservationError("executable-version-invalid")
  }
  return version
}

function parsePublicClientHealthResponse(value: unknown): string {
  if (!isRecord(value)) throw invalidHealthResult("client.global.health")
  if (hasExactOwnKeys(value, ["data"])) {
    const data = ownDataValue(value, "data")
    if (data.found) return parseHealthPayload(data.value)
  }
  if (hasExactOwnKeys(value, ["data", "request", "response"])) {
    return parseSdkHealthResponse(value, "client.global.health")
  }
  throw invalidHealthResult("client.global.health")
}

function parseLegacyClientHealthResponse(value: unknown): string {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ["data", "request", "response"])
  ) {
    throw invalidHealthResult("client._client.get")
  }
  return parseSdkHealthResponse(value, "client._client.get")
}

function parseSdkHealthResponse(
  value: Record<string, unknown>,
  source: "client.global.health" | "client._client.get"
): string {
  const data = ownDataValue(value, "data")
  const request = ownDataValue(value, "request")
  const response = ownDataValue(value, "response")
  if (
    !data.found ||
    !request.found ||
    !response.found ||
    !(request.value instanceof Request) ||
    !(response.value instanceof Response)
  ) {
    throw invalidHealthResult(source)
  }

  let envelopeIsValid = false
  try {
    envelopeIsValid =
      request.value.method === "GET" &&
      new URL(request.value.url).pathname === "/global/health" &&
      response.value.status === 200 &&
      response.value.ok === true
  } catch {
    // Invalid Request or Response runtime state gets a fixed response failure.
  }
  if (!envelopeIsValid) throw invalidHealthResult(source)
  return parseHealthPayload(data.value)
}

function parseHealthPayload(value: unknown): string {
  if (!isRecord(value) || !hasExactOwnKeys(value, ["healthy", "version"])) {
    throw invalidHealthPayload()
  }
  const healthy = ownDataValue(value, "healthy")
  const version = ownDataValue(value, "version")
  if (
    !healthy.found ||
    healthy.value !== true ||
    !version.found ||
    !isOpenCodeVersion(version.value)
  ) {
    throw invalidHealthPayload()
  }
  return version.value
}

async function observeRuntimeExecutableVersion(
  signal: AbortSignal | undefined
): Promise<OpenCodeRuntimeVersionObservation> {
  if (signal?.aborted) throw callerAbortReason(signal)
  let result: ProcessResult
  try {
    result = await spawnProcess(process.execPath, ["--version"], {
      signal,
      timeoutMs: VERSION_TIMEOUT_MS,
      maxStdoutBytes: VERSION_OUTPUT_BYTES,
      maxStderrBytes: VERSION_OUTPUT_BYTES,
      terminationMode: "process-group",
      stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
    })
  } catch {
    if (signal?.aborted) throw callerAbortReason(signal)
    throw runtimeObservationError("executable-version-invalid")
  }
  if (signal?.aborted) throw callerAbortReason(signal)
  const version = parseRuntimeExecutableVersionResult(result)
  return { version, source: "runtime-executable" }
}

async function requestRuntimeHealth(
  request: (signal: AbortSignal) => unknown,
  options: OpenCodeRuntimeVersionOptions
): Promise<unknown> {
  const timeout = AbortSignal.timeout(healthTimeout(options.healthTimeoutMs))
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout
  try {
    throwIfAborted(signal)
    return await waitForAbort(
      Promise.resolve().then(() => request(signal)),
      signal
    )
  } catch {
    if (options.signal?.aborted) throw callerAbortReason(options.signal)
    if (timeout.aborted) throw runtimeObservationError("health-timeout")
    throw runtimeObservationError("health-request-failed")
  }
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort)
    })
  })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : runtimeObservationError("health-aborted")
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function callerAbortReason(signal: AbortSignal): unknown {
  const reason = abortReason(signal)
  if (isWeakKey(reason)) preservedAbortCodes.set(reason, "health-aborted")
  return reason
}

type LegacyTransportInspection =
  | { kind: "unavailable" }
  | { kind: "invalid"; error: Error }
  | {
      kind: "available"
      transport: Record<string, unknown>
      get: (
        options: { url: "/global/health"; signal: AbortSignal }
      ) => unknown
    }

function inspectLegacyClientTransport(client: unknown): LegacyTransportInspection {
  if (!isRecord(client)) return { kind: "unavailable" }

  let clientDescriptor: PropertyDescriptor | undefined
  try {
    clientDescriptor = Object.getOwnPropertyDescriptor(client, "_client")
  } catch {
    return invalidLegacyClientTransport()
  }
  if (!clientDescriptor) return { kind: "unavailable" }
  if (!("value" in clientDescriptor) || !isRecord(clientDescriptor.value)) {
    return invalidLegacyClientTransport()
  }

  const transport = clientDescriptor.value
  const globalClient = ownDataValue(client, "global")
  const sessionClient = ownDataValue(client, "session")
  if (
    !globalClient.found ||
    !isRecord(globalClient.value) ||
    !sessionClient.found ||
    !isRecord(sessionClient.value) ||
    ownDataValue(globalClient.value, "_client").value !== transport ||
    ownDataValue(sessionClient.value, "_client").value !== transport
  ) {
    return invalidLegacyClientTransport()
  }

  let getDescriptor: PropertyDescriptor | undefined
  try {
    getDescriptor = Object.getOwnPropertyDescriptor(transport, "get")
  } catch {
    return invalidLegacyClientTransport()
  }
  if (!getDescriptor || !("value" in getDescriptor)) {
    return invalidLegacyClientTransport()
  }
  if (typeof getDescriptor.value !== "function") {
    return invalidLegacyClientTransport()
  }
  return {
    kind: "available",
    transport,
    get: getDescriptor.value as (
      options: { url: "/global/health"; signal: AbortSignal }
    ) => unknown,
  }
}

function invalidLegacyClientTransport(): LegacyTransportInspection {
  return {
    kind: "invalid",
    error: runtimeObservationError("legacy-transport-invalid"),
  }
}

function invalidHealthResult(
  source: "client.global.health" | "client._client.get"
): OpenCodeRuntimeObservationError {
  return runtimeObservationError(
    "health-response-invalid",
    `${source} returned an invalid result`
  )
}

function invalidHealthPayload(): OpenCodeRuntimeObservationError {
  return runtimeObservationError(
    "health-response-invalid",
    "OpenCode global health returned an invalid payload"
  )
}

function runtimeObservationError(
  code: OpenCodeRuntimeObservationFailureCode,
  message?: string
): OpenCodeRuntimeObservationError {
  return new OpenCodeRuntimeObservationError(code, message)
}

function healthTimeout(value: number | undefined): number {
  const timeout = value ?? VERSION_TIMEOUT_MS
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > VERSION_TIMEOUT_MS
  ) {
    throw new RangeError(
      `healthTimeoutMs must be a positive safe integer no greater than ${VERSION_TIMEOUT_MS}`
    )
  }
  return timeout
}

type OwnDataValue =
  | { found: true; value: unknown }
  | { found: false; value: undefined }

function ownDataValue(
  value: Record<string, unknown>,
  key: string
): OwnDataValue {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor
      ? { found: true, value: descriptor.value }
      : { found: false, value: undefined }
  } catch {
    return { found: false, value: undefined }
  }
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  try {
    const keys = Reflect.ownKeys(value)
    return (
      keys.length === expected.length &&
      keys.every(
        (key) => typeof key === "string" && expected.includes(key)
      )
    )
  } catch {
    return false
  }
}

function isWeakKey(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
