import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { ControlMaster } from "../../src/ssh/control-master.js"

const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const temporaryDirectories: string[] = []
const activeMasters: ControlMaster[] = []

afterEach(async () => {
  await Promise.all(activeMasters.splice(0).map((master) => master.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("ControlMaster", () => {
  it("passes an alias as one unchanged argv and disables password fallbacks", async () => {
    const fixture = await createFixture()
    const alias = "host alias $(not-executed)\n--still-one-value"
    const controller = new AbortController()
    const master = await ControlMaster.start(alias, fixture.socketPath, controller.signal, fixture.options)
    activeMasters.push(master)

    const callsBeforeClose = await readCalls(fixture.logPath)
    const start = callsBeforeClose.find((args) => args.includes("-MN"))
    const check = callsBeforeClose.find((args) => args.includes("check"))
    expect(start).toEqual([
      "-MN",
      "-o",
      "ControlMaster=yes",
      "-o",
      "ControlPersist=no",
      "-o",
      `ControlPath=${fixture.socketPath}`,
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "--",
      alias,
    ])
    expect(start).not.toContain("BatchMode=yes")
    expect(check).toEqual(["-S", fixture.socketPath, "-O", "check", "--", alias])

    await master.close()
  })

  it("polls readiness and closes exactly once with an exit operation", async () => {
    const fixture = await createFixture({ FAKE_SSH_READY_DELAY_MS: "80" })
    const controller = new AbortController()
    const master = await ControlMaster.start("staging", fixture.socketPath, controller.signal, fixture.options)
    activeMasters.push(master)

    const callsAtReady = await readCalls(fixture.logPath)
    expect(callsAtReady.filter((args) => args.includes("check")).length).toBeGreaterThan(1)

    await Promise.all([master.close(), master.close()])
    await master.close()

    const calls = await readCalls(fixture.logPath)
    expect(calls.filter((args) => args.includes("exit"))).toEqual([
      ["-S", fixture.socketPath, "-O", "exit", "--", "staging"],
    ])
    expect(master.isClosed).toBe(true)
  })

  it("times out and terminates a master that never becomes ready", async () => {
    const fixture = await createFixture({ FAKE_SSH_NEVER_READY: "1" })
    const controller = new AbortController()

    await expect(
      ControlMaster.start("unready", fixture.socketPath, controller.signal, {
        ...fixture.options,
        startupTimeoutMs: 120,
      })
    ).rejects.toThrow(/Timed out/)
  })

  it("aborts startup without waiting for the readiness timeout", async () => {
    const fixture = await createFixture({ FAKE_SSH_NEVER_READY: "1" })
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("test abort")), 50)

    const error = await ControlMaster.start("aborted", fixture.socketPath, controller.signal, {
      ...fixture.options,
      startupTimeoutMs: 5_000,
    }).catch((value: unknown) => value)

    expect(error).toMatchObject({ name: "AbortError" })
  })
})

interface Fixture {
  logPath: string
  socketPath: string
  options: {
    sshBinary: string
    env: NodeJS.ProcessEnv
    startupTimeoutMs: number
    pollIntervalMs: number
    checkTimeoutMs: number
    closeTimeoutMs: number
    killGraceMs: number
  }
}

async function createFixture(extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "control-master-test-"))
  temporaryDirectories.push(directory)
  const logPath = join(directory, "ssh-argv.jsonl")
  const socketPath = join(directory, "master.sock")

  return {
    logPath,
    socketPath,
    options: {
      sshBinary: fakeSsh,
      env: { ...process.env, ...extraEnv, FAKE_SSH_LOG: logPath },
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      checkTimeoutMs: 250,
      closeTimeoutMs: 250,
      killGraceMs: 50,
    },
  }
}

async function readCalls(logPath: string): Promise<string[][]> {
  const contents = await readFile(logPath, "utf8")
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}
