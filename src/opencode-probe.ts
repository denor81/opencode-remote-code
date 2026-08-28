import { rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  LOGGER_CHILD_ENV,
  createFileLogger,
  type FileLogger,
  type LogLevel,
} from "./logger.js"
import {
  classifyOpenCodeRuntimeObservationFailure,
  isOpenCodeVersion,
  observeOpenCodeRuntimeVersion,
  type OpenCodeRuntimeVersionSource,
} from "./opencode-runtime-version.js"

export const PROBE_PROTOCOL = "opencode-ssh-loader-probe-v3" as const
const SAFE_ERRNO_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTSUP",
  "EPERM",
  "EPIPE",
  "EROFS",
  "ETIMEDOUT",
])

export const PROBE_ENV = {
  token: "OPENCODE_SSH_PROBE_TOKEN",
  resultPath: "OPENCODE_SSH_PROBE_RESULT",
} as const

interface ProbeMarker {
  protocol: typeof PROBE_PROTOCOL
  token: string
  loaderRuntimeVersion: string
  loaderRuntimeVersionSource: OpenCodeRuntimeVersionSource
  callableSessionLookupObservedInLoaderProcess: boolean
}

export interface LoaderProbeObservation {
  loaderRuntimeVersion: string
  loaderRuntimeVersionSource: OpenCodeRuntimeVersionSource
  callableSessionLookupObservedInLoaderProcess: boolean
}

export function activateCompatibilityProbe(
  input: PluginInput,
  options: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env
): Hooks | null {
  const token = env[PROBE_ENV.token]
  if (!token || options?.compatibilityProbe !== token) return null
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("OpenCode SSH compatibility probe has an invalid token")
  }

  const resultPath = env[PROBE_ENV.resultPath]
  if (!resultPath || !path.isAbsolute(resultPath)) {
    throw new Error("OpenCode SSH compatibility probe has an invalid result path")
  }

  const diagnostics = startupDiagnostics(env)
  const activationLog = logProbe(diagnostics, "info", "probe.activation")

  const hooks: Hooks = {
    config: async () => {
      void logProbe(diagnostics, "info", "probe.config.started")
      let stage: ProbeFailureStage = "runtime-health"
      const temporaryPath = `${resultPath}.${process.pid}.tmp`
      let temporaryWritten = false
      try {
        const runtimeHealthStartedLog = logProbe(
          diagnostics,
          "info",
          "probe.runtime_health.started"
        )
        await Promise.all([activationLog, runtimeHealthStartedLog])
        // `debug config` exposes a fallback URL without an owned HTTP listener.
        const runtime = await observeOpenCodeRuntimeVersion(input, {
          allowRuntimeExecutableFallback: true,
        })
        const callableSessionLookupObservedInLoaderProcess =
          hasCallableSessionGet(input)
        void logProbe(diagnostics, "info", "probe.runtime_health.completed", {
          runtimeVersion: runtime.version,
          runtimeVersionSource: runtime.source,
          callableSessionLookup: callableSessionLookupObservedInLoaderProcess,
        })

        const marker: ProbeMarker = {
          protocol: PROBE_PROTOCOL,
          token,
          loaderRuntimeVersion: runtime.version,
          loaderRuntimeVersionSource: runtime.source,
          callableSessionLookupObservedInLoaderProcess,
        }
        stage = "marker-write"
        await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        })
        temporaryWritten = true
        stage = "marker-publication"
        void logProbe(diagnostics, "info", "probe.marker_publication.started")
        await rename(temporaryPath, resultPath)
        temporaryWritten = false
        void logProbe(diagnostics, "info", "probe.marker_publication.completed")
        void logProbe(diagnostics, "info", "probe.config.completed")
      } catch (error) {
        if (temporaryWritten) {
          await rm(temporaryPath, { force: true }).catch(() => undefined)
        }
        await logProbe(
          diagnostics,
          "error",
          "probe.config.failed",
          safeFailureFields(stage, error)
        )
        throw error
      }
    },
  }
  return hooks
}

export function parseProbeMarker(
  value: unknown,
  token: string
): LoaderProbeObservation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const marker = value as Record<string, unknown>
  const valid =
    Object.keys(marker).length === 5 &&
    marker.protocol === PROBE_PROTOCOL &&
    marker.token === token &&
    isOpenCodeVersion(marker.loaderRuntimeVersion) &&
    isRuntimeVersionSource(marker.loaderRuntimeVersionSource) &&
    typeof marker.callableSessionLookupObservedInLoaderProcess === "boolean"
  if (!valid) return null

  return {
    loaderRuntimeVersion: marker.loaderRuntimeVersion as string,
    loaderRuntimeVersionSource:
      marker.loaderRuntimeVersionSource as OpenCodeRuntimeVersionSource,
    callableSessionLookupObservedInLoaderProcess:
      marker.callableSessionLookupObservedInLoaderProcess as boolean,
  }
}

function isRuntimeVersionSource(
  value: unknown
): value is OpenCodeRuntimeVersionSource {
  return (
    value === "client.global.health" ||
    value === "client._client.get" ||
    value === "runtime-executable"
  )
}

function hasCallableSessionGet(input: PluginInput): boolean {
  const candidate = input as unknown as {
    client?: { session?: { get?: unknown } }
  }
  return typeof candidate.client?.session?.get === "function"
}

interface ProbeDiagnostics {
  logger: FileLogger
  startupID: string
}

type ProbeFailureStage =
  | "runtime-health"
  | "marker-write"
  | "marker-publication"

function startupDiagnostics(
  env: NodeJS.ProcessEnv
): ProbeDiagnostics | undefined {
  const logDirectory = env[LOGGER_CHILD_ENV.directory]
  const startupID = env[LOGGER_CHILD_ENV.startupID]
  if (
    !logDirectory ||
    !path.isAbsolute(logDirectory) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(logDirectory) ||
    !startupID ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(startupID)
  ) {
    return undefined
  }

  try {
    return { logger: createFileLogger({ logDirectory }), startupID }
  } catch {
    return undefined
  }
}

async function logProbe(
  diagnostics: ProbeDiagnostics | undefined,
  level: LogLevel,
  event: string,
  fields: Readonly<Record<string, unknown>> = {}
): Promise<boolean> {
  if (!diagnostics) return false
  try {
    return await diagnostics.logger.log({
      level,
      event,
      fields: {
        component: "compatibility-probe",
        startupID: diagnostics.startupID,
        ...fields,
      },
    })
  } catch {
    // Diagnostics must never change probe behavior.
    return false
  }
}

function safeFailureFields(
  stage: ProbeFailureStage,
  error: unknown
): Readonly<Record<string, unknown>> {
  const code = safeStartupErrorCode(error)
  return {
    stage,
    errorCategory:
      stage === "runtime-health" ? "runtime-health" : "filesystem",
    errorName: safeErrorName(error),
    ...(stage === "runtime-health" ? runtimeFailureFields(error) : {}),
    ...(code ? { errorCode: code } : {}),
  }
}

function runtimeFailureFields(error: unknown): Readonly<Record<string, string>> {
  try {
    const failureCode = classifyOpenCodeRuntimeObservationFailure(error)
    return failureCode ? { failureCode } : {}
  } catch {
    return {}
  }
}

function safeErrorName(error: unknown): string {
  let name: string
  try {
    if (!(error instanceof Error)) return "NonError"
    name = error.name
  } catch {
    return "Error"
  }
  switch (name) {
    case "AbortError":
    case "AggregateError":
    case "Error":
    case "OpenCodeHealthResponseError":
    case "OpenCodeRuntimeObservationError":
    case "ProcessError":
    case "ProcessTerminationError":
    case "RangeError":
    case "SyntaxError":
    case "TypeError":
      return name
    default:
      return "Error"
  }
}

export function safeStartupErrorCode(error: unknown): string | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return undefined
  }
  try {
    const code = Reflect.get(error, "code")
    return typeof code === "string" && SAFE_ERRNO_CODES.has(code)
      ? code
      : undefined
  } catch {
    return undefined
  }
}
