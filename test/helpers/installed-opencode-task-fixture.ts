import { constants, accessSync, realpathSync, watch, type FSWatcher } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import { REMOTE_ENV } from "../../src/config.js"
import {
  spawnManaged,
  spawnProcess,
  type ManagedProcess,
  type ProcessResult,
} from "../../src/process.js"
import {
  READY_PROTOCOL,
  validateReadyRecord,
  type ReadyHandshakeIdentity,
  type ReadyRecord,
} from "../../src/ready-handshake.js"
import { computeTargetID } from "../../src/runtime-paths.js"
import { TASK_RESUME_PROTOCOL } from "../../src/task-resume-capability.js"
import {
  startScriptedOpenAIProvider,
  type ScriptedOpenAIProvider,
  type ScriptedProviderStep,
} from "./scripted-openai-provider.js"

const packageRoot = fileURLToPath(new URL("../../", import.meta.url))
const productionCli = path.join(packageRoot, "dist", "cli.js")
const fakeOpenCode = fileURLToPath(
  new URL("../fixtures/bin/opencode-debug", import.meta.url)
)
const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const STARTUP_TIMEOUT_MS = 75_000
const READY_TIMEOUT_MS = 30_000
const CLIENT_DISPOSE_TIMEOUT_MS = 6_000
const PROCESS_TREE_SETTLEMENT_TIMEOUT_MS = 10_000
const LAUNCHER_FALLBACK_TIMEOUT_MS = 5_000
const PROVIDER_CLOSE_TIMEOUT_MS = 5_000
const ROOT_REMOVAL_TIMEOUT_MS = 5_000
const MAX_DIAGNOSTIC_CHARACTERS = 8_192
const OPEN_CODE_FAILURE_DIAGNOSTIC = ".opencode-debug-failure.json"
const OPEN_CODE_CHILD_PROVENANCE = ".opencode-debug-child.json"
const TASK_TEST_BINARY_ENV = "OPENCODE_TASK_TEST_BINARY"
const TASK_TEST_EXPECTED_VERSION_ENV = "OPENCODE_TASK_TEST_EXPECTED_VERSION"
const reportedProvenance = new Set<string>()

export const TASK_FIXTURE_ALIAS = "task-harness.invalid"
export const TASK_FIXTURE_REQUESTED_WORKDIR = "/srv/opencode-task-link"
export const TASK_FIXTURE_WORKDIR = "/srv/opencode-task-fixture"
export const TASK_FIXTURE_PROVIDER_ID = "scripted"
export const TASK_FIXTURE_MODEL_ID = "task-model"
export const LOCAL_EXECUTION_CANARY = "LOCAL_EXECUTION_CANARY"
export const SSH_FIXTURE_CHILD_OUTPUT = "REMOTE_CHILD_CANARY\n"
export const REMOTE_AGENTS_MARKER = "REMOTE_AGENTS_TASK2_MARKER"

export type InstalledOpenCodeAvailability =
  | {
      kind: "available"
      binary: string
      commandDirectory: string
      originalCommandPath: string
      resolvedExecutable: string
      expectedVersion: string | undefined
      required: boolean
    }
  | { kind: "absent"; reason: string; required: boolean }

export interface InstalledOpenCodeProvenance {
  readonly originalCommandPath: string
  readonly resolvedExecutable: string
  readonly reportedVersion: string
  readonly probeChildExecutable: string
  readonly serveChildExecutable: string
}

export interface InstalledOpenCodeConfigOverride {
  readonly subagent_depth?: number
  readonly agent?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly permission?: Readonly<Record<string, unknown>>
}

export interface TaskFixtureSshResponse {
  readonly input: string
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly delayMs?: number
  readonly trackPid?: boolean
}

export interface SshPidRecord {
  readonly event: "started" | "exited"
  readonly pid: number
  readonly input: string
}

export interface InstalledOpenCodeTaskFixture {
  readonly root: string
  readonly installedVersion: string
  readonly taskResumeEnabled: boolean
  readonly provenance: InstalledOpenCodeProvenance
  readonly alias: string
  readonly requestedWorkdir: string
  readonly canonicalWorkdir: string
  readonly workspace: string
  readonly serverURL: string
  readonly client: OpencodeClient
  readonly provider: ScriptedOpenAIProvider
  readonly readyPath: string
  readonly socketPath: string
  readonly mirrorPath: string
  readonly sshLog: string
  readonly sshInputLog: string
  readonly sshPidLog: string
  readonly sftpLog: string
  readonly sftpInputLog: string
  waitForReady(): Promise<ReadyRecord>
  readSshCalls(): Promise<string[][]>
  readSshInputs(): Promise<string[]>
  readSftpCalls(): Promise<string[][]>
  readSftpInputs(): Promise<string[]>
  readRemoteFile(remotePath: string): Promise<string>
  waitForSshPidRecords(options: {
    event: SshPidRecord["event"]
    count: number
    timeoutMs: number
  }): Promise<SshPidRecord[]>
  close(): Promise<InstalledOpenCodeCleanup>
}

export interface InstalledOpenCodeCleanup {
  readonly launcherResult: ProcessResult
  readonly readyRemoved: boolean
  readonly socketRemoved: boolean
  readonly mirrorRemoved: boolean
  readonly masterStateRemoved: boolean
  readonly rootRemoved: boolean
}

export interface InstalledOpenCodeTaskLaunchState {
  readonly installedVersion: string
  readonly taskResumeEnabled: boolean
}

export type InstalledOpenCodeTaskSteps =
  | readonly ScriptedProviderStep[]
  | ((state: InstalledOpenCodeTaskLaunchState) => readonly ScriptedProviderStep[])

export function detectInstalledOpenCode(
  env: NodeJS.ProcessEnv = process.env
): InstalledOpenCodeAvailability {
  const expectedVersion = env[TASK_TEST_EXPECTED_VERSION_ENV]
  const explicitCommand = env[TASK_TEST_BINARY_ENV]
  const required = expectedVersion !== undefined || explicitCommand !== undefined
  if (expectedVersion !== undefined && !explicitCommand) {
    return {
      kind: "absent",
      reason: `${TASK_TEST_BINARY_ENV} is required in exact-version mode`,
      required: true,
    }
  }

  const executable = explicitCommand
    ? executableAt(path.resolve(explicitCommand))
    : findExecutable("opencode", env.PATH)
  if (!executable) {
    return {
      kind: "absent",
      reason: explicitCommand
        ? `the selected OpenCode executable is unavailable: ${path.resolve(explicitCommand)}`
        : "the opencode executable is not on PATH",
      required,
    }
  }
  return {
    kind: "available",
    ...executable,
    expectedVersion,
    required,
  }
}

export async function startInstalledOpenCodeTaskFixture(options: {
  openCode: Extract<InstalledOpenCodeAvailability, { kind: "available" }>
  steps: InstalledOpenCodeTaskSteps
  configOverride?: InstalledOpenCodeConfigOverride
  extraSshResponses?: readonly TaskFixtureSshResponse[]
  enableFakeRemoteFilesystem?: boolean
}): Promise<InstalledOpenCodeTaskFixture> {
  accessSync(productionCli, constants.X_OK)
  const root = await mkdtemp(path.join(os.tmpdir(), "ocssh-real-task-"))
  let provider: ScriptedOpenAIProvider | undefined
  let launcher: ManagedProcess | undefined

  try {
    const stepsFactory =
      typeof options.steps === "function" ? options.steps : undefined
    const fakeRemoteRoot = options.enableFakeRemoteFilesystem
      ? path.join(root, "fake-remote")
      : undefined
    const directories = {
      home: path.join(root, "home"),
      configHome: path.join(root, "config"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      state: path.join(root, "state"),
      runtime: path.join(root, "run"),
      temporary: path.join(root, "tmp"),
    }
    const configDirectory = path.join(directories.configHome, "opencode")
    const probeConfigDirectory = path.join(
      directories.cache,
      "opencode-ssh",
      "probe-config-home",
      "opencode"
    )
    await Promise.all(
      [
        ...Object.values(directories),
        configDirectory,
        probeConfigDirectory,
        ...(fakeRemoteRoot ? [fakeRemoteRoot] : []),
      ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 }))
    )
    if (fakeRemoteRoot) {
      await mkdir(fakeRemotePath(fakeRemoteRoot, TASK_FIXTURE_WORKDIR), {
        recursive: true,
        mode: 0o700,
      })
    }
    await Promise.all([
      preseedConfigDependencies(configDirectory),
      preseedConfigDependencies(probeConfigDirectory),
    ])

    const installedVersion = await readInstalledVersion(
      options.openCode.binary,
      directories
    )
    if (
      options.openCode.expectedVersion !== undefined &&
      installedVersion !== options.openCode.expectedVersion
    ) {
      throw new Error(
        `Expected OpenCode ${options.openCode.expectedVersion} but ${JSON.stringify(
          options.openCode.originalCommandPath
        )} resolved to ${JSON.stringify(
          options.openCode.resolvedExecutable
        )} and reported ${JSON.stringify(installedVersion)}`
      )
    }
    provider = await startScriptedOpenAIProvider(
      typeof options.steps === "function" ? undefined : options.steps
    )
    const activeProvider = provider
    const targetID = computeTargetID(TASK_FIXTURE_ALIAS, TASK_FIXTURE_WORKDIR)
    const workspace = path.join(
      directories.state,
      "opencode-ssh",
      targetID,
      "workspace"
    )
    const serveStatePath = path.join(root, "serve-state.json")
    const openCodeLog = path.join(root, "opencode.jsonl")
    const sshLog = path.join(root, "ssh.jsonl")
    const sshInputLog = path.join(root, "ssh-input.jsonl")
    // The OpenCode wrapper already forwards FAKE_SSH_LOG to plugin SSH slaves.
    const sshPidLog = `${sshLog}.pids`
    const sftpLog = path.join(root, "sftp.jsonl")
    const sftpInputLog = path.join(root, "sftp-input.jsonl")
    const env = createEnvironment({
      directories,
      configDirectory,
      openCodeBinary: options.openCode.binary,
      openCodeCommandDirectory: options.openCode.commandDirectory,
      providerBaseURL: activeProvider.baseURL,
      configOverride: options.configOverride,
      serveStatePath,
      openCodeLog,
      sshLog,
      sshInputLog,
      sshResponses: [...sshResponses(), ...(options.extraSshResponses ?? [])],
      sftpLog,
      sftpInputLog,
      fakeRemoteRoot,
    })

    let observedStdout = ""
    let observedStderr = ""
    let resolveServerURL!: (url: string) => void
    const serverURL = new Promise<string>((resolve) => {
      resolveServerURL = resolve
    })
    let foundServerURL = false
    launcher = spawnManaged(
      productionCli,
      [TASK_FIXTURE_ALIAS, TASK_FIXTURE_REQUESTED_WORKDIR],
      {
        cwd: packageRoot,
        env,
        killGraceMs: 2_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
        onStdout: (chunk) => {
          observedStdout = appendBounded(observedStdout, chunk.toString("utf8"))
          if (foundServerURL) return
          const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(
            observedStdout
          )
          if (!match) return
          foundServerURL = true
          resolveServerURL(match[1])
        },
        onStderr: (chunk) => {
          observedStderr = appendBounded(observedStderr, chunk.toString("utf8"))
        },
      }
    )

    const listeningURL = await raceWithTimeout(
      Promise.race([
        serverURL,
        launcher.result.then((result) => {
          throw new Error(
            `Launcher exited before OpenCode served: ${describeResult(result)}; stdout=${JSON.stringify(
              observedStdout
            )}; stderr=${JSON.stringify(observedStderr)}`
          )
        }),
      ]),
      STARTUP_TIMEOUT_MS,
      "Timed out waiting for the installed OpenCode serve URL"
    ).catch((error: unknown) => {
      throw new Error(
        `${errorMessage(error)}; stdout=${JSON.stringify(observedStdout)}; stderr=${JSON.stringify(observedStderr)}`,
        { cause: error }
      )
    })
    const state = parseServeState(await readFile(serveStatePath, "utf8"))
    if (listeningURL !== `http://127.0.0.1:${state.servePort}`) {
      throw new Error(
        `OpenCode serve URL ${JSON.stringify(
          listeningURL
        )} did not use selected fixture port ${state.servePort}`
      )
    }
    const taskResumeCapability = state.env[REMOTE_ENV.taskResumeCapability]
    if (
      taskResumeCapability !== undefined &&
      taskResumeCapability !== TASK_RESUME_PROTOCOL
    ) {
      throw new Error(
        `OpenCode serve wrapper captured an invalid Task resume capability ${JSON.stringify(
          taskResumeCapability
        )}`
      )
    }
    const taskResumeEnabled = taskResumeCapability === TASK_RESUME_PROTOCOL
    if (stepsFactory !== undefined) {
      activeProvider.configure(
        stepsFactory({ installedVersion, taskResumeEnabled })
      )
    }
    const probeProvenance = parseChildProvenance(
      await readFile(
        path.join(probeConfigDirectory, OPEN_CODE_CHILD_PROVENANCE),
        "utf8"
      ),
      "debug-config"
    )
    const serveProvenance = parseChildProvenance(
      await readFile(path.join(configDirectory, OPEN_CODE_CHILD_PROVENANCE), "utf8"),
      "serve"
    )
    if (serveProvenance.servePort !== state.servePort) {
      throw new Error(
        `OpenCode serve state and provenance selected different ports: ${state.servePort} and ${serveProvenance.servePort}`
      )
    }
    if (JSON.stringify(serveProvenance.childArgv) !== JSON.stringify(state.childArgv)) {
      throw new Error("OpenCode serve state and provenance captured different argv")
    }
    const probeChildExecutable = probeProvenance.childExecutable
    const serveChildExecutable = serveProvenance.childExecutable
    if (serveChildExecutable !== state.childExecutable) {
      throw new Error("OpenCode serve state and provenance captured different executables")
    }
    for (const [kind, actual] of [
      ["probe", probeChildExecutable],
      ["serve", serveChildExecutable],
    ] as const) {
      if (actual !== options.openCode.resolvedExecutable) {
        throw new Error(
          `OpenCode debug wrapper ${kind} child mismatch: expected ${JSON.stringify(
            options.openCode.resolvedExecutable
          )}, received ${JSON.stringify(actual)}`
        )
      }
    }
    const provenance: InstalledOpenCodeProvenance = {
      originalCommandPath: options.openCode.originalCommandPath,
      resolvedExecutable: options.openCode.resolvedExecutable,
      reportedVersion: installedVersion,
      probeChildExecutable,
      serveChildExecutable,
    }
    reportProvenance(provenance)
    const identity: ReadyHandshakeIdentity = {
      launchID: requiredStateValue(state.env, REMOTE_ENV.launchID),
      nonce: requiredStateValue(state.env, REMOTE_ENV.readyNonce),
      alias: requiredStateValue(state.env, REMOTE_ENV.alias),
      canonicalWorkdir: requiredStateValue(state.env, REMOTE_ENV.workdir),
      targetID: requiredStateValue(state.env, REMOTE_ENV.targetID),
    }
    const readyPath = requiredStateValue(state.env, REMOTE_ENV.readyPath)
    const socketPath = requiredStateValue(state.env, REMOTE_ENV.socket)
    const mirrorPath = requiredStateValue(state.env, REMOTE_ENV.mirrorRoot)
    if (state.cwd !== workspace) {
      throw new Error(`OpenCode serve wrapper used unexpected workspace ${JSON.stringify(state.cwd)}`)
    }

    const client = createOpencodeClient({
      baseUrl: listeningURL,
      directory: workspace,
    })
    let closePromise: Promise<InstalledOpenCodeCleanup> | undefined

    return {
      root,
      installedVersion,
      taskResumeEnabled,
      provenance,
      alias: TASK_FIXTURE_ALIAS,
      requestedWorkdir: TASK_FIXTURE_REQUESTED_WORKDIR,
      canonicalWorkdir: TASK_FIXTURE_WORKDIR,
      workspace,
      serverURL: listeningURL,
      client,
      provider: activeProvider,
      readyPath,
      socketPath,
      mirrorPath,
      sshLog,
      sshInputLog,
      sshPidLog,
      sftpLog,
      sftpInputLog,
      waitForReady: () =>
        waitForReadyEvent(readyPath, identity, launcher!.result, READY_TIMEOUT_MS),
      readSshCalls: () => readJsonLines<string[]>(sshLog),
      readSshInputs: () => readJsonLines<string>(sshInputLog),
      readSftpCalls: () => readJsonLines<string[]>(sftpLog),
      readSftpInputs: () => readJsonLines<string>(sftpInputLog),
      readRemoteFile: (remotePath) => {
        if (!fakeRemoteRoot) {
          throw new Error("Fake remote filesystem is not enabled for this fixture")
        }
        return readFile(fakeRemotePath(fakeRemoteRoot, remotePath), "utf8")
      },
      waitForSshPidRecords: (waitOptions) =>
        waitForSshPidEvent(sshPidLog, waitOptions),
      close() {
        closePromise ??= closeFixture({
          client,
          launcher: launcher!,
          provider: activeProvider,
          root,
          readyPath,
          socketPath,
          mirrorPath,
        })
        return closePromise
      },
    }
  } catch (error) {
    const cleanupErrors: unknown[] = []
    const beforeTermination = await collectStartupDiagnostics(root)
    if (launcher) {
      try {
        await raceWithTimeout(
          launcher.terminate(),
          PROCESS_TREE_SETTLEMENT_TIMEOUT_MS,
          "Timed out settling the failed-start launcher process tree"
        )
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
        await raceWithTimeout(
          launcher.result,
          LAUNCHER_FALLBACK_TIMEOUT_MS,
          "Timed out waiting for the failed-start launcher fallback result"
        ).catch((fallbackError: unknown) => cleanupErrors.push(fallbackError))
      }
    }
    const afterTermination = await collectStartupDiagnostics(root)
    if (provider) {
      await raceWithTimeout(
        provider.close(),
        PROVIDER_CLOSE_TIMEOUT_MS,
        "Timed out closing the failed-start scripted provider"
      ).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError))
    }
    await raceWithTimeout(
      rm(root, { recursive: true, force: true }),
      ROOT_REMOVAL_TIMEOUT_MS,
      "Timed out removing the failed-start fixture root"
    ).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError))
    const startupError = new Error(
      `${errorMessage(error)}; isolated startup diagnostic=${bounded(
        JSON.stringify({ beforeTermination, afterTermination })
      )}`,
      { cause: error }
    )
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        "Installed OpenCode Task fixture startup and cleanup failed"
      )
    }
    throw startupError
  }
}

function createEnvironment(input: {
  directories: Record<string, string>
  configDirectory: string
  openCodeBinary: string
  openCodeCommandDirectory: string
  providerBaseURL: string
  configOverride?: InstalledOpenCodeConfigOverride
  serveStatePath: string
  openCodeLog: string
  sshLog: string
  sshInputLog: string
  sshResponses: readonly TaskFixtureSshResponse[]
  sftpLog: string
  sftpInputLog: string
  fakeRemoteRoot?: string
}): NodeJS.ProcessEnv {
  const pathValue = [
    path.dirname(process.execPath),
    input.openCodeCommandDirectory,
    path.dirname(input.openCodeBinary),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(path.delimiter)
  const env: NodeJS.ProcessEnv = {
    PATH: pathValue,
    HOME: input.directories.home,
    XDG_CONFIG_HOME: input.directories.configHome,
    XDG_DATA_HOME: input.directories.data,
    XDG_CACHE_HOME: input.directories.cache,
    XDG_STATE_HOME: input.directories.state,
    XDG_RUNTIME_DIR: input.directories.runtime,
    TMPDIR: input.directories.temporary,
    OPENCODE_CONFIG_DIR: input.configDirectory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      providerConfig(input.providerBaseURL, input.configOverride)
    ),
    OPENCODE_CLIENT: "opencode-ssh-task-harness",
    OPENCODE_DB: path.join(input.directories.data, "opencode-task-harness.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_TERMINAL_TITLE: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    OPENCODE_SSH_OPENCODE_BIN: fakeOpenCode,
    [REMOTE_ENV.sshBinary]: fakeSsh,
    [REMOTE_ENV.sftpBinary]: fakeSftp,
    FAKE_OPENCODE_REAL_BIN: input.openCodeBinary,
    FAKE_OPENCODE_SERVE: "1",
    FAKE_OPENCODE_SERVE_STATE: input.serveStatePath,
    FAKE_OPENCODE_LOG: input.openCodeLog,
    FAKE_SSH_LOG: input.sshLog,
    FAKE_SSH_INPUT_LOG: input.sshInputLog,
    FAKE_SSH_RESPONSES: JSON.stringify(input.sshResponses),
    FAKE_SSH_FAIL_UNMATCHED: "1",
    FAKE_SSH_REQUIRE_LIVE_MASTER: "1",
    FAKE_SFTP_LOG: input.sftpLog,
    FAKE_SFTP_INPUT_LOG: input.sftpInputLog,
    ...(input.fakeRemoteRoot
      ? { FAKE_REMOTE_ROOT: input.fakeRemoteRoot }
      : { FAKE_SFTP_EXIT_CODE: "2" }),
    SHELL: "/bin/sh",
    USER: "opencode-task-harness",
    LOGNAME: "opencode-task-harness",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
  }
  copyNpmTransportEnvironment(process.env, env)
  return env
}

function providerConfig(
  baseURL: string,
  override?: InstalledOpenCodeConfigOverride
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    formatter: false,
    lsp: false,
    mcp: {},
    permission: {
      remote_status: "allow",
      ...(override?.permission ?? {}),
    },
    skills: { paths: [], urls: [] },
    enabled_providers: [TASK_FIXTURE_PROVIDER_ID],
    model: `${TASK_FIXTURE_PROVIDER_ID}/${TASK_FIXTURE_MODEL_ID}`,
    small_model: `${TASK_FIXTURE_PROVIDER_ID}/${TASK_FIXTURE_MODEL_ID}`,
    compaction: { auto: false, prune: false },
    provider: {
      [TASK_FIXTURE_PROVIDER_ID]: {
        name: "Hermetic Task Fixture",
        npm: "@ai-sdk/openai-compatible",
        options: {
          apiKey: "fixture-api-key",
          baseURL,
          timeout: 10_000,
          headerTimeout: 10_000,
          chunkTimeout: 10_000,
        },
        models: {
          [TASK_FIXTURE_MODEL_ID]: {
            name: "Hermetic Task Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 100_000, output: 4_096 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
  }
  if (override?.subagent_depth !== undefined) {
    config.subagent_depth = override.subagent_depth
  }
  if (override?.agent !== undefined) config.agent = override.agent
  return config
}

function fakeRemotePath(root: string, remotePath: string): string {
  if (
    !path.posix.isAbsolute(remotePath) ||
    path.posix.normalize(remotePath) !== remotePath
  ) {
    throw new Error(`Invalid fake remote path ${JSON.stringify(remotePath)}`)
  }
  const localPath = path.resolve(root, `.${remotePath}`)
  if (localPath !== root && !localPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Fake remote path escaped its root: ${JSON.stringify(remotePath)}`)
  }
  return localPath
}

function sshResponses(): TaskFixtureSshResponse[] {
  const cwd = TASK_FIXTURE_WORKDIR
  return [
    {
      input: `cd ${TASK_FIXTURE_REQUESTED_WORKDIR} || exit $?\npwd -P`,
      stdout: `${cwd}\n`,
    },
    { input: "uname -s", stdout: "Linux\n" },
    {
      input: `git -C ${cwd} rev-parse --is-inside-work-tree 2>/dev/null`,
      stdout: "true\n",
    },
    { input: `realpath -e -- ${cwd}`, stdout: `${cwd}\n` },
    {
      input: `cd ${cwd} || exit $?\nhostname; whoami; pwd -P`,
      stdout: `task3-remote-host\ntask3-remote-user\n${cwd}\n`,
    },
    {
      input: `cd ${cwd} || exit $?\nprintf ${LOCAL_EXECUTION_CANARY}`,
      stdout: SSH_FIXTURE_CHILD_OUTPUT,
    },
  ]
}

export interface FixtureFileWaitOptions {
  readonly useWatcher?: boolean
  readonly pollIntervalMs?: number
}

export function waitForSshPidEvent(
  filePath: string,
  options: {
    event: SshPidRecord["event"]
    count: number
    timeoutMs: number
  },
  waitOptions: FixtureFileWaitOptions = {}
): Promise<SshPidRecord[]> {
  if (!Number.isSafeInteger(options.count) || options.count < 1) {
    throw new RangeError("SSH PID record count must be a positive safe integer")
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new RangeError("SSH PID record timeout must be finite and non-negative")
  }
  const pollIntervalMs = filePollInterval(waitOptions.pollIntervalMs)

  return new Promise<SshPidRecord[]>((resolve, reject) => {
    let watcher: FSWatcher | undefined
    let timer: NodeJS.Timeout | undefined
    let pollTimer: NodeJS.Timeout | undefined
    let settled = false
    let checking = false
    let checkAgain = false

    const finish = (error?: unknown, records?: SshPidRecord[]) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (pollTimer) clearInterval(pollTimer)
      watcher?.close()
      if (error !== undefined) reject(error)
      else resolve(records!)
    }
    const check = async () => {
      if (settled) return
      if (checking) {
        checkAgain = true
        return
      }
      checking = true
      try {
        do {
          checkAgain = false
          const matching = (await readJsonLines<SshPidRecord>(filePath)).filter(
            (record) => record.event === options.event
          )
          if (matching.length >= options.count) {
            finish(undefined, matching.slice(0, options.count))
            return
          }
        } while (checkAgain && !settled)
      } catch (error) {
        finish(error)
      } finally {
        checking = false
      }
    }

    if (waitOptions.useWatcher !== false) {
      try {
        watcher = watch(path.dirname(filePath), (_event, filename) => {
          if (filename === null || filename.toString() === path.basename(filePath)) {
            void check()
          }
        })
        watcher.once("error", finish)
      } catch (error) {
        finish(error)
        return
      }
    }
    pollTimer = setInterval(() => void check(), pollIntervalMs)
    timer = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out after ${options.timeoutMs}ms waiting for ${options.count} fake SSH ${options.event} PID records`
          )
        ),
      options.timeoutMs
    )
    void check()
  })
}

async function preseedConfigDependencies(directory: string): Promise<void> {
  const scopeDirectory = path.join(directory, "node_modules", "@opencode-ai")
  await mkdir(scopeDirectory, { recursive: true, mode: 0o700 })
  await Promise.all(
    ["plugin", "sdk"].map((name) =>
      symlink(
        path.join(packageRoot, "node_modules", "@opencode-ai", name),
        path.join(scopeDirectory, name),
        "dir"
      )
    )
  )
  const dependencies = { "@opencode-ai/plugin": "1.18.18" }
  await Promise.all([
    writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    ),
    writeFile(
      path.join(directory, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "opencode-ssh-task-fixture",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { dependencies } },
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    ),
  ])
}

async function readInstalledVersion(
  binary: string,
  directories: Record<string, string>
): Promise<string> {
  const result = await spawnProcess(binary, ["--version"], {
    env: {
      PATH: [path.dirname(binary), path.dirname(process.execPath), "/usr/bin", "/bin"].join(
        path.delimiter
      ),
      HOME: directories.home,
      XDG_CONFIG_HOME: directories.configHome,
      XDG_DATA_HOME: directories.data,
      XDG_CACHE_HOME: directories.cache,
      XDG_STATE_HOME: directories.state,
      XDG_RUNTIME_DIR: directories.runtime,
      TMPDIR: directories.temporary,
      NO_COLOR: "1",
    },
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
  })
  const version = result.stdout.trim()
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error(`Installed OpenCode version check failed: ${describeResult(result)}`)
  }
  return version
}

async function closeFixture(input: {
  client: OpencodeClient
  launcher: ManagedProcess
  provider: ScriptedOpenAIProvider
  root: string
  readyPath: string
  socketPath: string
  mirrorPath: string
}): Promise<InstalledOpenCodeCleanup> {
  const cleanupErrors: unknown[] = []
  await raceWithTimeout(
    input.client.instance.dispose(undefined, {
      signal: AbortSignal.timeout(5_000),
      throwOnError: true,
    }),
    CLIENT_DISPOSE_TIMEOUT_MS,
    "Timed out disposing the OpenCode instance"
  ).catch((error: unknown) => cleanupErrors.push(error))

  let launcherResult: ProcessResult | undefined
  try {
    launcherResult = await raceWithTimeout(
      input.launcher.terminate(),
      PROCESS_TREE_SETTLEMENT_TIMEOUT_MS,
      "Timed out settling the OpenCode SSH launcher process tree"
    )
  } catch (error) {
    cleanupErrors.push(error)
    launcherResult = await raceWithTimeout(
      input.launcher.result,
      LAUNCHER_FALLBACK_TIMEOUT_MS,
      "Timed out waiting for the OpenCode SSH launcher fallback result"
    ).catch((fallbackError: unknown) => {
      cleanupErrors.push(fallbackError)
      return undefined
    })
  }

  const artifactState = {
    readyRemoved: !(await pathExists(input.readyPath)),
    socketRemoved: !(await pathExists(input.socketPath)),
    mirrorRemoved: !(await pathExists(input.mirrorPath)),
    masterStateRemoved: !(await pathExists(`${input.socketPath}.fake-ssh-master`)),
  }

  await raceWithTimeout(
    input.provider.close(),
    PROVIDER_CLOSE_TIMEOUT_MS,
    "Timed out closing the scripted provider"
  ).catch((error: unknown) => cleanupErrors.push(error))
  await raceWithTimeout(
    rm(input.root, { recursive: true, force: true }),
    ROOT_REMOVAL_TIMEOUT_MS,
    "Timed out removing the fixture root"
  ).catch((error: unknown) => cleanupErrors.push(error))
  const rootRemoved = !(await pathExists(input.root))
  if (!launcherResult) {
    cleanupErrors.push(new Error("OpenCode SSH launcher produced no terminal result"))
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Installed OpenCode Task fixture cleanup failed")
  }
  if (!launcherResult) {
    throw new Error("OpenCode SSH launcher cleanup invariant failed")
  }
  return {
    launcherResult,
    ...artifactState,
    rootRemoved,
  }
}

export function waitForReadyEvent(
  readyPath: string,
  identity: ReadyHandshakeIdentity,
  launcherResult: Promise<ProcessResult>,
  timeoutMs: number,
  waitOptions: FixtureFileWaitOptions = {}
): Promise<ReadyRecord> {
  const pollIntervalMs = filePollInterval(waitOptions.pollIntervalMs)
  return new Promise<ReadyRecord>((resolve, reject) => {
    let watcher: FSWatcher | undefined
    let timer: NodeJS.Timeout | undefined
    let pollTimer: NodeJS.Timeout | undefined
    let settled = false
    let checking = false
    let checkAgain = false

    const finish = (error?: unknown, record?: ReadyRecord) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (pollTimer) clearInterval(pollTimer)
      watcher?.close()
      if (error !== undefined) reject(error)
      else resolve(record!)
    }
    const check = async () => {
      if (settled) return
      if (checking) {
        checkAgain = true
        return
      }
      checking = true
      try {
        do {
          checkAgain = false
          try {
            const value = JSON.parse(await readFile(readyPath, "utf8")) as unknown
            finish(undefined, validateReadyRecord(value, identity))
          } catch (error) {
            if (!errnoIs(error, "ENOENT")) finish(error)
          }
        } while (checkAgain && !settled)
      } catch (error) {
        finish(error)
      } finally {
        checking = false
      }
    }

    if (waitOptions.useWatcher !== false) {
      try {
        watcher = watch(path.dirname(readyPath), (_event, filename) => {
          if (filename === null || filename.toString() === path.basename(readyPath)) {
            void check()
          }
        })
        watcher.once("error", finish)
      } catch (error) {
        finish(error)
        return
      }
    }
    pollTimer = setInterval(() => void check(), pollIntervalMs)
    timer = setTimeout(
      () => finish(new Error(`Timed out after ${timeoutMs}ms waiting for ${READY_PROTOCOL}`)),
      timeoutMs
    )
    void launcherResult.then(
      (result) =>
        finish(
          new Error(`Launcher exited before the ready marker: ${describeResult(result)}`)
        ),
      finish
    )
    void check()
  })
}

interface ServeState {
  childArgv: string[]
  childExecutable: string
  servePort: number
  cwd: string
  env: Record<string, unknown>
}

function parseServeState(contents: string): ServeState {
  const value = JSON.parse(contents) as unknown
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("childArgv" in value) ||
    !Array.isArray(value.childArgv) ||
    !value.childArgv.every((item) => typeof item === "string") ||
    !("childExecutable" in value) ||
    typeof value.childExecutable !== "string" ||
    !value.childExecutable ||
    !("servePort" in value) ||
    typeof value.servePort !== "number" ||
    !("cwd" in value) ||
    typeof value.cwd !== "string" ||
    !("env" in value) ||
    value.env === null ||
    typeof value.env !== "object" ||
    Array.isArray(value.env)
  ) {
    throw new Error("OpenCode serve wrapper wrote invalid state")
  }
  const servePort = parseServePort(value.childArgv)
  if (validateTCPPort(value.servePort, "OpenCode serve state port") !== servePort) {
    throw new Error("OpenCode serve wrapper state port does not match its argv")
  }
  return value as ServeState
}

function parseChildProvenance(contents: string, expectedMode: "debug-config"): {
  childArgv: string[]
  childExecutable: string
}
function parseChildProvenance(contents: string, expectedMode: "serve"): {
  childArgv: string[]
  childExecutable: string
  servePort: number
}
function parseChildProvenance(
  contents: string,
  expectedMode: "debug-config" | "serve"
): {
  childArgv: string[]
  childExecutable: string
  servePort?: number
} {
  const value = JSON.parse(contents) as unknown
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("childArgv" in value) ||
    !Array.isArray(value.childArgv) ||
    !value.childArgv.every((item) => typeof item === "string") ||
    !("childExecutable" in value) ||
    typeof value.childExecutable !== "string" ||
    !value.childExecutable
  ) {
    throw new Error("OpenCode debug wrapper wrote invalid child provenance")
  }
  if (expectedMode === "debug-config") {
    if (
      value.childArgv.length !== 2 ||
      value.childArgv[0] !== "debug" ||
      value.childArgv[1] !== "config"
    ) {
      throw new Error(
        `OpenCode probe wrapper used unexpected argv ${JSON.stringify(value.childArgv)}`
      )
    }
    return {
      childArgv: value.childArgv,
      childExecutable: value.childExecutable,
    }
  }
  if (!("servePort" in value) || typeof value.servePort !== "number") {
    throw new Error("OpenCode serve provenance is missing its selected port")
  }
  const servePort = parseServePort(value.childArgv)
  if (validateTCPPort(value.servePort, "OpenCode serve provenance port") !== servePort) {
    throw new Error("OpenCode serve provenance port does not match its argv")
  }
  return {
    childArgv: value.childArgv,
    childExecutable: value.childExecutable,
    servePort,
  }
}

function parseServePort(argv: readonly string[]): number {
  const match =
    argv.length === 3 &&
    argv[0] === "serve" &&
    argv[1] === "--hostname=127.0.0.1"
      ? /^--port=([1-9]\d*)$/u.exec(argv[2] ?? "")
      : null
  if (!match) {
    throw new Error(`OpenCode serve wrapper used unexpected argv ${JSON.stringify(argv)}`)
  }
  return validateTCPPort(Number(match[1]), "OpenCode serve argv port")
}

function validateTCPPort(value: number, description: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${description} must be a positive TCP port integer`)
  }
  return value
}

function requiredStateValue(env: Record<string, unknown>, name: string): string {
  const value = env[name]
  if (typeof value !== "string" || !value) {
    throw new Error(`OpenCode serve state is missing ${name}`)
  }
  return value
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  const contents = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (errnoIs(error, "ENOENT")) return ""
    throw error
  })
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function copyNpmTransportEnvironment(
  source: NodeJS.ProcessEnv,
  target: NodeJS.ProcessEnv
): void {
  const transport = new Set([
    "BUN_CONFIG_REGISTRY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
  ])
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (/^npm_config_/iu.test(name) || transport.has(name.toUpperCase()))
    ) {
      target[name] = value
    }
  }
}

interface ExecutableSelection {
  readonly binary: string
  readonly commandDirectory: string
  readonly originalCommandPath: string
  readonly resolvedExecutable: string
}

function findExecutable(
  command: string,
  pathValue: string | undefined
): ExecutableSelection | undefined {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.resolve(directory, command)
    const executable = executableAt(candidate)
    if (executable) return executable
  }
  return undefined
}

function executableAt(candidate: string): ExecutableSelection | undefined {
  try {
    accessSync(candidate, constants.X_OK)
    const resolvedExecutable = realpathSync(candidate)
    return {
      binary: resolvedExecutable,
      commandDirectory: path.dirname(candidate),
      originalCommandPath: candidate,
      resolvedExecutable,
    }
  } catch {
    return undefined
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false
  )
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk
  if (combined.length <= MAX_DIAGNOSTIC_CHARACTERS) return combined
  return combined.slice(-MAX_DIAGNOSTIC_CHARACTERS)
}

async function readBoundedFailureDiagnostic(root: string): Promise<string | undefined> {
  const filePath = path.join(
    root,
    "cache",
    "opencode-ssh",
    "probe-config-home",
    "opencode",
    OPEN_CODE_FAILURE_DIAGNOSTIC
  )
  const contents = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (errnoIs(error, "ENOENT")) return undefined
    return `unable to read diagnostic: ${errorMessage(error)}`
  })
  if (contents === undefined) return undefined
  return bounded(contents.trim())
}

async function collectStartupDiagnostics(root: string): Promise<Record<string, unknown>> {
  const serveStatePath = path.join(root, "serve-state.json")
  const openCodeLogPath = path.join(root, "opencode.jsonl")
  const sshLogPath = path.join(root, "ssh.jsonl")
  const sshInputLogPath = path.join(root, "ssh-input.jsonl")
  const sshCalls = await readDiagnosticJsonLines(sshLogPath)
  const sshInputs = await readDiagnosticJsonLines(sshInputLogPath)
  const startCall = sshCalls.values.find(
    (value): value is string[] =>
      Array.isArray(value) &&
      value.every((item) => typeof item === "string") &&
      value.includes("-MN")
  )
  const controlPathOption = startCall?.find((value) => value.startsWith("ControlPath="))
  const socketPath = controlPathOption?.slice("ControlPath=".length)
  const masterStatePath = socketPath ? `${socketPath}.fake-ssh-master` : undefined
  const masterState = masterStatePath
    ? await readFakeMasterState(masterStatePath)
    : { exists: false, pid: null, live: null }
  const wrapperInvocations = await readDiagnosticJsonLines(openCodeLogPath)

  return {
    serveStateExists: await pathExists(serveStatePath),
    sshArgv: summarizeDiagnosticLog(sshCalls),
    sshInput: summarizeDiagnosticLog(sshInputs),
    fakeMaster: {
      socketPath: socketPath ?? null,
      ...masterState,
    },
    wrapperLog: {
      exists: wrapperInvocations.exists,
      count: wrapperInvocations.values.length,
      entries: wrapperInvocations.values.slice(-2).map(summarizeWrapperInvocation),
    },
    openCodeStderr: await readBoundedFailureDiagnostic(root),
  }
}

async function readFakeMasterState(filePath: string): Promise<{
  exists: boolean
  pid: number | null
  live: boolean | null
}> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as unknown
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return { exists: false, pid: null, live: null }
    return { exists: true, pid: null, live: null }
  }
  const pid =
    value !== null &&
    typeof value === "object" &&
    "pid" in value &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0
      ? Number(value.pid)
      : null
  if (pid === null) return { exists: true, pid: null, live: null }
  try {
    process.kill(pid, 0)
    return { exists: true, pid, live: true }
  } catch {
    return { exists: true, pid, live: false }
  }
}

async function readDiagnosticJsonLines(filePath: string): Promise<{
  exists: boolean
  values: unknown[]
}> {
  const contents = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (errnoIs(error, "ENOENT")) return undefined
    return ""
  })
  if (contents === undefined) return { exists: false, values: [] }
  return {
    exists: true,
    values: contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return "[invalid JSON line]"
        }
      }),
  }
}

function summarizeDiagnosticLog(log: { exists: boolean; values: unknown[] }): {
  exists: boolean
  count: number
  first: unknown[]
  last: unknown[]
} {
  return {
    exists: log.exists,
    count: log.values.length,
    first: log.values.slice(0, 3).map(boundDiagnosticValue),
    last: log.values.slice(-5).map(boundDiagnosticValue),
  }
}

function summarizeWrapperInvocation(value: unknown): Record<string, unknown> | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "[invalid wrapper invocation]"
  }
  const record = value as Record<string, unknown>
  return {
    childArgv: record.childArgv,
    readyExistsAfterChild: record.readyExistsAfterChild,
    exitCode: record.exitCode,
    signal: record.signal,
  }
}

function boundDiagnosticValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  return value.length <= 1_024 ? value : `${value.slice(0, 1_024)}...[truncated]`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bounded(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_CHARACTERS) return value
  return `${value.slice(0, MAX_DIAGNOSTIC_CHARACTERS)}...[truncated]`
}

function describeResult(result: ProcessResult): string {
  if (result.signal) return `signal ${result.signal}`
  if (result.termination) return result.termination
  return `exit code ${result.exitCode ?? "unknown"}`
}

function errnoIs(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function filePollInterval(value: number | undefined): number {
  const interval = value ?? 10
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError("Fixture file poll interval must be finite and positive")
  }
  return interval
}

function reportProvenance(provenance: InstalledOpenCodeProvenance): void {
  const diagnostic = JSON.stringify(provenance)
  if (reportedProvenance.has(diagnostic)) return
  reportedProvenance.add(diagnostic)
  process.stdout.write(`OpenCode Task fixture provenance: ${diagnostic}\n`)
}
