import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../src/cli.js"
import { REMOTE_ENV } from "../../src/config.js"
import { computeTargetID } from "../../src/runtime-paths.js"
import {
  TASK_RESUME_PROTOCOL,
  TASK_RESUME_QUALIFIED_OPENCODE_VERSION,
} from "../../src/task-resume-capability.js"
import { scrubFixtureEnvironment } from "../helpers/fixture-environment.js"

const fakeOpenCode = fileURLToPath(new URL("../fixtures/bin/opencode", import.meta.url))
const fakeOpenCodeDebug = fileURLToPath(
  new URL("../fixtures/bin/opencode-debug", import.meta.url)
)
const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const safetyInstructionsPath = fileURLToPath(
  new URL("../../opencode-ssh-remote-use/opencode-ssh-safety.md", import.meta.url)
)
const temporaryRoots: string[] = []

interface OpenCodeInvocation {
  argv: string[]
  cwd: string
  PWD?: string
  configContent?: string
  env: Record<string, string>
  readyNonceHash?: string
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("launcher lifecycle", () => {
  it("scrubs hostile ambient fake controls from the launcher fixture", async () => {
    const hostile = {
      FAKE_OPENCODE_IGNORE_SIGTERM: "1",
      FAKE_SFTP_DELAY_MS: "60000",
      FAKE_SSH_COMMAND_DELAY_MS: "60000",
      FAKE_SSH_NEVER_READY: "1",
      FAKE_SSH_RESPONSES: "not-json",
    }
    const saved = new Map(
      Object.keys(hostile).map((name) => [name, process.env[name]])
    )
    Object.assign(process.env, hostile)

    try {
      const fixture = await createFixture("/srv/hostile-ambient", {
        FAKE_OPENCODE_WRITE_READY: "1",
        FAKE_OPENCODE_EXIT_CODE: "0",
      })
      for (const name of Object.keys(hostile)) {
        expect(fixture.env[name]).toBeUndefined()
      }
      await expect(
        runCli(["hostile-ambient-host", "/srv/requested"], fixture.env)
      ).resolves.toBe(0)
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("launches OpenCode without forwarded args and cleans each launch-specific artifact", async () => {
    const alias = "deploy-host.example"
    const requestedWorkdir = "/srv/link workspace"
    const canonicalWorkdir = "/srv/canonical workspace"
    const existingConfig = {
      model: "provider/model",
      mcp: { search: { enabled: true } },
      instructions: ["keep normal instructions"],
      plugin: ["existing-plugin", ["file:///tmp/other-plugin.js", { enabled: true }]],
    }
    const secret = "must-not-appear-in-the-fake-opencode-log"
    const fixture = await createFixture(canonicalWorkdir, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(existingConfig),
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "30",
      FAKE_OPENCODE_EXIT_CODE: "23",
      [REMOTE_ENV.expectedOpenCodeRuntimeVersion]: "9.9.9",
      UNRELATED_PROVIDER_SECRET: secret,
    })

    await expect(runCli([alias, requestedWorkdir], fixture.env)).resolves.toBe(23)
    await expect(runCli([alias, requestedWorkdir], fixture.env)).resolves.toBe(23)

    const rawOpenCodeLog = await readFile(fixture.openCodeLog, "utf8")
    const invocations = parseJsonLines<OpenCodeInvocation>(rawOpenCodeLog)
    const expectedTargetID = computeTargetID(alias, canonicalWorkdir)
    const expectedWorkspace = path.join(
      fixture.stateHome,
      "opencode-ssh",
      expectedTargetID,
      "workspace"
    )

    expect(invocations).toHaveLength(2)
    expect(rawOpenCodeLog).not.toContain(secret)
    expect(invocations[0].env[REMOTE_ENV.launchID]).not.toBe(
      invocations[1].env[REMOTE_ENV.launchID]
    )
    expect(invocations[0].env[REMOTE_ENV.readyPath]).not.toBe(
      invocations[1].env[REMOTE_ENV.readyPath]
    )

    for (const invocation of invocations) {
      expect(invocation.argv).toEqual([])
      expect(invocation.cwd).toBe(expectedWorkspace)
      expect(invocation.PWD).toBe(expectedWorkspace)
      expect(invocation.readyNonceHash).toMatch(/^[a-f0-9]{64}$/)
      expect(invocation.env).toMatchObject({
        [REMOTE_ENV.alias]: alias,
        [REMOTE_ENV.workdir]: canonicalWorkdir,
        [REMOTE_ENV.targetID]: expectedTargetID,
        [REMOTE_ENV.sshBinary]: fakeSsh,
        [REMOTE_ENV.sftpBinary]: fakeSftp,
        [REMOTE_ENV.expectedOpenCodeRuntimeVersion]:
          TASK_RESUME_QUALIFIED_OPENCODE_VERSION,
        [REMOTE_ENV.taskResumeCapability]: TASK_RESUME_PROTOCOL,
        OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
      })
      expect(invocation.env).not.toHaveProperty("UNRELATED_PROVIDER_SECRET")

      const merged = JSON.parse(invocation.configContent ?? "") as typeof existingConfig
      expect(merged.model).toBe(existingConfig.model)
      expect(merged.mcp).toEqual(existingConfig.mcp)
      expect(merged.instructions).toEqual([
        ...existingConfig.instructions,
        safetyInstructionsPath,
      ])
      expect(merged.plugin.slice(0, existingConfig.plugin.length)).toEqual(
        existingConfig.plugin
      )
      expect(merged.plugin).toHaveLength(existingConfig.plugin.length + 1)
      const injected = merged.plugin.at(-1) as unknown as [
        string,
        {
          launchID: string
          expectedOpenCodeRuntimeVersion: string
          taskResumeCapability: string
        },
      ]
      expect(injected[0]).toMatch(/^file:.*\/$/)
      expect(injected[0]).not.toContain("/src/")
      expect(injected[1]).toEqual({
        launchID: invocation.env[REMOTE_ENV.launchID],
        expectedOpenCodeRuntimeVersion:
          TASK_RESUME_QUALIFIED_OPENCODE_VERSION,
        taskResumeCapability: TASK_RESUME_PROTOCOL,
      })

      const readyPath = invocation.env[REMOTE_ENV.readyPath]
      const socketPath = invocation.env[REMOTE_ENV.socket]
      const mirrorPath = invocation.env[REMOTE_ENV.mirrorRoot]
      expect(await pathExists(readyPath)).toBe(false)
      expect(await pathExists(socketPath)).toBe(false)
      expect(await pathExists(mirrorPath)).toBe(false)
      expect(await pathExists(`${socketPath}.fake-ssh-master`)).toBe(false)
    }

    const stateEntries = await readdir(path.dirname(invocations[0].env[REMOTE_ENV.readyPath]))
    expect(stateEntries.filter((entry) => entry.includes("plugin-ready"))).toEqual([])
    await expect
      .poll(() => readdir(invocations[0].env[REMOTE_ENV.runtimeDir]), {
        interval: 20,
        timeout: 2_000,
      })
      .toEqual([])

    const sshCalls = parseJsonLines<string[]>(await readFile(fixture.sshLog, "utf8"))
    for (const call of sshCalls) {
      const separator = call.indexOf("--")
      expect(separator).toBeGreaterThanOrEqual(0)
      expect(call[separator + 1]).toBe(alias)
    }
    expect(sshCalls.filter((call) => valueAfter(call, "-O") === "exit")).toHaveLength(2)
  })

  it("fails closed quickly when OpenCode exits without becoming ready", async () => {
    const alias = "unready-host"
    const fixture = await createFixture("/srv/unready", {
      FAKE_OPENCODE_DELAY_MS: "20",
      FAKE_OPENCODE_EXIT_CODE: "29",
    })
    const startedAt = Date.now()

    const error = await runCli([alias, "/srv/requested"], fixture.env).catch(
      (value: unknown) => value
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(
      /OpenCode exited before the remote plugin became ready \(exit code 29\)/
    )
    expect(Date.now() - startedAt).toBeLessThan(5_000)

    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    const readyPath = invocation.env[REMOTE_ENV.readyPath]
    const socketPath = invocation.env[REMOTE_ENV.socket]
    expect(await pathExists(readyPath)).toBe(false)
    expect(await pathExists(socketPath)).toBe(false)
    expect(await pathExists(`${socketPath}.fake-ssh-master`)).toBe(false)

    const sshCalls = parseJsonLines<string[]>(await readFile(fixture.sshLog, "utf8"))
    expect(sshCalls.filter((call) => valueAfter(call, "-O") === "exit")).toEqual([
      ["-S", socketPath, "-O", "exit", "--", alias],
    ])
  }, 10_000)

  it("preserves the startup error, reports cleanup failure, and continues cleanup", async () => {
    const alias = "cleanup-failure-host"
    const fixture = await createFixture("/srv/cleanup-failure", {
      FAKE_OPENCODE_DELAY_MS: "20",
      FAKE_OPENCODE_EXIT_CODE: "29",
      FAKE_SSH_CONTROL_EXIT_CODE: "7",
    })
    const sigintListeners = process.listenerCount("SIGINT")
    const sigtermListeners = process.listenerCount("SIGTERM")

    const error = await runCli([alias, "/srv/requested"], fixture.env).catch(
      (value: unknown) => value
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as Error).message).toMatch(
      /OpenCode exited before the remote plugin became ready \(exit code 29\).*cleanup also failed.*master/i
    )
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringMatching(/OpenCode exited before.*exit code 29/i),
    })
    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    expect(await pathExists(invocation.env[REMOTE_ENV.readyPath])).toBe(false)
    expect(await pathExists(invocation.env[REMOTE_ENV.mirrorRoot])).toBe(false)
    expect(await pathExists(invocation.env[REMOTE_ENV.socket])).toBe(false)
    expect(await pathExists(`${invocation.env[REMOTE_ENV.socket]}.fake-ssh-master`)).toBe(
      false
    )
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners)
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners)
  }, 15_000)

  it("does not return a successful launch result when cleanup is known to fail", async () => {
    const fixture = await createFixture("/srv/cleanup-only-failure", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "20",
      FAKE_OPENCODE_EXIT_CODE: "0",
      FAKE_SSH_CONTROL_EXIT_CODE: "7",
    })

    const error = await runCli(
      ["cleanup-only-failure-host", "/srv/requested"],
      fixture.env
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as Error).message).toMatch(/OpenCode SSH cleanup failed.*master/i)
  }, 15_000)

  it("preserves SIGTERM exit semantics and warns when cleanup is incomplete", async () => {
    const fixture = await createFixture("/srv/signal-cleanup-failure", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_OPENCODE_ACTIVE_MARKER: "pending",
    })
    const activeMarker = path.join(path.dirname(fixture.openCodeLog), "signal-active")
    fixture.env.FAKE_OPENCODE_ACTIVE_MARKER = activeMarker
    const previousListeners = new Set(process.listeners("SIGTERM"))
    const warnings: string[] = []
    const launch = runCli(
      ["signal-cleanup-failure-host", "/srv/requested"],
      fixture.env,
      { writeWarning: (message) => warnings.push(message) }
    )
    await expect.poll(() => pathExists(activeMarker), {
      interval: 10,
      timeout: 3_000,
    }).toBe(true)
    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    const readyPath = invocation.env[REMOTE_ENV.readyPath]
    await rm(readyPath, { force: true })
    await mkdir(readyPath)
    const signalListener = process
      .listeners("SIGTERM")
      .find((listener) => !previousListeners.has(listener))
    expect(signalListener).toEqual(expect.any(Function))

    signalListener!("SIGTERM")

    await expect(launch).resolves.toBe(143)
    expect(warnings).toEqual([
      expect.stringMatching(/cleanup after SIGTERM was incomplete.*ready-marker/i),
    ])
  }, 10_000)

  it("accepts a valid ready handshake written immediately before OpenCode exits", async () => {
    const fixture = await createFixture("/srv/immediate-ready", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_EXIT_CODE: "23",
    })

    await expect(
      runCli(["immediate-ready-host", "/srv/requested"], fixture.env)
    ).resolves.toBe(23)
  })

  it("terminates OpenCode promptly and reports a pre-ready ControlMaster exit", async () => {
    const fixture = await createFixture("/srv/master-before-ready", {
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_SSH_MASTER_EXIT_CODE: "41",
      FAKE_OPENCODE_START_MARKER: "pending",
      FAKE_SSH_MASTER_EXIT_MARKER: "pending",
    })
    const markerPath = path.join(path.dirname(fixture.openCodeLog), "opencode-started")
    fixture.env.FAKE_OPENCODE_START_MARKER = markerPath
    fixture.env.FAKE_SSH_MASTER_EXIT_MARKER = markerPath
    const startedAt = Date.now()

    const error = await runCli(
      ["pre-ready-master-host", "/srv/requested"],
      fixture.env
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(
      /SSH ControlMaster exited before the remote plugin became ready \(exit code 41\)/
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  }, 10_000)

  it("reports a master that dies after readiness while OpenCode remains active", async () => {
    const fixture = await createFixture("/srv/master-after-ready", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_SSH_MASTER_EXIT_CODE: "42",
      FAKE_OPENCODE_ACTIVE_MARKER: "pending",
      FAKE_OPENCODE_ACTIVE_MARKER_DELAY_MS: "200",
      FAKE_SSH_MASTER_EXIT_MARKER: "pending",
    })
    const markerPath = path.join(path.dirname(fixture.openCodeLog), "opencode-active")
    fixture.env.FAKE_OPENCODE_ACTIVE_MARKER = markerPath
    fixture.env.FAKE_SSH_MASTER_EXIT_MARKER = markerPath

    await expect(
      runCli(["active-master-host", "/srv/requested"], fixture.env)
    ).rejects.toThrow(
      /SSH ControlMaster exited while OpenCode was running \(exit code 42\)/
    )
  }, 10_000)

  it("does not activate when readiness and master death are nearly simultaneous", async () => {
    const fixture = await createFixture("/srv/master-ready-race", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_OPENCODE_READY_MARKER: "pending",
      FAKE_SSH_MASTER_EXIT_CODE: "43",
      FAKE_SSH_MASTER_EXIT_MARKER: "pending",
    })
    const markerPath = path.join(path.dirname(fixture.openCodeLog), "ready-master-race")
    fixture.env.FAKE_OPENCODE_READY_MARKER = markerPath
    fixture.env.FAKE_SSH_MASTER_EXIT_MARKER = markerPath

    await expect(
      runCli(["ready-master-race-host", "/srv/requested"], fixture.env)
    ).rejects.toThrow(
      /SSH ControlMaster exited before the remote plugin became ready \(exit code 43\)/
    )
  }, 10_000)

  it("warns after a successful compatibility check for another version", async () => {
    const alias = "future-version-host"
    const fixture = await createFixture("/srv/future-version", {
      FAKE_OPENCODE_VERSION_STDOUT: "9.8.7\n",
      npm_config_opencode_ssh_probe_runtime_version: "9.8.7",
      [REMOTE_ENV.expectedOpenCodeRuntimeVersion]: "1.18.18",
      [REMOTE_ENV.taskResumeCapability]: TASK_RESUME_PROTOCOL,
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "30",
      FAKE_OPENCODE_EXIT_CODE: "17",
    })
    const warnings: string[] = []
    const progress: string[] = []

    await expect(
      runCli([alias, "/srv/requested"], fixture.env, {
        writeWarning: (message) => warnings.push(message),
        writeProgress: (message) => progress.push(message),
      })
    ).resolves.toBe(17)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("OpenCode 9.8.7 passed the loader check")
    expect(warnings[0]).toContain("Task resume is disabled")
    expect(progress).toEqual([
      "checking OpenCode compatibility...",
      "testing OpenCode 9.8.7 plugin loader...",
      expect.stringMatching(/^compatibility passed/u),
      "starting SSH session...",
    ])
    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    expect(invocation.env[REMOTE_ENV.taskResumeCapability]).toBeUndefined()
    expect(
      invocation.env[REMOTE_ENV.expectedOpenCodeRuntimeVersion]
    ).toBe("9.8.7")
    const config = JSON.parse(invocation.configContent ?? "") as {
      plugin: Array<[string, Record<string, unknown>]>
    }
    expect(config.plugin.at(-1)?.[1]).not.toHaveProperty("taskResumeCapability")
    expect(config.plugin.at(-1)?.[1]).toMatchObject({
      expectedOpenCodeRuntimeVersion: "9.8.7",
    })
  }, 10_000)

  it("runs the installed-style self-test without starting SSH", async () => {
    const fixture = await createFixture("/srv/unused")
    const progress: string[] = []

    await expect(
      runCli(["self-test"], fixture.env, {
        writeProgress: (message) => progress.push(message),
      })
    ).resolves.toBe(0)

    expect(progress.at(-1)).toBe(
      "self-test passed (OpenCode 1.18.18; Task resume enabled)"
    )
    expect(await pathExists(fixture.sshLog)).toBe(false)
    expect(await pathExists(fixture.openCodeLog)).toBe(false)
  })

  it("reports disabled resume for an unqualified self-test binary", async () => {
    const fixture = await createFixture("/srv/unused", {
      FAKE_OPENCODE_VERSION_STDOUT: "1.18.19\n",
      npm_config_opencode_ssh_probe_runtime_version: "1.18.19",
    })
    const progress: string[] = []

    await expect(
      runCli(["self-test"], fixture.env, {
        writeProgress: (message) => progress.push(message),
      })
    ).resolves.toBe(0)

    expect(progress.at(-1)).toBe(
      "self-test passed (OpenCode 1.18.19; Task resume disabled)"
    )
    expect(await pathExists(fixture.sshLog)).toBe(false)
  })

  it("blocks before SSH when the loader probe fails", async () => {
    const fixture = await createFixture("/srv/unused")
    fixture.env.OPENCODE_SSH_OPENCODE_BIN = fakeOpenCodeDebug
    fixture.env.FAKE_OPENCODE_REAL_BIN = fakeOpenCode
    fixture.env.PATH = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(
      path.delimiter
    )

    await expect(runCli(["incompatible-host", "/srv/requested"], fixture.env)).rejects.toThrow(
      /plugin loader exited/u
    )
    expect(await pathExists(fixture.sshLog)).toBe(false)
  })

  it("fails before starting SSH when OpenCode is unavailable", async () => {
    const fixture = await createFixture("/srv/missing-opencode")
    fixture.env.OPENCODE_SSH_OPENCODE_BIN = path.join(
      path.dirname(fixture.openCodeLog),
      "missing-opencode"
    )

    await expect(runCli(["missing-opencode-host", "/srv/requested"], fixture.env)).rejects.toThrow(
      /OpenCode is required.*npm install --global opencode-ai@1\.18\.18/u
    )
    expect(await pathExists(fixture.sshLog)).toBe(false)
  })
})

interface LauncherFixture {
  env: NodeJS.ProcessEnv
  openCodeLog: string
  sshLog: string
  stateHome: string
}

async function createFixture(
  canonicalWorkdir: string,
  extraEnvironment: NodeJS.ProcessEnv = {}
): Promise<LauncherFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocssh-launch-"))
  temporaryRoots.push(root)
  const stateHome = path.join(root, "state")
  const env: NodeJS.ProcessEnv = scrubFixtureEnvironment(process.env)
  const controlledNames = [
    ...Object.values(REMOTE_ENV),
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS",
  ]
  for (const name of controlledNames) delete env[name]

  const openCodeLog = path.join(root, "opencode.jsonl")
  const sshLog = path.join(root, "ssh.jsonl")
  Object.assign(env, {
    HOME: path.join(root, "home"),
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "run"),
    OPENCODE_PURE: "0",
    OPENCODE_SSH_OPENCODE_BIN: fakeOpenCode,
    [REMOTE_ENV.sshBinary]: fakeSsh,
    [REMOTE_ENV.sftpBinary]: fakeSftp,
    FAKE_OPENCODE_LOG: openCodeLog,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_STDOUT: `${canonicalWorkdir}\n`,
    FAKE_SSH_EXIT_CODE: "0",
    ...extraEnvironment,
  })

  return { env, openCodeLog, sshLog, stateHome }
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

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
