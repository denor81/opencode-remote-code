import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RemoteConfig } from "../../src/config.js"
import { createSSHPool } from "../../src/ssh-pool.js"

const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const temporaryDirectories: string[] = []
const controlledEnvironment = [
  "FAKE_SSH_COMMAND_DELAY_MS",
  "FAKE_SSH_LOG",
  "FAKE_SFTP_DELAY_MS",
  "FAKE_SFTP_LOG",
]
let savedEnvironment = new Map<string, string | undefined>()

beforeEach(() => {
  savedEnvironment = new Map(
    controlledEnvironment.map((name) => [name, process.env[name]])
  )
  for (const name of controlledEnvironment) delete process.env[name]
})

afterEach(async () => {
  for (const name of controlledEnvironment) {
    const value = savedEnvironment.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("SSHPool lifecycle", () => {
  it("aborts and awaits every active SSH/SFTP operation without closing the master", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ssh-pool-test-"))
    temporaryDirectories.push(directory)
    const sshLog = join(directory, "ssh.jsonl")
    const sftpLog = join(directory, "sftp.jsonl")
    Object.assign(process.env, {
      FAKE_SSH_COMMAND_DELAY_MS: "500",
      FAKE_SSH_LOG: sshLog,
      FAKE_SFTP_DELAY_MS: "500",
      FAKE_SFTP_LOG: sftpLog,
    })
    const config: RemoteConfig = {
      active: true,
      alias: "pool-host",
      remoteWorkdir: "/srv/pool",
      controlSocket: join(directory, "master.sock"),
      targetID: "a".repeat(64),
      launchID: "pool-launch",
      readyPath: join(directory, "ready.json"),
      readyNonce: "n".repeat(32),
      runtimeDir: directory,
      mirrorRoot: join(directory, "mirror"),
      sshBinary: fakeSsh,
      sftpBinary: fakeSftp,
    }
    const pool = await createSSHPool(config)
    const caller = new AbortController()
    const operations = [
      pool.exec("long command", { signal: caller.signal }),
      pool.download("/remote/input", join(directory, "download")),
      pool.upload(join(directory, "upload"), "/remote/output"),
    ]
    await Promise.all([waitForCalls(sshLog, 1), waitForCalls(sftpLog, 2)])

    const closing = pool.close()
    await expect(pool.exec("must not spawn")).rejects.toThrow(/closed/i)
    await expect(
      pool.download("/remote/late", join(directory, "late"))
    ).rejects.toThrow(/closed/i)
    await expect(
      pool.upload(join(directory, "late-upload"), "/remote/late")
    ).rejects.toThrow(/closed/i)
    const settled = await Promise.allSettled(operations)

    await expect(closing).resolves.toBeUndefined()
    await expect(pool.close()).resolves.toBeUndefined()
    expect(caller.signal.aborted).toBe(false)
    expect(settled).toHaveLength(3)
    expect(
      settled.every(
        (result) => result.status === "rejected" && result.reason?.name === "AbortError"
      )
    ).toBe(true)

    const sshCalls = await readCalls(sshLog)
    expect(sshCalls).toEqual([
      [
        "-T",
        "-S",
        config.controlSocket,
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
        config.alias,
        "sh",
        "-s",
      ],
    ])
    expect(sshCalls.some((call) => call.includes("-O"))).toBe(false)
    expect(await readCalls(sftpLog)).toEqual([
      expectedSftpArgs(config),
      expectedSftpArgs(config),
    ])
  })
})

function expectedSftpArgs(config: RemoteConfig): string[] {
  return [
    "-b",
    "-",
    "-o",
    `ControlPath=${config.controlSocket}`,
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
    config.alias,
  ]
}

async function waitForCalls(filePath: string, count: number): Promise<void> {
  await expect.poll(
    async () => {
      const contents = await readFile(filePath, "utf8").catch(() => "")
      return contents.trim().split("\n").filter(Boolean).length
    },
    { interval: 10, timeout: 2_000 }
  ).toBe(count)
}

async function readCalls(filePath: string): Promise<string[][]> {
  const contents = await readFile(filePath, "utf8")
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}
