import { constants, accessSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../src/cli.js"
import { REMOTE_ENV } from "../../src/config.js"
import { spawnProcess } from "../../src/process.js"

const packageRootURL = new URL("../../", import.meta.url)
const packageRoot = fileURLToPath(packageRootURL)
const fakeOpenCode = fileURLToPath(
  new URL("../fixtures/bin/opencode-debug", import.meta.url)
)
const fakeVersionOpenCode = fileURLToPath(new URL("../fixtures/bin/opencode", import.meta.url))
const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const openCode = detectOpenCode()
const skipReason = openCode.kind === "absent" ? openCode.reason : undefined
const temporaryRoots: string[] = []

interface DebugInvocation {
  argv: string[]
  childArgv: string[]
  cwd: string
  configContent?: string
  env: Record<string, string>
  wrapperEnvironmentNames: string[]
  childEnvironmentNames: string[]
  readyExistsAfterChild: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
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
      const fixture = await createFixture(openCode.binary, canonicalWorkdir)
      const inheritedSecretName = "OPENCODE_LOADER_TEST_INHERITED_SECRET"
      const inheritedSecret = "must-not-reach-the-opencode-wrapper"
      const previousSecret = process.env[inheritedSecretName]
      let exitCode: number

      process.env[inheritedSecretName] = inheritedSecret
      try {
        exitCode = await runCli([alias, requestedWorkdir], fixture.env)
      } finally {
        if (previousSecret === undefined) delete process.env[inheritedSecretName]
        else process.env[inheritedSecretName] = previousSecret
      }

      expect(exitCode).toBe(0)

      const rawOpenCodeLog = await readFile(fixture.openCodeLog, "utf8")
      const invocations = parseJsonLines<DebugInvocation>(rawOpenCodeLog)
      expect(invocations).toHaveLength(1)
      expect(rawOpenCodeLog).not.toContain(inheritedSecret)

      const [invocation] = invocations
      expect(invocation.argv).toEqual([])
      expect(invocation.childArgv).toEqual(["debug", "config"])
      expect(invocation.exitCode).toBe(0)
      expect(invocation.signal).toBeNull()
      expect(invocation.readyExistsAfterChild).toBe(true)
      expect(invocation.wrapperEnvironmentNames).not.toContain(inheritedSecretName)
      expect(invocation.childEnvironmentNames).not.toContain(inheritedSecretName)
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
        plugin?: Array<[string, { launchID: string }]>
      }
      expect(config.plugin).toHaveLength(1)
      const pluginTuple = config.plugin?.[0]
      expect(pluginTuple).toEqual([
        packageRootURL.href,
        { launchID: invocation.env[REMOTE_ENV.launchID] },
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
      expect(remoteCalls.length).toBeGreaterThanOrEqual(4)
      for (const call of remoteCalls) {
        expect(valueAfter(call, "-S")).toBe(socketPath)
        expect(valueAfter(call, "--")).toBe(alias)
      }

      const sshInputs = parseJsonLines<string>(await readFile(fixture.sshInputLog, "utf8"))
      for (const probe of ["pwd -P", "uname -s", "git -C", "AGENTS.md"]) {
        expect(sshInputs.some((input) => input.includes(probe)), probe).toBe(true)
      }
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
        ...process.env,
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
  env: NodeJS.ProcessEnv
  openCodeLog: string
  root: string
  sshInputLog: string
  sshLog: string
}

async function createFixture(
  realOpenCode: string,
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
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 })
    )
  )

  const openCodeLog = path.join(root, "opencode.jsonl")
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
    OPENCODE_CONFIG_DIR: directories.config,
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
    FAKE_OPENCODE_LOG: openCodeLog,
    FAKE_OPENCODE_DELAY_MS: "250",
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_INPUT_LOG: sshInputLog,
    FAKE_SSH_STDOUT: `${canonicalWorkdir}\n`,
    FAKE_SSH_EXIT_CODE: "0",
    FAKE_SFTP_LOG: path.join(root, "sftp.jsonl"),
    FAKE_SFTP_EXIT_CODE: "0",
  }

  return { env, openCodeLog, root, sshInputLog, sshLog }
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
