import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { constants, accessSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { isIP } from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../src/cli.js"
import { REMOTE_ENV } from "../../src/config.js"
import { resolveDailyLogFilePath } from "../../src/logger.js"
import { spawnProcess } from "../../src/process.js"
import { TASK_RESUME_PROTOCOL } from "../../src/task-resume-capability.js"
import { scrubFixtureEnvironment } from "../helpers/fixture-environment.js"

const packageRootURL = new URL("../../", import.meta.url)
const packageRoot = fileURLToPath(packageRootURL)
const safetyInstructionsPath = path.join(
  packageRoot,
  "opencode-ssh-remote-use",
  "opencode-ssh-safety.md"
)
const fakeOpenCode = fileURLToPath(
  new URL("../fixtures/bin/opencode-debug", import.meta.url)
)
const fakeVersionOpenCode = fileURLToPath(new URL("../fixtures/bin/opencode", import.meta.url))
const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const openCode = detectOpenCode()
const skipReason = openCode.kind === "absent" ? openCode.reason : undefined
const OPEN_CODE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const temporaryRoots: string[] = []

interface DebugInvocation {
  argv: string[]
  childArgv: string[]
  childExecutable: string
  servePort: number
  cwd: string
  configContent?: string
  env: Record<string, string>
  wrapperEnvironmentNames: string[]
  childEnvironmentNames: string[]
  readyObservedBeforeTermination: boolean
  readyStableBeforeTermination: boolean
  activationDispatched: boolean
  activationSucceeded: boolean
  activationURL?: string
  activationError?: string
  disposalDispatched: boolean
  disposalSucceeded: boolean
  disposalURL?: string
  disposalError?: string
  intentionalPostReadyTermination: boolean
  controlError?: string
  readyExistsAfterChild: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
}

interface JsonLogRecord {
  timestamp: string
  level: "debug" | "info" | "warn" | "error"
  event: string
  pid: number
  fields?: Record<string, unknown>
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("actual OpenCode server-plugin loader", () => {
  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "loads the package-root tuple with the installed OpenCode",
    async () => {
      if (openCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }

      expect(
        await pathExists(path.join(packageRoot, "dist", "index.js")),
        "The actual-loader integration test must run after npm run build"
      ).toBe(true)

      const alias = "loader-host.invalid"
      const requestedWorkdir = "/srv/requested loader workspace"
      const canonicalWorkdir = "/srv/canonical loader workspace"
      const fixture = await createFixture(
        openCode.binary,
        requestedWorkdir,
        canonicalWorkdir
      )
      const inheritedSecretName = "OPENCODE_LOADER_TEST_INHERITED_SECRET"
      const inheritedSecret = "must-not-reach-the-opencode-wrapper"
      const previousSecret = process.env[inheritedSecretName]
      let exitCode: number | undefined
      let launchError: unknown

      process.env[inheritedSecretName] = inheritedSecret
      try {
        exitCode = await runCli([alias, requestedWorkdir], fixture.env)
      } catch (error) {
        launchError = error
      } finally {
        if (previousSecret === undefined) delete process.env[inheritedSecretName]
        else process.env[inheritedSecretName] = previousSecret
      }
      if (launchError !== undefined) {
        const wrapperFailure = await readFile(
          path.join(fixture.configDirectory, ".opencode-debug-failure.json"),
          "utf8"
        ).catch(() => "(wrapper failure diagnostic unavailable)")
        const eventTrace = await readJsonLogRecords(fixture.env).then(
          (records) =>
            JSON.stringify(
              records.map(({ event, fields, pid }) => ({ event, fields, pid }))
            ),
          () => "(structured log diagnostic unavailable)"
        )
        throw new Error(
          `Actual OpenCode serve loader failed: ${errorMessage(launchError)}; wrapper=${wrapperFailure}; events=${eventTrace}`,
          { cause: launchError }
        )
      }

      const rawOpenCodeLog = await readFile(fixture.openCodeLog, "utf8")
      const invocations = parseJsonLines<DebugInvocation>(rawOpenCodeLog)
      expect(exitCode, rawOpenCodeLog).toBe(0)
      expect(invocations).toHaveLength(1)
      expect(rawOpenCodeLog).not.toContain(inheritedSecret)

      const [invocation] = invocations
      const selectedPort = servePortFromArgv(invocation.childArgv)
      expect(invocation.argv).toEqual([])
      expect(invocation.childArgv).toEqual([
        "serve",
        "--hostname=127.0.0.1",
        `--port=${selectedPort}`,
      ])
      expect(invocation.childExecutable).toBe(openCode.binary)
      expect(invocation.servePort).toBe(selectedPort)
      expect(invocation.readyObservedBeforeTermination).toBe(true)
      expect(invocation.readyStableBeforeTermination).toBe(true)
      expect(invocation.activationDispatched).toBe(true)
      expect(invocation.activationSucceeded).toBe(true)
      expect(invocation.activationError).toBeUndefined()
      expect(invocation.activationURL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/path\?directory=/u
      )
      expect(new URL(invocation.activationURL!).port).toBe(String(selectedPort))
      expect(invocation.disposalDispatched).toBe(true)
      expect(invocation.disposalSucceeded).toBe(true)
      expect(invocation.disposalError).toBeUndefined()
      expect(invocation.disposalURL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/instance\/dispose\?directory=/u
      )
      expect(new URL(invocation.disposalURL!).port).toBe(String(selectedPort))
      expect(invocation.intentionalPostReadyTermination).toBe(true)
      expect(invocation.controlError).toBeUndefined()
      expect(invocation.wrapperEnvironmentNames).not.toContain(inheritedSecretName)
      expect(invocation.wrapperEnvironmentNames).toContain(
        "FAKE_OPENCODE_SERVE_AUTO_EXIT_AFTER_READY"
      )
      expect(invocation.wrapperEnvironmentNames).toContain(
        "FAKE_OPENCODE_SERVE_AUTO_EXIT_STATE"
      )
      expect(invocation.childEnvironmentNames).not.toContain(inheritedSecretName)
      expect(invocation.childEnvironmentNames).not.toContain(
        "FAKE_OPENCODE_SERVE_AUTO_EXIT_AFTER_READY"
      )
      expect(invocation.childEnvironmentNames).not.toContain(
        "FAKE_OPENCODE_SERVE_AUTO_EXIT_STATE"
      )
      expect(invocation.childEnvironmentNames).toContain(
        REMOTE_ENV.expectedOpenCodeRuntimeVersion
      )
      expect(invocation.childEnvironmentNames).toEqual(
        expect.arrayContaining([
          "OPENCODE_SSH_LOG_DIRECTORY",
          "OPENCODE_SSH_LOG_STARTUP_ID",
        ])
      )
      expect(invocation.env).not.toHaveProperty("OPENCODE_SSH_LOG_DIRECTORY")
      expect(invocation.env).not.toHaveProperty("OPENCODE_SSH_LOG_STARTUP_ID")
      expect(invocation.env).toMatchObject({
        [REMOTE_ENV.alias]: alias,
        [REMOTE_ENV.workdir]: canonicalWorkdir,
        [REMOTE_ENV.sshBinary]: fakeSsh,
        [REMOTE_ENV.sftpBinary]: fakeSftp,
      })
      expect(invocation.cwd).toBe(
        path.join(
          fixture.env.XDG_STATE_HOME!,
          "opencode-ssh",
          invocation.env[REMOTE_ENV.targetID],
          "workspace"
        )
      )

      const serveState = JSON.parse(
        await readFile(fixture.serveStatePath, "utf8")
      ) as {
        autoExitAfterReady: boolean
        childArgv: string[]
        childExecutable: string
        servePort: number
        env: Record<string, string>
      }
      expect(serveState).toMatchObject({
        autoExitAfterReady: true,
        childArgv: invocation.childArgv,
        childExecutable: openCode.binary,
        servePort: selectedPort,
      })
      const autoExitState = JSON.parse(
        await readFile(fixture.autoExitStatePath, "utf8")
      ) as {
        readyObservedBeforeTermination: boolean
        readyStableBeforeTermination: boolean
        readyPath: string
        nonceHash: string
        stabilityMs: number
        servePort: number
        activationDispatched: boolean
        activationSucceeded: boolean
        activationURL: string
        disposalDispatched: boolean
        disposalSucceeded: boolean
        disposalURL: string
      }
      expect(autoExitState).toEqual({
        readyObservedBeforeTermination: true,
        readyStableBeforeTermination: true,
        readyPath: invocation.env[REMOTE_ENV.readyPath],
        nonceHash: createHash("sha256")
          .update(serveState.env.OPENCODE_SSH_READY_NONCE, "utf8")
          .digest("hex"),
        stabilityMs: expect.any(Number),
        servePort: selectedPort,
        activationDispatched: true,
        activationSucceeded: true,
        activationURL: invocation.activationURL,
        disposalDispatched: true,
        disposalSucceeded: true,
        disposalURL: invocation.disposalURL,
      })
      expect(autoExitState.stabilityMs).toBeGreaterThan(25)

      const provenance = JSON.parse(
        await readFile(
          path.join(fixture.configDirectory, ".opencode-debug-child.json"),
          "utf8"
        )
      ) as { childArgv: string[]; childExecutable: string; servePort: number }
      expect(provenance).toEqual({
        childArgv: invocation.childArgv,
        childExecutable: openCode.binary,
        servePort: selectedPort,
      })

      for (const name of [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
        "TMPDIR",
      ]) {
        expect(pathInside(fixture.root, fixture.env[name]!)).toBe(true)
      }

      const config = JSON.parse(invocation.configContent ?? "") as {
        instructions?: string[]
        plugin?: Array<[
          string,
          {
            launchID: string
            expectedOpenCodeRuntimeVersion: string
            taskResumeCapability?: string
          },
        ]>
      }
      expect(config.instructions).toEqual([safetyInstructionsPath])
      expect(config.plugin).toHaveLength(1)
      const pluginTuple = config.plugin?.[0]
      const taskResumeCapability = invocation.env[REMOTE_ENV.taskResumeCapability]
      const expectedOpenCodeRuntimeVersion =
        invocation.env[REMOTE_ENV.expectedOpenCodeRuntimeVersion]
      expect(expectedOpenCodeRuntimeVersion).toMatch(
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/u
      )
      expect([undefined, TASK_RESUME_PROTOCOL]).toContain(taskResumeCapability)
      expect(pluginTuple).toEqual([
        packageRootURL.href,
        {
          launchID: invocation.env[REMOTE_ENV.launchID],
          expectedOpenCodeRuntimeVersion,
          ...(taskResumeCapability === undefined
            ? {}
            : { taskResumeCapability }),
        },
      ])
      expect(pluginTuple?.[0]).not.toContain("/src/")
      expect(pluginTuple?.[0]).not.toContain("/dist/")

      const readyPath = invocation.env[REMOTE_ENV.readyPath]
      const socketPath = invocation.env[REMOTE_ENV.socket]
      const mirrorPath = invocation.env[REMOTE_ENV.mirrorRoot]
      expect(await pathExists(readyPath)).toBe(false)
      expect(await pathExists(socketPath)).toBe(false)
      expect(await pathExists(mirrorPath)).toBe(false)
      expect(await pathExists(`${socketPath}.fake-ssh-master`)).toBe(false)

      const sshCalls = parseJsonLines<string[]>(await readFile(fixture.sshLog, "utf8"))
      expect(sshCalls).toContainEqual([
        "-MN",
        "-o",
        "ControlMaster=yes",
        "-o",
        "ControlPersist=no",
        "-o",
        `ControlPath=${socketPath}`,
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "--",
        alias,
      ])
      expect(sshCalls).toContainEqual(["-S", socketPath, "-O", "exit", "--", alias])

      const remoteCalls = sshCalls.filter((call) => call[0] === "-T")
      expect(remoteCalls).toHaveLength(3)
      for (const call of remoteCalls) {
        expect(valueAfter(call, "-S")).toBe(socketPath)
        expect(valueAfter(call, "--")).toBe(alias)
      }

      const sshInputs = parseJsonLines<string>(await readFile(fixture.sshInputLog, "utf8"))
      expect(sshInputs).toEqual([
        `cd '${requestedWorkdir}' || exit $?\npwd -P`,
        "uname -s",
        `git -C '${canonicalWorkdir}' rev-parse --is-inside-work-tree 2>/dev/null`,
      ])
      expect(sshInputs.some((input) => input.includes("AGENTS.md"))).toBe(false)

      const expectedLogEvents = [
        "startup.begin",
        "probe.runtime_health.started",
        "compatibility.completed",
        "launch.context.created",
        "plugin.production.activation",
        "plugin.runtime_health.completed",
        "plugin.ready_publication.completed",
        "ready.stable",
        "plugin.disposal.started",
        "plugin.disposal.completed",
        "launch.cleanup.started",
        "launch.cleanup.completed",
        "launch.exit",
      ]
      const records = await waitForJsonLogRecords(
        fixture.env,
        expectedLogEvents
      )
      assertStartupCorrelation(records)
      expect(new Set(records.map((record) => record.fields?.component))).toEqual(
        new Set([
          "launcher",
          "compatibility",
          "compatibility-probe",
          "server-plugin",
        ])
      )
      expectLogEvents(records, expectedLogEvents)

      const probeHealth = requireLogEvent(
        records,
        "probe.runtime_health.started"
      )
      const compatibility = requireLogEvent(records, "compatibility.completed")
      const productionHealth = requireLogEvent(
        records,
        "plugin.runtime_health.completed"
      )
      const productionDisposal = requireLogEvent(
        records,
        "plugin.disposal.completed"
      )
      expect(probeHealth.pid).not.toBe(process.pid)
      expect(compatibility.pid).toBe(process.pid)
      expect(productionHealth.pid).not.toBe(process.pid)
      expect(productionHealth.pid).not.toBe(probeHealth.pid)
      expect(productionDisposal.pid).toBe(productionHealth.pid)
      expect(probeHealth.fields).toMatchObject({
        component: "compatibility-probe",
      })
      expect(compatibility.fields).toMatchObject({
        component: "compatibility",
        loaderRuntimeVersionSource: "client._client.get",
        callableSessionLookup: true,
      })
      expect(productionHealth.fields).toMatchObject({
        component: "server-plugin",
        runtimeVersionSource: "client._client.get",
        launchID: invocation.env[REMOTE_ENV.launchID],
        targetID: invocation.env[REMOTE_ENV.targetID],
      })
      expect(productionDisposal.fields).toMatchObject({
        component: "server-plugin",
        launchID: invocation.env[REMOTE_ENV.launchID],
        targetID: invocation.env[REMOTE_ENV.targetID],
      })
      expect(requireLogEvent(records, "ready.stable").fields).toMatchObject({
        component: "launcher",
        launchID: invocation.env[REMOTE_ENV.launchID],
        targetID: invocation.env[REMOTE_ENV.targetID],
      })
      expect(
        requireLogEvent(records, "launch.cleanup.completed").fields
      ).toMatchObject({
        component: "launcher",
        launchID: invocation.env[REMOTE_ENV.launchID],
        targetID: invocation.env[REMOTE_ENV.targetID],
        failureCount: 0,
        failedSteps: [],
      })
    },
    75_000
  )

  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "runs the installed target-free probe without contacting the health decoy",
    async () => {
      if (openCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }
      const fixture = await createSelfTestFixture(openCode.binary)
      const selectedVersion = await readInstalledOpenCodeVersion(
        openCode.binary,
        fixture.env
      )
      const decoy = await startHealthDecoy(selectedVersion)

      try {
        await expect(runCli(["self-test"], fixture.env)).resolves.toBe(0)
      } finally {
        await decoy.close()
      }
      expect(decoy.addresses.length).toBeGreaterThan(0)
      expect(decoy.connections).toBe(0)
      expect(decoy.requests).toBe(0)
      expect(await pathExists(fixture.sshLog)).toBe(false)
      expect(await pathExists(fixture.sftpLog)).toBe(false)

      const expectedLogEvents = [
        "startup.begin",
        "probe.activation",
        "probe.runtime_health.started",
        "compatibility.completed",
        "launch.cleanup.started",
        "launch.cleanup.completed",
        "startup.exit",
      ]
      const records = await waitForJsonLogRecords(
        fixture.env,
        expectedLogEvents
      )
      assertStartupCorrelation(records)
      expect(new Set(records.map((record) => record.fields?.component))).toEqual(
        new Set(["launcher", "compatibility", "compatibility-probe"])
      )

      const probeHealth = requireLogEvent(
        records,
        "probe.runtime_health.started"
      )
      expect(probeHealth.pid).not.toBe(process.pid)
      expect(probeHealth.fields).toMatchObject({
        component: "compatibility-probe",
      })
      const compatibility = requireLogEvent(records, "compatibility.completed")
      expect(compatibility.pid).toBe(process.pid)
      expect(compatibility.fields).toMatchObject({
        component: "compatibility",
        loaderRuntimeVersionSource: "client._client.get",
        callableSessionLookup: true,
      })
      expectLogEvents(records, expectedLogEvents)
      expect(
        records.some((record) => record.event.startsWith("ssh."))
      ).toBe(false)
      expect(
        records.some((record) => record.event.startsWith("plugin.production."))
      ).toBe(false)
    },
    45_000
  )

  it("forwards probe termination from the debug wrapper to its child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-debug-signal-"))
    temporaryRoots.push(root)
    const pidFile = path.join(root, "child.pid")
    const descendantPidFile = path.join(root, "descendant.pid")
    const result = await spawnProcess(fakeOpenCode, ["--version"], {
      env: {
        ...scrubFixtureEnvironment(process.env),
        FAKE_OPENCODE_REAL_BIN: fakeVersionOpenCode,
        FAKE_OPENCODE_VERSION_DELAY_MS: "10000",
        FAKE_OPENCODE_PID_FILE: pidFile,
        FAKE_OPENCODE_SPAWN_DESCENDANT: "1",
        FAKE_OPENCODE_DESCENDANT_PID_FILE: descendantPidFile,
      },
      timeoutMs: 500,
      killGraceMs: 2_000,
    })

    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeLessThan(2_000)
    const childPid = Number((await readFile(pidFile, "utf8")).trim())
    const descendantPid = Number((await readFile(descendantPidFile, "utf8")).trim())
    expect(() => process.kill(childPid, 0)).toThrow()
    expect(() => process.kill(descendantPid, 0)).toThrow()
  })
})

interface LoaderFixture {
  autoExitStatePath: string
  configDirectory: string
  env: NodeJS.ProcessEnv
  openCodeLog: string
  root: string
  serveStatePath: string
  sshInputLog: string
  sshLog: string
}

interface SelfTestFixture {
  env: NodeJS.ProcessEnv
  root: string
  sftpLog: string
  sshLog: string
}

interface HealthDecoy {
  readonly addresses: readonly LoopbackAddress[]
  readonly connections: number
  readonly requests: number
  close(): Promise<void>
}

interface LoopbackAddress {
  readonly address: string
  readonly family: 4 | 6
}

async function createFixture(
  realOpenCode: string,
  requestedWorkdir: string,
  canonicalWorkdir: string
): Promise<LoaderFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocssh-opencode-loader-"))
  temporaryRoots.push(root)

  const directories = {
    home: path.join(root, "home"),
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
    runtime: path.join(root, "run"),
    temporary: path.join(root, "tmp"),
  }
  const configDirectory = path.join(
    directories.cache,
    "opencode-ssh",
    "probe-config-home",
    "opencode"
  )
  await Promise.all(
    [...Object.values(directories), configDirectory].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 })
    )
  )

  const openCodeLog = path.join(root, "opencode.jsonl")
  const serveStatePath = path.join(root, "serve-state.json")
  const autoExitStatePath = path.join(root, "serve-auto-exit-state.json")
  const sshLog = path.join(root, "ssh.jsonl")
  const sshInputLog = path.join(root, "ssh-input.jsonl")
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: directories.home,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
    XDG_CACHE_HOME: directories.cache,
    XDG_STATE_HOME: directories.state,
    XDG_RUNTIME_DIR: directories.runtime,
    TMPDIR: directories.temporary,
    OPENCODE_CONFIG_DIR: configDirectory,
    SHELL: "/bin/sh",
    USER: "opencode-loader-test",
    LOGNAME: "opencode-loader-test",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_SSH_OPENCODE_BIN: fakeOpenCode,
    [REMOTE_ENV.sshBinary]: fakeSsh,
    [REMOTE_ENV.sftpBinary]: fakeSftp,
    FAKE_OPENCODE_REAL_BIN: realOpenCode,
    FAKE_OPENCODE_SERVE: "1",
    FAKE_OPENCODE_SERVE_STATE: serveStatePath,
    FAKE_OPENCODE_SERVE_AUTO_EXIT_AFTER_READY: "1",
    FAKE_OPENCODE_SERVE_AUTO_EXIT_STATE: autoExitStatePath,
    FAKE_OPENCODE_LOG: openCodeLog,
    FAKE_OPENCODE_REPLACE_CHILD_PROVENANCE: "1",
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_INPUT_LOG: sshInputLog,
    FAKE_SSH_RESPONSES: JSON.stringify([
      {
        input: `cd '${requestedWorkdir}' || exit $?\npwd -P`,
        stdout: `${canonicalWorkdir}\n`,
      },
      { input: "uname -s", stdout: "Linux\n" },
      {
        input: `git -C '${canonicalWorkdir}' rev-parse --is-inside-work-tree 2>/dev/null`,
        stdout: "true\n",
      },
    ]),
    FAKE_SSH_FAIL_UNMATCHED: "1",
    FAKE_SFTP_LOG: path.join(root, "sftp.jsonl"),
    FAKE_SFTP_EXIT_CODE: "0",
  }

  return {
    autoExitStatePath,
    configDirectory,
    env,
    openCodeLog,
    root,
    serveStatePath,
    sshInputLog,
    sshLog,
  }
}

async function createSelfTestFixture(
  binary: string
): Promise<SelfTestFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocssh-opencode-self-test-"))
  temporaryRoots.push(root)
  const directories = {
    home: path.join(root, "home"),
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
    runtime: path.join(root, "run"),
    temporary: path.join(root, "tmp"),
  }
  const configDirectory = path.join(directories.config, "opencode")
  await Promise.all(
    [...Object.values(directories), configDirectory].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 })
    )
  )

  const sshLog = path.join(root, "ssh.jsonl")
  const sftpLog = path.join(root, "sftp.jsonl")
  const env: NodeJS.ProcessEnv = {
    ...npmTransportEnvironment(process.env),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: directories.home,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
    XDG_CACHE_HOME: directories.cache,
    XDG_STATE_HOME: directories.state,
    XDG_RUNTIME_DIR: directories.runtime,
    TMPDIR: directories.temporary,
    OPENCODE_CONFIG_DIR: configDirectory,
    SHELL: "/bin/sh",
    USER: "opencode-self-test",
    LOGNAME: "opencode-self-test",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
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
    OPENCODE_SSH_OPENCODE_BIN: binary,
    [REMOTE_ENV.sshBinary]: fakeSsh,
    [REMOTE_ENV.sftpBinary]: fakeSftp,
    FAKE_SSH_LOG: sshLog,
    FAKE_SFTP_LOG: sftpLog,
  }
  return { env, root, sftpLog, sshLog }
}

async function startHealthDecoy(version: string): Promise<HealthDecoy> {
  const addresses = await resolveLocalhostLoopbackAddresses()
  let connections = 0
  let requests = 0
  let closePromise: Promise<void> | undefined
  const servers: Server[] = []

  try {
    for (const target of addresses) {
      const server = createServer((request, response) => {
        requests += 1
        request.resume()
        const body = `${JSON.stringify({ healthy: true, version })}\n`
        response.writeHead(200, {
          "connection": "close",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
        })
        response.end(body)
      })
      server.on("connection", () => {
        connections += 1
      })
      servers.push(server)
      try {
        await listenHealthServer(server, target)
      } catch (error) {
        throw new Error(
          `Installed OpenCode target-free decoy could not reserve localhost address ${formatLoopbackEndpoint(target)}: ${errorMessage(error)}`,
          { cause: error }
        )
      }
    }
  } catch (error) {
    try {
      await closeHttpServers(servers)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${errorMessage(error)}; decoy listener cleanup also failed`,
        { cause: error }
      )
    }
    throw error
  }

  return {
    addresses,
    get connections() {
      return connections
    },
    get requests() {
      return requests
    },
    close() {
      closePromise ??= closeHttpServers(servers)
      return closePromise
    },
  }
}

async function resolveLocalhostLoopbackAddresses(): Promise<LoopbackAddress[]> {
  let resolved: Array<{ address: string; family: number }>
  try {
    resolved = await lookup("localhost", { all: true, verbatim: true })
  } catch (error) {
    throw new Error(
      `Installed OpenCode target-free decoy could not resolve localhost: ${errorMessage(error)}`,
      { cause: error }
    )
  }
  if (resolved.length === 0) {
    throw new Error(
      "Installed OpenCode target-free decoy resolved localhost without any addresses"
    )
  }

  const unique = new Map<string, LoopbackAddress>()
  for (const candidate of resolved) {
    if (candidate.family !== 4 && candidate.family !== 6) {
      throw new Error(
        `localhost resolved with unsupported address family ${candidate.family}`
      )
    }
    const target: LoopbackAddress = {
      address: normalizeIPAddress(candidate.address, candidate.family),
      family: candidate.family,
    }
    if (!isLoopbackAddress(target)) {
      throw new Error(
        `localhost resolved to non-loopback address ${formatAddress(target)}`
      )
    }
    unique.set(`${target.family}:${target.address}`, target)
  }
  return [...unique.values()]
}

function normalizeIPAddress(address: string, family: 4 | 6): string {
  if (isIP(address) !== family) {
    throw new Error(
      `localhost resolved to invalid IPv${family} address ${JSON.stringify(address)}`
    )
  }
  if (family === 4) return address

  const hostname = new URL(`http://[${address}]/`).hostname
  return hostname.slice(1, -1).toLowerCase()
}

function isLoopbackAddress(target: LoopbackAddress): boolean {
  if (target.family === 4) return target.address.startsWith("127.")
  if (target.address === "::1") return true

  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/u.exec(
    target.address
  )
  return mapped !== null && (Number.parseInt(mapped[1], 16) & 0xff00) === 0x7f00
}

function formatAddress(target: LoopbackAddress): string {
  return target.family === 6 ? `[${target.address}]` : target.address
}

function formatLoopbackEndpoint(target: LoopbackAddress): string {
  return `${formatAddress(target)}:4096 (IPv${target.family})`
}

async function listenHealthServer(
  server: Server,
  target: LoopbackAddress
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    try {
      server.listen({
        host: target.address,
        port: 4_096,
        exclusive: true,
        ...(target.family === 6 ? { ipv6Only: true } : {}),
      })
    } catch (error) {
      server.removeListener("error", onError)
      server.removeListener("listening", onListening)
      reject(error)
    }
  })
}

async function closeHttpServers(servers: readonly Server[]): Promise<void> {
  const outcomes = await Promise.allSettled(
    servers.map((server) => closeHttpServer(server))
  )
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : []
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, "Multiple decoy listeners failed to close")
  }
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections()
    return
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
}

async function readInstalledOpenCodeVersion(
  binary: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const result = await spawnProcess(binary, ["--version"], {
    env,
    timeoutMs: 5_000,
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
    terminationMode: "process-group",
    stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
  })
  const version = result.stdout.trim()
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.termination !== null ||
    result.stdoutTruncated ||
    result.stderrTruncated ||
    !OPEN_CODE_VERSION.test(version)
  ) {
    throw new Error(
      `Installed OpenCode returned an invalid version result (${JSON.stringify({
        exitCode: result.exitCode,
        signal: result.signal,
        termination: result.termination,
        stdout: result.stdout,
        stderr: result.stderr,
      })})`
    )
  }
  return version
}

function npmTransportEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  const names = new Set([
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
      (/^npm_config_/iu.test(name) || names.has(name.toUpperCase()))
    ) {
      result[name] = value
    }
  }
  if (!Object.keys(result).some((name) => name.toLowerCase() === "npm_config_userconfig")) {
    result.npm_config_userconfig = path.join(source.HOME ?? os.homedir(), ".npmrc")
  }
  return result
}

async function readJsonLogRecords(
  env: NodeJS.ProcessEnv
): Promise<JsonLogRecord[]> {
  const directory = path.dirname(resolveDailyLogFilePath({ env }))
  const files = (await readdir(directory))
    .filter((name) => /^opencode-ssh-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
    .sort()
  if (files.length === 0) throw new Error("OpenCode SSH did not create a daily JSONL log")
  const contents = await Promise.all(
    files.map((name) => readFile(path.join(directory, name), "utf8"))
  )
  return contents.flatMap((value) => parseJsonLines<JsonLogRecord>(value))
}

async function waitForJsonLogRecords(
  env: NodeJS.ProcessEnv,
  expectedEvents: readonly string[],
  timeoutMs = 2_000
): Promise<JsonLogRecord[]> {
  const deadline = Date.now() + timeoutMs
  let records = await readJsonLogRecords(env)
  while (
    !expectedEvents.every((event) =>
      records.some((record) => record.event === event)
    ) &&
    Date.now() < deadline
  ) {
    await delay(25)
    records = await readJsonLogRecords(env)
  }
  return records
}

function assertStartupCorrelation(records: readonly JsonLogRecord[]): void {
  expect(records.length).toBeGreaterThan(0)
  const startupIDs = records.map((record) => record.fields?.startupID)
  expect(startupIDs.every((value) => typeof value === "string")).toBe(true)
  expect(
    startupIDs.every(
      (value) => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value)
    )
  ).toBe(true)
  expect(new Set(startupIDs).size).toBe(1)
  expect(
    records.every(
      (record) =>
        typeof record.timestamp === "string" &&
        Number.isSafeInteger(record.pid) &&
        record.pid > 0
    )
  ).toBe(true)
}

function expectLogEvents(
  records: readonly JsonLogRecord[],
  expectedEvents: readonly string[]
): void {
  const events = new Set(records.map((record) => record.event))
  for (const event of expectedEvents) {
    expect(
      events.has(event),
      `missing JSONL event ${event}; observed ${JSON.stringify([...events])}`
    ).toBe(true)
  }
}

function requireLogEvent(
  records: readonly JsonLogRecord[],
  event: string
): JsonLogRecord {
  const record = records.find((candidate) => candidate.event === event)
  if (!record) throw new Error(`Missing JSONL event ${event}`)
  return record
}

type OpenCodeAvailability =
  | { kind: "available"; binary: string }
  | { kind: "absent"; reason: string }

function detectOpenCode(): OpenCodeAvailability {
  const binary = findExecutable("opencode")
  if (!binary) {
    return { kind: "absent", reason: "the opencode executable is not on PATH" }
  }

  return { kind: "available", binary }
}

function findExecutable(command: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined
}

function parseJsonLines<T>(contents: string): T[] {
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false
  )
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function servePortFromArgv(argv: readonly string[]): number {
  const match =
    argv.length === 3 &&
    argv[0] === "serve" &&
    argv[1] === "--hostname=127.0.0.1"
      ? /^--port=([1-9]\d*)$/u.exec(argv[2] ?? "")
      : null
  const port = Number(match?.[1])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid OpenCode serve argv: ${JSON.stringify(argv)}`)
  }
  return port
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
