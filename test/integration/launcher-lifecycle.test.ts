import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../src/cli.js"
import { REMOTE_ENV } from "../../src/config.js"
import { computeTargetID } from "../../src/runtime-paths.js"

const fakeOpenCode = fileURLToPath(new URL("../fixtures/bin/opencode", import.meta.url))
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
      const injected = merged.plugin.at(-1) as unknown as [string, { launchID: string }]
      expect(injected[0]).toMatch(/^file:.*\/$/)
      expect(injected[0]).not.toContain("/src/")
      expect(injected[1]).toEqual({ launchID: invocation.env[REMOTE_ENV.launchID] })

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

  it("accepts a valid ready handshake written immediately before OpenCode exits", async () => {
    const fixture = await createFixture("/srv/immediate-ready", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_EXIT_CODE: "23",
    })

    await expect(
      runCli(["immediate-ready-host", "/srv/requested"], fixture.env)
    ).resolves.toBe(23)
  })

  it("warns before starting SSH and continues after the compatibility delay", async () => {
    const alias = "future-version-host"
    const fixture = await createFixture("/srv/future-version", {
      FAKE_OPENCODE_VERSION_STDOUT: "9.8.7\n",
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "30",
      FAKE_OPENCODE_EXIT_CODE: "17",
    })
    const warnings: string[] = []
    const waits: number[] = []
    let sshStartedDuringWait = true

    await expect(
      runCli([alias, "/srv/requested"], fixture.env, {
        writeWarning: (message) => warnings.push(message),
        wait: async (milliseconds) => {
          waits.push(milliseconds)
          sshStartedDuringWait = await pathExists(fixture.sshLog)
        },
      })
    ).resolves.toBe(17)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("OpenCode 9.8.7 differs from the tested version")
    expect(waits).toEqual([3_000])
    expect(sshStartedDuringWait).toBe(false)
    expect(parseJsonLines<OpenCodeInvocation>(await readFile(fixture.openCodeLog, "utf8"))).toHaveLength(1)
  })

  it("fails before starting SSH when OpenCode is unavailable", async () => {
    const fixture = await createFixture("/srv/missing-opencode")
    fixture.env.OPENCODE_SSH_OPENCODE_BIN = path.join(
      path.dirname(fixture.openCodeLog),
      "missing-opencode"
    )

    await expect(runCli(["missing-opencode-host", "/srv/requested"], fixture.env)).rejects.toThrow(
      /Failed to spawn process/u
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
  const env: NodeJS.ProcessEnv = { ...process.env }
  const controlledNames = [
    ...Object.values(REMOTE_ENV),
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_PURE",
    "OPENCODE_SSH_OPENCODE_BIN",
    "FAKE_OPENCODE_LOG",
    "FAKE_OPENCODE_WRITE_READY",
    "FAKE_OPENCODE_DELAY_MS",
    "FAKE_OPENCODE_EXIT_CODE",
    "FAKE_OPENCODE_VERSION_STDOUT",
    "FAKE_OPENCODE_VERSION_STDERR",
    "FAKE_OPENCODE_VERSION_DELAY_MS",
    "FAKE_OPENCODE_VERSION_EXIT_CODE",
    "FAKE_SSH_LOG",
    "FAKE_SSH_STDOUT",
    "FAKE_SSH_EXIT_CODE",
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
