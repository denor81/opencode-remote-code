import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { open, rename, rm, unlink } from "node:fs/promises"
import path from "node:path"

export const READY_PROTOCOL = "opencode-ssh-ready-v1" as const
export const READY_STABILITY_INTERVAL_MS = 25
const MAX_READY_FILE_BYTES = 16 * 1024
const READY_RECORD_KEYS = [
  "alias",
  "canonicalWorkdir",
  "launchID",
  "nonceHash",
  "protocol",
  "targetID",
] as const

export interface ReadyHandshakeIdentity {
  launchID: string
  nonce: string
  alias: string
  canonicalWorkdir: string
  targetID: string
}

export interface ReadyRecord {
  protocol: typeof READY_PROTOCOL
  launchID: string
  nonceHash: string
  alias: string
  canonicalWorkdir: string
  targetID: string
}

export interface WaitForReadyOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

export interface ConfirmReadyStabilityOptions {
  intervalMs?: number
  signal?: AbortSignal
}

export class ReadyHandshakeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReadyHandshakeValidationError"
  }
}

export class ReadyHandshakeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for the remote plugin ready handshake`)
    this.name = "ReadyHandshakeTimeoutError"
  }
}

export function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex")
}

function assertIdentity(identity: ReadyHandshakeIdentity): void {
  const fields: Array<[string, unknown]> = [
    ["launchID", identity.launchID],
    ["nonce", identity.nonce],
    ["alias", identity.alias],
    ["canonicalWorkdir", identity.canonicalWorkdir],
    ["targetID", identity.targetID],
  ]
  for (const [name, value] of fields) {
    if (typeof value !== "string" || value.length === 0) {
      throw new ReadyHandshakeValidationError(`${name} must be a non-empty string`)
    }
  }
}

export function createReadyRecord(identity: ReadyHandshakeIdentity): ReadyRecord {
  assertIdentity(identity)
  return {
    protocol: READY_PROTOCOL,
    launchID: identity.launchID,
    nonceHash: hashNonce(identity.nonce),
    alias: identity.alias,
    canonicalWorkdir: identity.canonicalWorkdir,
    targetID: identity.targetID,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function equalHash(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) {
    return false
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
}

export function validateReadyRecord(
  value: unknown,
  expected: ReadyHandshakeIdentity
): ReadyRecord {
  assertIdentity(expected)
  if (!isRecord(value)) {
    throw new ReadyHandshakeValidationError("Ready handshake must be a JSON object")
  }

  const actualKeys = Object.keys(value).sort()
  const expectedKeys = [...READY_RECORD_KEYS].sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ReadyHandshakeValidationError("Ready handshake has an invalid record shape")
  }

  for (const key of READY_RECORD_KEYS) {
    if (typeof value[key] !== "string") {
      throw new ReadyHandshakeValidationError(`Ready handshake field ${key} must be a string`)
    }
  }

  const record = value as unknown as ReadyRecord
  if (record.protocol !== READY_PROTOCOL) {
    throw new ReadyHandshakeValidationError("Ready handshake protocol does not match")
  }
  if (record.launchID !== expected.launchID) {
    throw new ReadyHandshakeValidationError("Ready handshake launch ID does not match")
  }
  if (!equalHash(record.nonceHash, hashNonce(expected.nonce))) {
    throw new ReadyHandshakeValidationError("Ready handshake nonce hash does not match")
  }
  if (record.alias !== expected.alias) {
    throw new ReadyHandshakeValidationError("Ready handshake SSH alias does not match")
  }
  if (record.canonicalWorkdir !== expected.canonicalWorkdir) {
    throw new ReadyHandshakeValidationError("Ready handshake canonical workdir does not match")
  }
  if (record.targetID !== expected.targetID) {
    throw new ReadyHandshakeValidationError("Ready handshake target ID does not match")
  }
  return record
}

/** Write through a private sibling and rename so readers never see partial JSON. */
export async function writeReadyHandshake(
  readyPath: string,
  identity: ReadyHandshakeIdentity
): Promise<ReadyRecord> {
  const record = createReadyRecord(identity)
  const temporaryPath = path.join(
    path.dirname(readyPath),
    `.${path.basename(readyPath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let renamed = false

  try {
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8")
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, readyPath)
    renamed = true
    return record
  } finally {
    if (!renamed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
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

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }
  const error = new Error("Ready handshake wait was aborted")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal)
  }
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal))
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function readReadyRecord(readyPath: string): Promise<unknown> {
  const handle = await open(readyPath, "r")
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new ReadyHandshakeValidationError("Ready handshake path is not a regular file")
    }
    if (stats.size > MAX_READY_FILE_BYTES) {
      throw new ReadyHandshakeValidationError("Ready handshake file is too large")
    }
    const content = await handle.readFile("utf8")
    try {
      return JSON.parse(content) as unknown
    } catch {
      throw new ReadyHandshakeValidationError("Ready handshake contains malformed JSON")
    }
  } finally {
    await handle.close()
  }
}

export async function waitForReadyHandshake(
  readyPath: string,
  expected: ReadyHandshakeIdentity,
  options: WaitForReadyOptions = {}
): Promise<ReadyRecord> {
  assertIdentity(expected)
  const timeoutMs = options.timeoutMs ?? 5_000
  const pollIntervalMs = options.pollIntervalMs ?? 25
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Ready handshake timeout must be a non-negative finite number")
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("Ready handshake poll interval must be a positive finite number")
  }

  const deadline = Date.now() + timeoutMs
  while (true) {
    throwIfAborted(options.signal)
    try {
      const value = await readReadyRecord(readyPath)
      throwIfAborted(options.signal)
      return validateReadyRecord(value, expected)
    } catch (error) {
      if (!errnoIs(error, "ENOENT")) {
        throw error
      }
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new ReadyHandshakeTimeoutError(timeoutMs)
    }
    await delay(Math.min(pollIntervalMs, remaining), options.signal)
  }
}

/** Re-read and validate readiness after the launch stability interval. */
export async function confirmReadyHandshakeStability(
  readyPath: string,
  expected: ReadyHandshakeIdentity,
  options: ConfirmReadyStabilityOptions = {}
): Promise<ReadyRecord> {
  assertIdentity(expected)
  const intervalMs = options.intervalMs ?? READY_STABILITY_INTERVAL_MS
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError(
      "Ready handshake stability interval must be a non-negative finite number"
    )
  }

  await delay(intervalMs, options.signal)
  throwIfAborted(options.signal)
  let value: unknown
  try {
    value = await readReadyRecord(readyPath)
  } catch (error) {
    if (errnoIs(error, "ENOENT")) {
      throw new ReadyHandshakeValidationError(
        "Ready handshake disappeared during the startup stability interval"
      )
    }
    throw error
  }
  throwIfAborted(options.signal)
  return validateReadyRecord(value, expected)
}

export async function removeReadyFile(readyPath: string): Promise<void> {
  try {
    await unlink(readyPath)
  } catch (error) {
    if (!errnoIs(error, "ENOENT")) {
      throw error
    }
  }
}
