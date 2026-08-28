import fs from "node:fs/promises"
import path from "node:path"
import type { Hooks, Plugin, PluginModule, ToolDefinition } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import {
  LOGGER_CHILD_ENV,
  createFileLogger,
  type FileLogger,
  type LogLevel,
} from "./logger.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { removeReadyFile, writeReadyHandshake } from "./ready-handshake.js"
import {
  activateCompatibilityProbe,
  safeStartupErrorCode,
} from "./opencode-probe.js"
import {
  classifyOpenCodeRuntimeObservationFailure,
  observeOpenCodeRuntimeVersion,
} from "./opencode-runtime-version.js"
import { RemotePathResolver } from "./remote-path-resolver.js"
import { buildRemoteSystemContext } from "./remote-system-prompt.js"
import { quoteShell } from "./shell-quote.js"
import {
  SessionSafety,
  createTaskHooks,
  guardProjectTool,
} from "./session-safety.js"
import { createSSHPool } from "./ssh-pool.js"
import {
  applySubagentPolicy,
  type SubagentPolicy,
} from "./subagent-policy.js"
import { SyncEngine } from "./sync-engine.js"
import { TaskResumeRegistry } from "./task-resume-registry.js"
import { createBashTool } from "./tools/bash.js"
import { createEditTool } from "./tools/edit.js"
import { createGlobTool } from "./tools/glob.js"
import { createGrepTool } from "./tools/grep.js"
import { createPatchTool } from "./tools/patch.js"
import { createReadTool } from "./tools/read.js"
import { createStatusTool } from "./tools/status.js"
import { createWriteTool } from "./tools/write.js"

const launchOwners = new Map<string, symbol>()

const RemoteCodePlugin: Plugin = async (_input, options) => {
  const probe = activateCompatibilityProbe(_input, options)
  if (probe) return probe

  const config = loadConfig(options)
  if (!config) return {}
  const diagnostics = productionDiagnostics(
    process.env,
    config.launchID,
    config.targetID
  )
  void logProduction(diagnostics, "info", "plugin.production.activation")

  let stage: PluginFailureStage = "session-lookup"
  let releaseLaunch: (() => void) | undefined
  let sshPool: Awaited<ReturnType<typeof createSSHPool>> | undefined

  try {
    const callableSessionLookup = hasCallableSessionLookup(_input)
    void logProduction(
      diagnostics,
      "info",
      "plugin.session_lookup.completed",
      { callable: callableSessionLookup }
    )
    requireCallableSessionLookup(_input)

    stage = "runtime-health"
    void logProduction(diagnostics, "info", "plugin.runtime_health.started")
    const runtime = await observeOpenCodeRuntimeVersion(_input)
    void logProduction(diagnostics, "info", "plugin.runtime_health.completed", {
      runtimeVersion: runtime.version,
      runtimeVersionSource: runtime.source,
    })

    stage = "version-match"
    const runtimeVersionMatches =
      runtime.version === config.expectedOpenCodeRuntimeVersion
    void logProduction(
      diagnostics,
      "info",
      "plugin.runtime_version_match.completed",
      {
        expectedRuntimeVersion: config.expectedOpenCodeRuntimeVersion,
        observedRuntimeVersion: runtime.version,
        matches: runtimeVersionMatches,
      }
    )
    if (!runtimeVersionMatches) {
      throw new Error(
        `OpenCode SSH Task safety expected runtime version ${JSON.stringify(
          config.expectedOpenCodeRuntimeVersion
        )} but observed ${JSON.stringify(runtime.version)}`
      )
    }

    stage = "launch-claim"
    releaseLaunch = claimLaunch(config.launchID)
    void logProduction(diagnostics, "info", "plugin.launch_claim.completed")

    stage = "mirror"
    void logProduction(diagnostics, "info", "plugin.mirror.started")
    const pathMapper = new PathMapper(config)
    await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true })
    await fs.mkdir(pathMapper.mirrorBase, { recursive: true, mode: 0o700 })
    void logProduction(diagnostics, "info", "plugin.mirror.completed")

    const manifest = new ManifestManager(pathMapper)
    stage = "pool"
    void logProduction(diagnostics, "info", "plugin.pool.started")
    const activePool = await createSSHPool(config)
    sshPool = activePool
    void logProduction(diagnostics, "info", "plugin.pool.completed")
    const pathResolver = new RemotePathResolver(config.remoteWorkdir, activePool)
    const syncEngine = new SyncEngine(config, pathMapper, manifest, activePool)
    const sessionSafety = new SessionSafety(config.remoteWorkdir)
    const taskResumeRegistry = config.taskResumeEnabled
      ? new TaskResumeRegistry()
      : undefined
    const taskHooks = createTaskHooks(
      _input.client,
      sessionSafety,
      config.taskResumeEnabled,
      taskResumeRegistry
    )

    stage = "bootstrap"
    void logProduction(diagnostics, "info", "plugin.bootstrap.started")
    const platformResult = await activePool.exec("uname -s", { timeout: 5_000 })
    if (platformResult.exitCode !== 0) {
      throw new Error(`Remote uname failed: ${platformResult.stderr || platformResult.stdout}`)
    }
    const remotePlatform = platformResult.stdout.trim().toLowerCase() || "unknown"

    const gitResult = await activePool.exec(
      `git -C ${quoteShell(config.remoteWorkdir)} rev-parse --is-inside-work-tree 2>/dev/null`,
      { timeout: 5_000 }
    )
    const isGitRepo = gitResult.exitCode === 0 && gitResult.stdout.trim() === "true"

    const systemContext = await buildRemoteSystemContext({
      alias: config.alias,
      remoteWorkdir: config.remoteWorkdir,
      remotePlatform,
      isGitRepo,
      targetID: config.targetID,
      taskResumeEnabled: config.taskResumeEnabled,
    })
    void logProduction(diagnostics, "info", "plugin.bootstrap.completed")

    const readyIdentity = {
      launchID: config.launchID,
      nonce: config.readyNonce,
      alias: config.alias,
      canonicalWorkdir: config.remoteWorkdir,
      targetID: config.targetID,
    }
    let readyPublication: ReturnType<typeof writeReadyHandshake> | undefined
    let lifecycleState: PluginLifecycleState = "active"
    let disposePromise: Promise<void> | undefined
    const requireActive = (activity: string): void => {
      if (lifecycleState !== "active") {
        throw new Error(
          `OpenCode SSH plugin lifecycle is ${lifecycleState}; ${activity} is rejected`
        )
      }
    }
    const dispose = (): Promise<void> => {
      if (disposePromise) return disposePromise

      lifecycleState = "disposing"
      const poolClose = beginPoolClose(activePool)
      const errors: unknown[] = []
      try {
        taskResumeRegistry?.dispose()
      } catch (error) {
        errors.push(error)
      }

      const lifecycleDisposal = (async () => {
        try {
          // Publication cannot be canceled, so settle it before removing the marker.
          if (readyPublication) await readyPublication.catch(() => undefined)
          try {
            await removeReadyFile(config.readyPath)
          } catch (error) {
            errors.push(error)
          }
          try {
            await manifest.save()
          } catch (error) {
            errors.push(error)
          }
          const poolDisposal = await poolClose
          if (!poolDisposal.ok) errors.push(poolDisposal.error)

          if (errors.length === 1) throw errors[0]
          if (errors.length > 1) {
            throw new AggregateError(errors, "OpenCode SSH plugin disposal failed")
          }
        } finally {
          lifecycleState = "disposed"
          releaseLaunch?.()
        }
      })()
      void logProduction(diagnostics, "info", "plugin.disposal.started")
      disposePromise = lifecycleDisposal.then(
        () => {
          void logProduction(diagnostics, "info", "plugin.disposal.completed")
        },
        async (error: unknown) => {
          await logProduction(
            diagnostics,
            "error",
            "plugin.disposal.failed",
            safePluginFailureFields("disposal", error)
          )
          throw error
        }
      )
      return disposePromise
    }

    let subagentPolicy: SubagentPolicy | undefined
    const getSubagentPolicy = () => {
      if (!subagentPolicy) {
        throw new Error("OpenCode SSH subagent policy is not installed")
      }
      return subagentPolicy
    }

    const guardTool = (definition: ToolDefinition): ToolDefinition =>
      guardLifecycleTool(definition, () => requireActive("tool execution"))
    const tools = {
      bash: guardTool(
        createBashTool(
          activePool,
          config.remoteWorkdir,
          pathResolver,
          sessionSafety
        )
      ),
      glob: guardTool(
        guardProjectTool(
          createGlobTool(config, activePool, pathResolver),
          sessionSafety
        )
      ),
      grep: guardTool(
        guardProjectTool(
          createGrepTool(config, activePool, pathResolver),
          sessionSafety
        )
      ),
      read: guardTool(
        guardProjectTool(
          createReadTool(pathMapper, syncEngine, activePool, pathResolver),
          sessionSafety
        )
      ),
      write: guardTool(
        guardProjectTool(
          createWriteTool(pathMapper, syncEngine, pathResolver),
          sessionSafety
        )
      ),
      edit: guardTool(
        guardProjectTool(
          createEditTool(pathMapper, syncEngine, pathResolver),
          sessionSafety
        )
      ),
      apply_patch: guardTool(
        guardProjectTool(
          createPatchTool(config, pathMapper, syncEngine, pathResolver),
          sessionSafety
        )
      ),
      remote_status: guardTool(
        createStatusTool(
          config,
          activePool,
          getSubagentPolicy,
          (sessionID) => sessionSafety.beginStatusCheck(sessionID),
          (sessionID, attempt, result) =>
            sessionSafety.recordStatusResult(sessionID, attempt, result)
        )
      ),
    }

    let configTail: Promise<void> = Promise.resolve()
    let pendingConfigBatch: ConfigRequest[] | undefined
    const settleDisposal = (): Promise<DisposalOutcome> =>
      dispose().then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error })
      )
    const rejectConfigBatchAfterDisposal = async (
      batch: readonly ConfigRequest[],
      errors: readonly unknown[],
      beforeReject?: () => Promise<unknown>
    ): Promise<void> => {
      const disposal = await settleDisposal()
      await beforeReject?.()
      batch.forEach((request, index) => {
        request.reject(configFailure(errors[index], disposal))
      })
    }
    const processConfigBatch = async (
      batch: readonly ConfigRequest[]
    ): Promise<void> => {
      try {
        requireActive("config hook")
      } catch (error) {
        if (diagnostics) {
          await logProduction(
            diagnostics,
            "error",
            "plugin.config_validation.failed",
            {
              ...safePluginFailureFields("config-validation", error),
              requestCount: batch.length,
            }
          )
        }
        batch.forEach((request) => request.reject(error))
        return
      }

      const validationStarted = diagnostics
        ? logProduction(
            diagnostics,
            "info",
            "plugin.config_validation.started",
            { requestCount: batch.length }
          )
        : undefined
      const validations = batch.map<ConfigValidation>((request) => {
        try {
          return {
            ok: true,
            policy: applySubagentPolicy(request.resolvedConfig),
          }
        } catch (error) {
          return { ok: false, error }
        }
      })
      if (validations.some((validation) => !validation.ok)) {
        void validationStarted
        const errors = validations.map((validation) =>
          validation.ok
            ? new Error(
                "OpenCode SSH plugin lifecycle is disposed because another config in the same concurrent batch failed validation"
              )
            : validation.error
        )
        const firstFailure = validations.find(
          (validation): validation is Extract<ConfigValidation, { ok: false }> =>
            !validation.ok
        )
        await rejectConfigBatchAfterDisposal(
          batch,
          errors,
          diagnostics
            ? () =>
                logProduction(
                  diagnostics,
                  "error",
                  "plugin.config_validation.failed",
                  {
                    ...safePluginFailureFields(
                      "config-validation",
                      firstFailure?.error
                    ),
                    requestCount: batch.length,
                    invalidCount: validations.filter(
                      (validation) => !validation.ok
                    ).length,
                  }
                )
            : undefined
        )
        return
      }

      const finalValidation = validations.at(-1)!
      if (!finalValidation.ok) {
        throw new Error("OpenCode SSH internal config batch validation state was invalid")
      }
      subagentPolicy = finalValidation.policy
      let publishingReady = false
      let activeReadyPublication = readyPublication
      try {
        if (!activeReadyPublication) {
          publishingReady = true
          activeReadyPublication = writeReadyHandshake(
            config.readyPath,
            readyIdentity
          )
          readyPublication = activeReadyPublication
          void logProduction(
            diagnostics,
            "info",
            "plugin.ready_publication.started"
          )
        }
        void validationStarted
        void logProduction(
          diagnostics,
          "info",
          "plugin.config_validation.completed",
          { requestCount: batch.length }
        )
        await activeReadyPublication
        requireActive("config hook")
        batch.forEach((request) => request.resolve())
        if (publishingReady) {
          void logProduction(
            diagnostics,
            "info",
            "plugin.ready_publication.completed"
          )
        }
      } catch (error) {
        await rejectConfigBatchAfterDisposal(
          batch,
          batch.map(() => error),
          diagnostics
            ? () =>
                logProduction(
                  diagnostics,
                  "error",
                  "plugin.ready_publication.failed",
                  safePluginFailureFields("ready-publication", error)
                )
            : undefined
        )
        return
      }
    }
    const configure = (resolvedConfig: unknown): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const request = { resolvedConfig, resolve, reject }
        if (pendingConfigBatch) {
          pendingConfigBatch.push(request)
          return
        }

        const batch = [request]
        pendingConfigBatch = batch
        queueMicrotask(() => {
          pendingConfigBatch = undefined
          const operation = configTail.then(() => processConfigBatch(batch))
          configTail = operation.catch(async (error: unknown) => {
            await rejectConfigBatchAfterDisposal(
              batch,
              batch.map(() => error),
              diagnostics
                ? () =>
                    logProduction(
                      diagnostics,
                      "error",
                      "plugin.config_validation.failed",
                      {
                        ...safePluginFailureFields("config-validation", error),
                        requestCount: batch.length,
                      }
                    )
                : undefined
            )
          })
        })
      })

    const taskBefore: NonNullable<Hooks["tool.execute.before"]> = async (
      input,
      output
    ) => {
      requireActive("Task before hook")
      await taskHooks.before(input, output)
      requireActive("Task before hook")
    }
    const taskAfter: NonNullable<Hooks["tool.execute.after"]> = async (
      input,
      output
    ) => {
      requireActive("Task after hook")
      await taskHooks.after(input, output)
      requireActive("Task after hook")
    }

    stage = "hooks"
    void logProduction(diagnostics, "info", "plugin.hooks.returned")
    return {
      tool: tools,
      "tool.execute.before": taskBefore,
      "tool.execute.after": taskAfter,
      config: configure,
      dispose,
      event: async ({ event }) => {
        if (lifecycleState !== "active") return
        const permissionEvent = normalizePermissionEvent(event)
        if (permissionEvent) {
          try {
            if (permissionEvent.kind === "request") {
              taskHooks.observePermissionRequest(permissionEvent)
            } else if (permissionEvent.kind === "reply") {
              taskHooks.observePermissionReply(permissionEvent)
            } else {
              taskHooks.invalidateSessionSecurity(permissionEvent.sessionID)
            }
          } catch {
            try {
              taskHooks.invalidateSessionSecurity(permissionEvent.sessionID)
            } catch {
              // Permission delivery is fire-and-forget; remain fail-closed without rejection.
            }
          }
          return
        }
        if (event.type === "session.deleted") {
          taskHooks.invalidateSessionSecurity(event.properties.info.id)
          sessionSafety.clearSession(event.properties.info.id)
          taskResumeRegistry?.clearSession(event.properties.info.id)
          // Active deletion keeps manifest I/O failures on the returned hook promise.
          await manifest.save()
        }
      },
      "experimental.chat.system.transform": async (_input, output) => {
        requireActive("system hook")
        output.system.push(systemContext)
      },
    }
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (sshPool) {
      try {
        await sshPool.close()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    releaseLaunch?.()
    await logProduction(
      diagnostics,
      "error",
      "plugin.initialization.failed",
      {
        ...safePluginFailureFields(stage, error),
        cleanupFailureCount: cleanupErrors.length,
      }
    )
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "OpenCode SSH plugin initialization and cleanup failed",
        { cause: error }
      )
    }
    throw error
  }
}

type PluginLifecycleState = "active" | "disposing" | "disposed"

interface ProductionDiagnostics {
  launchID: string
  logger: FileLogger
  startupID: string
  targetID: string
}

type PluginFailureStage =
  | "session-lookup"
  | "runtime-health"
  | "version-match"
  | "launch-claim"
  | "mirror"
  | "pool"
  | "bootstrap"
  | "hooks"
  | "config-validation"
  | "ready-publication"
  | "disposal"

interface ConfigRequest {
  resolvedConfig: unknown
  resolve: () => void
  reject: (error: unknown) => void
}

type ConfigValidation =
  | { ok: true; policy: SubagentPolicy }
  | { ok: false; error: unknown }

type DisposalOutcome = { ok: true } | { ok: false; error: unknown }

type NormalizedPermissionEvent =
  | {
      kind: "request"
      sessionID: string
      permissionID: string
      permission: string
    }
  | { kind: "reply"; sessionID: string; permissionID: string }
  | { kind: "invalidate"; sessionID: string }

function configFailure(primary: unknown, disposal: DisposalOutcome): unknown {
  if (disposal.ok) return primary
  return new AggregateError(
    [primary, disposal.error],
    "OpenCode SSH policy installation and cleanup failed",
    { cause: primary }
  )
}

function beginPoolClose(
  pool: Awaited<ReturnType<typeof createSSHPool>>
): Promise<DisposalOutcome> {
  try {
    return pool.close().then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error })
    )
  } catch (error) {
    return Promise.resolve({ ok: false, error })
  }
}

function normalizePermissionEvent(event: unknown): NormalizedPermissionEvent | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined
  if (
    event.type !== "permission.asked" &&
    event.type !== "permission.updated" &&
    event.type !== "permission.replied"
  ) {
    return undefined
  }
  if (!isRecord(event.properties)) return undefined

  const sessionID = nonEmptyString(event.properties.sessionID)
  if (!sessionID) return undefined
  if (event.type === "permission.replied") {
    const requestID = nonEmptyString(
      Object.hasOwn(event.properties, "requestID")
        ? event.properties.requestID
        : event.properties.permissionID
    )
    return requestID
      ? { kind: "reply", sessionID, permissionID: requestID }
      : { kind: "invalidate", sessionID }
  }

  const requestID = nonEmptyString(event.properties.id)
  const permission = nonEmptyString(
    event.type === "permission.asked"
      ? event.properties.permission
      : event.properties.type
  )
  return requestID && permission
    ? { kind: "request", sessionID, permissionID: requestID, permission }
    : { kind: "invalidate", sessionID }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function productionDiagnostics(
  env: NodeJS.ProcessEnv,
  launchID: string,
  targetID: string
): ProductionDiagnostics | undefined {
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
    return {
      launchID,
      logger: createFileLogger({ logDirectory }),
      startupID,
      targetID,
    }
  } catch {
    return undefined
  }
}

async function logProduction(
  diagnostics: ProductionDiagnostics | undefined,
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
        ...fields,
        component: "server-plugin",
        startupID: diagnostics.startupID,
        launchID: diagnostics.launchID,
        targetID: diagnostics.targetID,
      },
    })
  } catch {
    // Diagnostics must never change plugin behavior.
    return false
  }
}

function safePluginFailureFields(
  stage: PluginFailureStage,
  error: unknown
): Readonly<Record<string, unknown>> {
  const code =
    safeStartupErrorCode(error) ?? safeStartupErrorCode(errorCause(error))
  return {
    stage,
    errorCategory: pluginFailureCategory(stage),
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

function pluginFailureCategory(stage: PluginFailureStage): string {
  switch (stage) {
    case "session-lookup":
    case "version-match":
      return "compatibility"
    case "runtime-health":
      return "runtime-health"
    case "launch-claim":
      return "ownership"
    case "mirror":
    case "ready-publication":
      return "filesystem"
    case "pool":
    case "bootstrap":
      return "ssh"
    case "hooks":
      return "initialization"
    case "config-validation":
      return "configuration"
    case "disposal":
      return "cleanup"
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
    case "SSHPoolClosedError":
    case "SyntaxError":
    case "TypeError":
      return name
    default:
      return "Error"
  }
}

function errorCause(error: unknown): unknown {
  try {
    return error instanceof Error ? error.cause : undefined
  } catch {
    return undefined
  }
}

function hasCallableSessionLookup(input: unknown): boolean {
  const candidate = input as {
    client?: { session?: { get?: unknown } }
  }
  return typeof candidate.client?.session?.get === "function"
}

function requireCallableSessionLookup(input: unknown): void {
  if (!hasCallableSessionLookup(input)) {
    throw new Error(
      "OpenCode SSH Task safety requires OpenCode client.session.get to be callable before plugin initialization"
    )
  }
}

function guardLifecycleTool(
  definition: ToolDefinition,
  requireActive: () => void
): ToolDefinition {
  const execute = definition.execute
  return {
    ...definition,
    async execute(this: unknown, args, context) {
      requireActive()
      return await execute.call(this, args, context)
    },
  }
}

function claimLaunch(launchID: string): () => void {
  if (launchOwners.has(launchID)) {
    throw new Error(`OpenCode SSH launch ${JSON.stringify(launchID)} is already active`)
  }

  const owner = Symbol(launchID)
  launchOwners.set(launchID, owner)
  let released = false
  return () => {
    if (released) return
    released = true
    if (launchOwners.get(launchID) === owner) launchOwners.delete(launchID)
  }
}

export default {
  id: "opencode-ssh",
  server: RemoteCodePlugin,
} satisfies PluginModule
