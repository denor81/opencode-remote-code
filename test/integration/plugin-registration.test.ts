import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tool, type Hooks } from "@opencode-ai/plugin"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import RemoteCodePlugin from "../../src/index.js"
import { REMOTE_ENV } from "../../src/config.js"
import {
  READY_PROTOCOL,
  createReadyRecord,
  validateReadyRecord,
  type ReadyHandshakeIdentity,
} from "../../src/ready-handshake.js"
import { computeTargetID } from "../../src/runtime-paths.js"

const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const temporaryRoots: string[] = []
const isolatedEnvironmentNames = [
  ...Object.values(REMOTE_ENV),
  "FAKE_SSH_LOG",
  "FAKE_SSH_STDOUT",
  "FAKE_SSH_STDERR",
  "FAKE_SSH_EXIT_CODE",
  "FAKE_SFTP_LOG",
  "FAKE_SFTP_EXIT_CODE",
]
let savedEnvironment = new Map<string, string | undefined>()

beforeEach(() => {
  savedEnvironment = new Map(
    isolatedEnvironmentNames.map((name) => [name, process.env[name]])
  )
  for (const name of isolatedEnvironmentNames) delete process.env[name]
})

afterEach(async () => {
  for (const name of isolatedEnvironmentNames) {
    const value = savedEnvironment.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("server plugin registration", () => {
  it("registers the SSH tools with official Zod 4 schemas and publishes readiness", async () => {
    const fixture = await createPluginFixture()
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server({} as never, { launchID: fixture.launchID })
      const tools = hooks.tool
      expect(tools).toBeDefined()
      expect(Object.keys(tools ?? {}).sort()).toEqual(
        ["bash", "read", "write", "edit", "glob", "grep", "apply_patch", "remote_status"].sort()
      )

      for (const definition of Object.values(tools ?? {})) {
        expect(definition.description).toEqual(expect.any(String))
        expect(definition.execute).toEqual(expect.any(Function))
        const parameters = tool.schema.object(definition.args)
        expect(parameters).toBeInstanceOf(tool.schema.ZodObject)
        expect(parameters._zod.def.type).toBe("object")
        for (const schema of Object.values(definition.args)) {
          expect(schema).toBeInstanceOf(tool.schema.ZodType)
          expect(schema._zod.def.type).toEqual(expect.any(String))
          expect(schema.safeParse).toEqual(expect.any(Function))
        }
      }
      expect(tools?.bash.args.command._zod.def.type).toBe("string")
      expect(tools?.bash.args.workdir._zod.def.type).toBe("optional")
      expect(tools?.remote_status.args).toEqual({})

      const identity: ReadyHandshakeIdentity = {
        launchID: fixture.launchID,
        nonce: fixture.nonce,
        alias: fixture.alias,
        canonicalWorkdir: fixture.remoteWorkdir,
        targetID: fixture.targetID,
      }
      const readyValue = JSON.parse(await readFile(fixture.readyPath, "utf8")) as unknown
      expect(validateReadyRecord(readyValue, identity)).toEqual(createReadyRecord(identity))
      expect(readyValue).toMatchObject({ protocol: READY_PROTOCOL })
      expect(readyValue).not.toHaveProperty("nonce")
      expect((await stat(fixture.readyPath)).mode & 0o777).toBe(0o600)

      const originalSystem = ["normal OpenCode system prompt", "context from another plugin"]
      const output = { system: [...originalSystem] }
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "session-1", model: {} as never },
        output
      )
      expect(output.system.slice(0, originalSystem.length)).toEqual(originalSystem)
      expect(output.system).toHaveLength(originalSystem.length + 1)
      expect(output.system.at(-1)).toContain(`SSH alias: ${fixture.alias}`)
      expect(output.system.at(-1)).toContain(`Remote workspace: ${fixture.remoteWorkdir}`)

      const sshCalls = parseJsonLines<string[]>(await readFile(fixture.sshLog, "utf8"))
      expect(sshCalls).toHaveLength(3)
      for (const args of sshCalls) {
        expect(args).toEqual([
          "-T",
          "-S",
          fixture.socketPath,
          "-o",
          "ControlMaster=no",
          "-o",
          "BatchMode=yes",
          "-o",
          "PasswordAuthentication=no",
          "-o",
          "KbdInteractiveAuthentication=no",
          "-o",
          "ProxyCommand=false",
          "--",
          fixture.alias,
          "sh",
          "-s",
        ])
      }

      expect(hooks.dispose).toEqual(expect.any(Function))
      await hooks.dispose?.()
      await hooks.dispose?.()
    } finally {
      await hooks?.dispose?.()
    }
  })

  it("stays dormant without launcher context or for a mismatched plugin tuple", async () => {
    await expect(
      RemoteCodePlugin.server({} as never, { launchID: "inactive-launch" })
    ).resolves.toEqual({})

    const fixture = await createPluginFixture()
    await expect(
      RemoteCodePlugin.server({} as never, { launchID: "different-launch" })
    ).resolves.toEqual({})
    expect(await pathExists(fixture.readyPath)).toBe(false)
    expect(await pathExists(fixture.mirrorRoot)).toBe(false)
    expect(await pathExists(fixture.sshLog)).toBe(false)
  })
})

interface PluginFixture {
  alias: string
  launchID: string
  mirrorRoot: string
  nonce: string
  readyPath: string
  remoteWorkdir: string
  socketPath: string
  sshLog: string
  targetID: string
}

async function createPluginFixture(): Promise<PluginFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocssh-plugin-"))
  temporaryRoots.push(root)
  const alias = "fixture-host"
  const remoteWorkdir = "/srv/plugin workspace"
  const launchID = "plugin-registration-launch"
  const nonce = "fixture-ready-nonce-0123456789abcdef0123456789abcdef"
  const targetID = computeTargetID(alias, remoteWorkdir)
  const runtimeDir = path.join(root, "runtime")
  const stateDir = path.join(root, "state")
  const socketPath = path.join(runtimeDir, `${launchID}.sock`)
  const readyPath = path.join(stateDir, "ready.json")
  const mirrorRoot = path.join(root, "cache", "mirror")
  const sshLog = path.join(root, "ssh.jsonl")
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  await mkdir(stateDir, { recursive: true, mode: 0o700 })

  Object.assign(process.env, {
    [REMOTE_ENV.alias]: alias,
    [REMOTE_ENV.workdir]: remoteWorkdir,
    [REMOTE_ENV.socket]: socketPath,
    [REMOTE_ENV.targetID]: targetID,
    [REMOTE_ENV.launchID]: launchID,
    [REMOTE_ENV.readyPath]: readyPath,
    [REMOTE_ENV.readyNonce]: nonce,
    [REMOTE_ENV.runtimeDir]: runtimeDir,
    [REMOTE_ENV.mirrorRoot]: mirrorRoot,
    [REMOTE_ENV.sshBinary]: fakeSsh,
    [REMOTE_ENV.sftpBinary]: fakeSftp,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_STDOUT: "Linux\n",
    FAKE_SSH_EXIT_CODE: "0",
  })

  return {
    alias,
    launchID,
    mirrorRoot,
    nonce,
    readyPath,
    remoteWorkdir,
    socketPath,
    sshLog,
    targetID,
  }
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
