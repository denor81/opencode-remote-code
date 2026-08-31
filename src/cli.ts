#!/usr/bin/env node

import { randomBytes } from "node:crypto"
import { realpath, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { REMOTE_ENV } from "./config.js"
import {
  LauncherConfigError,
  mergeOpenCodeConfigContent,
  parseCli,
} from "./launcher-config.js"
import {
  LOGGER_CHILD_ENV,
  createFileLogger,
  resolveDailyLogFilePath,
  resolveDefaultLogDirectory,
  type FileLogger,
  type LogLevel,
} from "./logger.js"
import {
  runOpenCodeCompatibilityCheck,
  type OpenCodeCompatibilityHooks,
} from "./opencode-compatibility.js"
import { safeStartupErrorCode } from "./opencode-probe.js"
import { readPackageMetadata } from "./package-metadata.js"
import { spawnManaged, type ManagedProcess, type ProcessResult } from "./process.js"
import {
  confirmReadyHandshakeStability,
  removeReadyFile,
  ReadyHandshakeTimeoutError,
  waitForReadyHandshake,
  type ReadyHandshakeIdentity,
} from "./ready-handshake.js"
import {
  createLaunchPaths,
  createRuntimePaths,
  resolveRuntimePaths,
} from "./runtime-paths.js"
import { SshClient } from "./ssh/client.js"
import { ControlMaster } from "./ssh/control-master.js"
import type { ControlMasterDiagnostic } from "./ssh/diagnostics.js"
import {
  TASK_RESUME_PROTOCOL,
  type TaskResumeCapability,
} from "./task-resume-capability.js"

const HELP = `Usage: opencode-ssh <ssh-alias> <absolute-remote-workdir>
       opencode-ssh self-test

Run the local OpenCode TUI while bash, read, write, edit, glob, grep, and
apply_patch operate through the named system OpenSSH host.

Examples:
  opencode-ssh staging /srv/app
  opencode-ssh admin-host /
`

const SAFETY_INSTRUCTIONS_PATH = fileURLToPath(
  new URL("../opencode-ssh-remote-use/opencode-ssh-safety.md", import.meta.url)
)
const PACKAGE_ROOT_URL = new URL("../", import.meta.url)
const MASTER_DIAGNOSTIC_LIMIT = 64

interface Ready {
  kind: "ready"
}

type PreReadyCompletion =
  | Ready
  | { kind: "opencode"; result: ProcessResult }
  | { kind: "master"; result: ProcessResult }

export const LAUNCHER_CLEANUP_STEPS = [
  "opencode",
  "ready-marker",
  "mirror",
  "master",
  "socket",
  "listeners",
] as const

export type LauncherCleanupStep = (typeof LAUNCHER_CLEANUP_STEPS)[number]

export interface LauncherCleanupFailure {
  step: LauncherCleanupStep
  error: unknown
}

export type LauncherCleanupOperations = Partial<
  Record<LauncherCleanupStep, () => void | Promise<void>>
>

export interface LauncherDiagnosticsContext {
  logDirectory: string
  startupID: string
}

export interface LauncherHooks extends OpenCodeCompatibilityHooks {
  onDiagnosticsAvailable?: (context: LauncherDiagnosticsContext) => void
}

export async function runLauncherCleanup(
  operations: LauncherCleanupOperations
): Promise<LauncherCleanupFailure[]> {
  const failures: LauncherCleanupFailure[] = []
  for (const step of LAUNCHER_CLEANUP_STEPS) {
    const operation = operations[step]
    if (!operation) continue
    try {
      await operation()
    } catch (error) {
      failures.push({ step, error })
    }
  }
  return failures
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  compatibilityHooks: LauncherHooks = {}
): Promise<number> {
  const parsed = parseCli(argv)
  if (parsed.action === "help") {
    process.stdout.write(HELP)
    return 0
  }
  if (parsed.action === "version") {
    process.stdout.write(`${(await readPackageMetadata()).version}\n`)
    return 0
  }

  const diagnostics = createLauncherDiagnostics(
    env,
    compatibilityHooks.onDiagnosticsAvailable
  )
  const startupLog = logLauncher(diagnostics, "info", "startup.begin", {
    action: parsed.action,
  })
  await startupLog
  if (parsed.action === "launch" && /^(1|true)$/i.test(env.OPENCODE_PURE ?? "")) {
    const error = new LauncherConfigError(
      "OPENCODE_PURE=1 disables external plugins and cannot be used with opencode-ssh"
    )
    await logLauncher(
      diagnostics,
      "error",
      "launch.failed",
      safeLauncherFailureFields("configuration", error)
    )
    throw error
  }

  const controller = new AbortController()
  let receivedSignal: NodeJS.Signals | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    receivedSignal ??= signal
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Received ${signal}`))
    }
  }
  const onSigint = () => onSignal("SIGINT")
  const onSigterm = () => onSignal("SIGTERM")
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)

  let master: ControlMaster | undefined
  let openCode: ManagedProcess | undefined
  let readyPath: string | undefined
  let socketPath: string | undefined
  let mirrorPath: string | undefined
  let diagnosticLaunchID: string | undefined
  let diagnosticTargetID: string | undefined
  let stage: LauncherFailureStage = "compatibility"
  let masterDiagnosticCount = 0
  let masterDiagnosticsLimited = false
  const onMasterDiagnostic = (
    diagnostic: ControlMasterDiagnostic
  ): boolean | void => {
    if (masterDiagnosticCount >= MASTER_DIAGNOSTIC_LIMIT) {
      if (!masterDiagnosticsLimited) {
        masterDiagnosticsLimited = true
        void logLauncher(
          diagnostics,
          "warn",
          "ssh.master.diagnostics_limited",
          { reason: "event-limit", phase: stage },
          diagnosticLaunchID,
          diagnosticTargetID
        )
      }
      return false
    }

    masterDiagnosticCount++
    const event =
      diagnostic.kind === "channel-open-failed"
        ? "ssh.master.channel_open.failed"
        : "ssh.master.diagnostic"
    const fields =
      diagnostic.kind === "channel-open-failed"
        ? { reason: diagnostic.reason, phase: stage }
        : { category: diagnostic.category, phase: stage }
    void logLauncher(
      diagnostics,
      "warn",
      event,
      fields,
      diagnosticLaunchID,
      diagnosticTargetID
    )
  }

  let signalExitCode: 130 | 143 | undefined
  const execute = async (): Promise<number> => {
    const opencodeBinary = env.OPENCODE_SSH_OPENCODE_BIN || "opencode"
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const compatibility = await runOpenCodeCompatibilityCheck({
      binary: opencodeBinary,
      env,
      signal: controller.signal,
      testedVersion: testedOpenCodeVersion,
      pluginURL: PACKAGE_ROOT_URL,
      diagnostics: diagnostics.logDirectory
        ? {
            logger: diagnostics.logger,
            logDirectory: diagnostics.logDirectory,
            onWrite: () => markDiagnosticsAvailable(diagnostics),
            startupID: diagnostics.startupID,
          }
        : undefined,
      writeProgress: compatibilityHooks.writeProgress,
      writeWarning: compatibilityHooks.writeWarning,
    })
    const taskResumeCapability: TaskResumeCapability | undefined =
      compatibility.taskResumeSupported ? TASK_RESUME_PROTOCOL : undefined
    if (parsed.action === "self-test") {
      compatibilityHooks.writeProgress?.(
        `self-test passed (OpenCode ${compatibility.detectedVersion}; Task resume ${compatibility.taskResumeSupported ? "enabled" : "disabled"})`
      )
      return 0
    }

    stage = "launch-paths"
    const launchPaths = await createLaunchPaths({ env })
    diagnosticLaunchID = launchPaths.launchID
    await logLauncher(
      diagnostics,
      "info",
      "launch.context.created",
      {},
      diagnosticLaunchID
    )
    socketPath = launchPaths.socketPath
    const sshBinary = env.OPENCODE_SSH_SSH_BIN || "ssh"
    const sftpBinary = env.OPENCODE_SSH_SFTP_BIN || "sftp"

    stage = "ssh-master"
    compatibilityHooks.writeProgress?.("starting SSH session...")
    await logLauncher(
      diagnostics,
      "info",
      "ssh.master.starting",
      {},
      diagnosticLaunchID
    )
    const launchMaster = await ControlMaster.start(
      parsed.alias,
      launchPaths.socketPath,
      controller.signal,
      {
        sshBinary,
        env,
        startupTimeoutMs: 120_000,
        onDiagnostic: onMasterDiagnostic,
      }
    )
    master = launchMaster
    await logLauncher(
      diagnostics,
      "info",
      "ssh.master.started",
      {},
      diagnosticLaunchID
    )
    const masterCompletion = launchMaster
      .wait()
      .then((result) => ({ kind: "master" as const, result }))

    const ssh = new SshClient(parsed.alias, launchPaths.socketPath, {
      sshBinary,
      env,
    })
    stage = "canonicalization"
    await logLauncher(
      diagnostics,
      "info",
      "ssh.canonicalization.started",
      {},
      diagnosticLaunchID
    )
    const canonicalization = await Promise.race([
      masterCompletion,
      ssh
        .canonicalizeWorkdir(parsed.workdir, controller.signal)
        .then((workdir) => ({ kind: "workdir" as const, workdir })),
    ])
    if (canonicalization.kind === "master") {
      if (!controller.signal.aborted) {
        controller.abort(masterBeforeReadyError(canonicalization.result))
      }
      throw masterBeforeReadyError(canonicalization.result)
    }
    const canonicalWorkdir = canonicalization.workdir
    await logLauncher(
      diagnostics,
      "info",
      "ssh.canonicalization.completed",
      {},
      diagnosticLaunchID
    )
    stage = "target-resolution"
    const runtimePathOptions = {
      alias: parsed.alias,
      canonicalWorkdir,
      launchID: launchPaths.launchID,
      env,
    }
    const resolvedPaths = resolveRuntimePaths(runtimePathOptions)
    diagnosticTargetID = resolvedPaths.targetID
    await logLauncher(
      diagnostics,
      "info",
      "target.resolved",
      {},
      diagnosticLaunchID,
      diagnosticTargetID
    )
    readyPath = resolvedPaths.readyPath
    mirrorPath = resolvedPaths.mirrorDir
    const paths = await createRuntimePaths(runtimePathOptions)
    await removeReadyFile(paths.readyPath)
    if (launchMaster.hasExited) {
      throw masterBeforeReadyError(await launchMaster.wait())
    }

    const nonce = randomBytes(32).toString("hex")
    const identity: ReadyHandshakeIdentity = {
      launchID: paths.launchID,
      nonce,
      alias: parsed.alias,
      canonicalWorkdir,
      targetID: paths.targetID,
    }
    // Loading the package root lets OpenCode select the ./server export and
    // skip this server-only plugin in the TUI plugin runtime.
    const configContent = mergeOpenCodeConfigContent(
      env.OPENCODE_CONFIG_CONTENT,
      PACKAGE_ROOT_URL,
      paths.launchID,
      SAFETY_INSTRUCTIONS_PATH,
      compatibility.loaderRuntimeVersion,
      taskResumeCapability
    )
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      PWD: paths.workspaceDir,
      OPENCODE_CONFIG_CONTENT: configContent,
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
      [REMOTE_ENV.alias]: parsed.alias,
      [REMOTE_ENV.workdir]: canonicalWorkdir,
      [REMOTE_ENV.socket]: paths.socketPath,
      [REMOTE_ENV.targetID]: paths.targetID,
      [REMOTE_ENV.launchID]: paths.launchID,
      [REMOTE_ENV.readyPath]: paths.readyPath,
      [REMOTE_ENV.readyNonce]: nonce,
      [REMOTE_ENV.runtimeDir]: paths.runtimeDir,
      [REMOTE_ENV.mirrorRoot]: paths.mirrorDir,
      [REMOTE_ENV.sshBinary]: sshBinary,
      [REMOTE_ENV.sftpBinary]: sftpBinary,
    }
    delete childEnv[LOGGER_CHILD_ENV.directory]
    delete childEnv[LOGGER_CHILD_ENV.startupID]
    if (diagnostics.logDirectory) {
      childEnv[LOGGER_CHILD_ENV.directory] = diagnostics.logDirectory
      childEnv[LOGGER_CHILD_ENV.startupID] = diagnostics.startupID
    }
    delete childEnv[REMOTE_ENV.expectedOpenCodeRuntimeVersion]
    delete childEnv[REMOTE_ENV.taskResumeCapability]
    childEnv[REMOTE_ENV.expectedOpenCodeRuntimeVersion] =
      compatibility.loaderRuntimeVersion
    if (taskResumeCapability) {
      childEnv[REMOTE_ENV.taskResumeCapability] = taskResumeCapability
    }

    stage = "opencode-host"
    await logLauncher(
      diagnostics,
      "info",
      "opencode.host.starting",
      {},
      diagnosticLaunchID,
      diagnosticTargetID
    )
    const launchedOpenCode = spawnManaged(opencodeBinary, [], {
      cwd: paths.workspaceDir,
      env: childEnv,
      signal: controller.signal,
      terminationMode: "process-group",
      stdio: { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    })
    openCode = launchedOpenCode
    await logLauncher(
      diagnostics,
      "info",
      "opencode.host.started",
      {},
      diagnosticLaunchID,
      diagnosticTargetID
    )

    const readinessController = new AbortController()
    const readinessSignal = AbortSignal.any([
      controller.signal,
      readinessController.signal,
    ])
    const openCodeCompletion = launchedOpenCode
      .wait()
      .then((result) => ({ kind: "opencode" as const, result }))
    stage = "ready-wait"
    await logLauncher(
      diagnostics,
      "info",
      "ready.wait.started",
      {},
      diagnosticLaunchID,
      diagnosticTargetID
    )
    const first = await Promise.race<PreReadyCompletion>([
      masterCompletion,
      openCodeCompletion,
      waitForReadyHandshake(paths.readyPath, identity, {
        timeoutMs: 30_000,
        signal: readinessSignal,
      }).then(() => ({ kind: "ready" as const })),
    ]).finally(() => readinessController.abort())
    if (first.kind === "master") {
      throw masterBeforeReadyError(first.result)
    }
    if (first.kind === "opencode") {
      try {
        await waitForReadyHandshake(paths.readyPath, identity, {
          timeoutMs: 0,
          signal: controller.signal,
        })
      } catch (error) {
        if (!(error instanceof ReadyHandshakeTimeoutError)) throw error
        throw new Error(
          `OpenCode exited before the remote plugin became ready (${describeExit(first.result)})`
        )
      }
    }
    void logLauncher(
      diagnostics,
      "info",
      "ready.observed",
      {},
      diagnosticLaunchID,
      diagnosticTargetID
    )

    stage = "ready-stability"
    const readinessBoundary = await Promise.race([
      masterCompletion,
      confirmReadyHandshakeStability(paths.readyPath, identity, {
        signal: controller.signal,
      }).then(
        () => ({ kind: "stable" as const }),
        (error: unknown) => ({ kind: "readiness-error" as const, error })
      ),
    ])
    if (readinessBoundary.kind === "master") {
      throw masterBeforeReadyError(readinessBoundary.result)
    }
    if (readinessBoundary.kind === "readiness-error") {
      if (launchMaster.hasExited) {
        throw masterBeforeReadyError(await launchMaster.wait())
      }
      throw readinessBoundary.error
    }
    if (launchMaster.hasExited) {
      throw masterBeforeReadyError(await launchMaster.wait())
    }
    void logLauncher(
      diagnostics,
      "info",
      "ready.stable",
      {},
      diagnosticLaunchID,
      diagnosticTargetID
    )

    stage = "active"
    void logLauncher(
      diagnostics,
      "info",
      "launch.active",
      {},
      diagnosticLaunchID,
      diagnosticTargetID
    )
    const active = await Promise.race<
      | { kind: "opencode"; result: ProcessResult }
      | { kind: "master"; result: ProcessResult }
    >([
      masterCompletion,
      openCodeCompletion,
    ])
    if (active.kind === "master" && !controller.signal.aborted) {
      throw new Error(
        `SSH ControlMaster exited while OpenCode was running (${describeExit(active.result)})`
      )
    }
    const result =
      active.kind === "opencode" ? active.result : await launchedOpenCode.wait()
    void logLauncher(
      diagnostics,
      "info",
      "opencode.host.exited",
      {
        exitCode: result.exitCode,
        signal: result.signal,
        termination: result.termination,
      },
      diagnosticLaunchID,
      diagnosticTargetID
    )
    if (receivedSignal === "SIGINT") {
      signalExitCode = 130
      return signalExitCode
    }
    if (receivedSignal === "SIGTERM") {
      signalExitCode = 143
      return signalExitCode
    }
    if (result.signal === "SIGINT") {
      signalExitCode = 130
      return signalExitCode
    }
    if (result.signal === "SIGTERM") {
      signalExitCode = 143
      return signalExitCode
    }
    return result.exitCode ?? 1
  }

  let exitCode: number | undefined
  let primaryError: unknown
  let failureStage: LauncherFailureStage | undefined
  let failed = false
  try {
    exitCode = await execute()
  } catch (error) {
    failed = true
    primaryError = error
    failureStage = stage
  }

  stage = "cleanup"
  const cleanupPromise = runLauncherCleanup({
    opencode: openCode
      ? async () => {
          await openCode!.terminate()
        }
      : undefined,
    "ready-marker": readyPath
      ? () => removeReadyFile(readyPath!)
      : undefined,
    mirror: mirrorPath
      ? () => rm(mirrorPath!, { recursive: true, force: true })
      : undefined,
    master: master ? () => master!.close() : undefined,
    socket: socketPath ? () => rm(socketPath!, { force: true }) : undefined,
    listeners: () => {
      process.removeListener("SIGINT", onSigint)
      process.removeListener("SIGTERM", onSigterm)
    },
  })
  void logLauncher(
    diagnostics,
    "info",
    "launch.cleanup.started",
    {},
    diagnosticLaunchID,
    diagnosticTargetID
  )
  const cleanupFailures = await cleanupPromise
  const cleanupLog = logLauncher(
    diagnostics,
    cleanupFailures.length === 0 ? "info" : "error",
    "launch.cleanup.completed",
    {
      failureCount: cleanupFailures.length,
      failedSteps: cleanupFailures.map(({ step }) => step),
      ...(cleanupFailures[0]
        ? safeLauncherFailureFields("cleanup", cleanupFailures[0].error)
        : {}),
    },
    diagnosticLaunchID,
    diagnosticTargetID
  )
  if (cleanupFailures.length > 0) await cleanupLog
  else void cleanupLog

  const receivedSignalCode =
    receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : undefined
  const preservedSignalCode = receivedSignalCode ?? signalExitCode
  if (preservedSignalCode !== undefined) {
    if (cleanupFailures.length > 0) {
      reportCleanupWarning(compatibilityHooks, receivedSignal, cleanupFailures)
    }
    void logLauncher(
      diagnostics,
      "info",
      parsed.action === "launch" ? "launch.exit" : "startup.exit",
      { outcome: "signal", exitCode: preservedSignalCode },
      diagnosticLaunchID,
      diagnosticTargetID
    )
    return preservedSignalCode
  }

  if (cleanupFailures.length > 0) {
    const failure = failed ? primaryError : cleanupFailures[0]?.error
    await logLauncher(
      diagnostics,
      "error",
      parsed.action === "launch" ? "launch.failed" : "startup.failed",
      {
        ...safeLauncherFailureFields(failureStage ?? "cleanup", failure),
        cleanupFailureCount: cleanupFailures.length,
      },
      diagnosticLaunchID,
      diagnosticTargetID
    )
    throw launcherCleanupError(cleanupFailures, failed ? primaryError : undefined, failed)
  }
  if (failed) {
    await logLauncher(
      diagnostics,
      "error",
      parsed.action === "launch" ? "launch.failed" : "startup.failed",
      safeLauncherFailureFields(failureStage ?? "active", primaryError),
      diagnosticLaunchID,
      diagnosticTargetID
    )
    throw primaryError
  }

  const completedExitCode = exitCode ?? 1
  void logLauncher(
    diagnostics,
    "info",
    parsed.action === "launch" ? "launch.exit" : "startup.exit",
    { outcome: "completed", exitCode: completedExitCode },
    diagnosticLaunchID,
    diagnosticTargetID
  )
  return completedExitCode
}

interface LauncherDiagnostics {
  logger: FileLogger
  logDirectory?: string
  onDiagnosticsAvailable?: (context: LauncherDiagnosticsContext) => void
  reportedAvailable: boolean
  startupID: string
}

type LauncherFailureStage =
  | "configuration"
  | "compatibility"
  | "launch-paths"
  | "ssh-master"
  | "canonicalization"
  | "target-resolution"
  | "opencode-host"
  | "ready-wait"
  | "ready-stability"
  | "active"
  | "cleanup"

const NOOP_LOGGER: FileLogger = {
  async log() {
    return false
  },
}

function createLauncherDiagnostics(
  env: NodeJS.ProcessEnv,
  onDiagnosticsAvailable: LauncherHooks["onDiagnosticsAvailable"]
): LauncherDiagnostics {
  let startupID: string
  try {
    startupID = randomBytes(16).toString("hex")
  } catch {
    return {
      logger: NOOP_LOGGER,
      onDiagnosticsAvailable,
      reportedAvailable: false,
      startupID: "unavailable",
    }
  }

  try {
    const logDirectory = resolveDefaultLogDirectory({ env })
    return {
      logger: createFileLogger({ env }),
      logDirectory,
      onDiagnosticsAvailable,
      reportedAvailable: false,
      startupID,
    }
  } catch {
    return {
      logger: NOOP_LOGGER,
      onDiagnosticsAvailable,
      reportedAvailable: false,
      startupID,
    }
  }
}

async function logLauncher(
  diagnostics: LauncherDiagnostics,
  level: LogLevel,
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
  launchID?: string,
  targetID?: string
): Promise<boolean> {
  try {
    const written = await diagnostics.logger.log({
      level,
      event,
      fields: {
        ...fields,
        component: "launcher",
        startupID: diagnostics.startupID,
        ...(launchID ? { launchID } : {}),
        ...(targetID ? { targetID } : {}),
      },
    })
    if (written) markDiagnosticsAvailable(diagnostics)
    return written
  } catch {
    // Diagnostics must never change launcher behavior.
    return false
  }
}

function markDiagnosticsAvailable(diagnostics: LauncherDiagnostics): void {
  if (diagnostics.reportedAvailable || !diagnostics.logDirectory) return
  diagnostics.reportedAvailable = true
  try {
    diagnostics.onDiagnosticsAvailable?.({
      logDirectory: diagnostics.logDirectory,
      startupID: diagnostics.startupID,
    })
  } catch {
    // Availability reporting is best-effort diagnostics only.
  }
}

function safeLauncherFailureFields(
  stage: LauncherFailureStage,
  error: unknown
): Readonly<Record<string, unknown>> {
  const code =
    safeStartupErrorCode(error) ?? safeStartupErrorCode(errorCause(error))
  return {
    stage,
    errorCategory: launcherFailureCategory(stage),
    errorName: safeErrorName(error),
    ...(code ? { errorCode: code } : {}),
  }
}

function launcherFailureCategory(stage: LauncherFailureStage): string {
  switch (stage) {
    case "configuration":
      return "configuration"
    case "compatibility":
      return "compatibility"
    case "launch-paths":
    case "target-resolution":
      return "filesystem"
    case "ssh-master":
    case "canonicalization":
      return "ssh"
    case "opencode-host":
      return "process"
    case "ready-wait":
    case "ready-stability":
      return "readiness"
    case "active":
      return "runtime"
    case "cleanup":
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
    case "ControlMasterError":
    case "Error":
    case "LauncherConfigError":
    case "OpenCodeHealthResponseError":
    case "ProcessError":
    case "ProcessTerminationError":
    case "RangeError":
    case "ReadyHandshakeTimeoutError":
    case "ReadyHandshakeValidationError":
    case "SshClientError":
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

function currentLogFilePath(context: LauncherDiagnosticsContext): string {
  return resolveDailyLogFilePath({ logDirectory: context.logDirectory })
}

function masterBeforeReadyError(result: ProcessResult): Error {
  return new Error(
    `SSH ControlMaster exited before the remote plugin became ready (${describeExit(result)})`
  )
}

function launcherCleanupError(
  failures: readonly LauncherCleanupFailure[],
  primaryError: unknown,
  hasPrimaryError: boolean
): AggregateError {
  const cleanupErrors = failures.map(
    ({ step, error }) =>
      new Error(`${step} cleanup failed: ${errorMessage(error)}`, { cause: error })
  )
  const detail = failures
    .map(({ step, error }) => `${step}: ${errorMessage(error)}`)
    .join("; ")
  if (hasPrimaryError) {
    return new AggregateError(
      [primaryError, ...cleanupErrors],
      `${errorMessage(primaryError)}; OpenCode SSH cleanup also failed: ${detail}`,
      { cause: primaryError }
    )
  }
  return new AggregateError(cleanupErrors, `OpenCode SSH cleanup failed: ${detail}`)
}

function reportCleanupWarning(
  hooks: OpenCodeCompatibilityHooks,
  signal: NodeJS.Signals | undefined,
  failures: readonly LauncherCleanupFailure[]
): void {
  const detail = failures
    .map(({ step, error }) => `${step}: ${errorMessage(error)}`)
    .join("; ")
  const report = hooks.writeWarning ?? hooks.writeProgress
  try {
    report?.(`cleanup after ${signal ?? "signal termination"} was incomplete: ${detail}`)
  } catch {
    // Reporting must not replace the signal-derived exit status.
  }
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return "Unknown error"
  }
}

function describeExit(result: ProcessResult): string {
  if (result.signal) return `signal ${result.signal}`
  if (result.termination) return result.termination
  return `exit code ${result.exitCode ?? "unknown"}`
}

async function main(): Promise<void> {
  let diagnostics: LauncherDiagnosticsContext | undefined
  try {
    process.exitCode = await runCli(process.argv.slice(2), process.env, {
      onDiagnosticsAvailable: (context) => {
        diagnostics = context
      },
      writeProgress: (message) => process.stderr.write(`opencode-ssh: ${message}\n`),
      writeWarning: (message) => process.stderr.write(`opencode-ssh: warning: ${message}\n`),
    })
  } catch (error) {
    const message = errorMessage(error)
    process.stderr.write(`opencode-ssh: ${message}\n`)
    if (diagnostics) {
      try {
        process.stderr.write(
          `opencode-ssh: diagnostics: ${currentLogFilePath(diagnostics)} (startupID ${diagnostics.startupID})\n`
        )
      } catch {
        // Resolving or reporting diagnostics must not replace the launch error.
      }
    }
    process.exitCode = 1
  }
}

async function isEntryPoint(): Promise<boolean> {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(await realpath(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
}

if (await isEntryPoint()) await main()
