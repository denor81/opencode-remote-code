import { readFile, readdir, stat, writeFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  READY_PROTOCOL,
  ReadyHandshakeTimeoutError,
  ReadyHandshakeValidationError,
  createReadyRecord,
  hashNonce,
  removeReadyFile,
  waitForReadyHandshake,
  writeReadyHandshake,
  type ReadyHandshakeIdentity,
  type ReadyRecord,
} from "../../src/ready-handshake.js"

let root: string
let readyPath: string

const identity: ReadyHandshakeIdentity = {
  launchID: "launch-1",
  nonce: "a-private-random-nonce",
  alias: "staging",
  canonicalWorkdir: "/srv/app",
  targetID: "a".repeat(64),
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "opencode-ready-handshake-"))
  readyPath = path.join(root, "ready.json")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("writeReadyHandshake", () => {
  it("atomically writes a mode-0600 record containing only the nonce hash", async () => {
    const returned = await writeReadyHandshake(readyPath, identity)
    const parsed = JSON.parse(await readFile(readyPath, "utf8")) as Record<string, unknown>

    expect(returned).toEqual(createReadyRecord(identity))
    expect(parsed).toEqual({
      protocol: READY_PROTOCOL,
      launchID: identity.launchID,
      nonceHash: hashNonce(identity.nonce),
      alias: identity.alias,
      canonicalWorkdir: identity.canonicalWorkdir,
      targetID: identity.targetID,
    })
    expect(parsed).not.toHaveProperty("nonce")
    expect((await stat(readyPath)).mode & 0o777).toBe(0o600)
    expect(await readdir(root)).toEqual(["ready.json"])
  })
})

describe("waitForReadyHandshake", () => {
  it("polls until a matching atomic record appears", async () => {
    const waiting = waitForReadyHandshake(readyPath, identity, {
      timeoutMs: 500,
      pollIntervalMs: 5,
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    await writeReadyHandshake(readyPath, identity)

    await expect(waiting).resolves.toEqual(createReadyRecord(identity))
  })

  it("strictly rejects every identity field and extra record fields", async () => {
    const base = createReadyRecord(identity)
    const invalidRecords: unknown[] = [
      { ...base, protocol: "other-protocol" },
      { ...base, launchID: "other-launch" },
      { ...base, nonceHash: "b".repeat(64) },
      { ...base, alias: "other-host" },
      { ...base, canonicalWorkdir: "/srv/other" },
      { ...base, targetID: "b".repeat(64) },
      { ...base, extra: true },
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== "targetID")),
    ]

    for (const record of invalidRecords) {
      await writeFile(readyPath, JSON.stringify(record), "utf8")
      await expect(
        waitForReadyHandshake(readyPath, identity, { timeoutMs: 100, pollIntervalMs: 5 })
      ).rejects.toBeInstanceOf(ReadyHandshakeValidationError)
    }
  })

  it("rejects malformed JSON immediately", async () => {
    await writeFile(readyPath, "{]", "utf8")
    await expect(
      waitForReadyHandshake(readyPath, identity, { timeoutMs: 100, pollIntervalMs: 5 })
    ).rejects.toThrow(/malformed JSON/)
  })

  it("times out while the ready file is absent", async () => {
    await expect(
      waitForReadyHandshake(readyPath, identity, { timeoutMs: 20, pollIntervalMs: 5 })
    ).rejects.toBeInstanceOf(ReadyHandshakeTimeoutError)
  })

  it("honors an AbortSignal during polling", async () => {
    const controller = new AbortController()
    const waiting = waitForReadyHandshake(readyPath, identity, {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      signal: controller.signal,
    })
    controller.abort(new Error("test cancellation"))
    await expect(waiting).rejects.toThrow("test cancellation")
  })

  it("rejects a matching-looking record with a plaintext nonce field", async () => {
    const record: ReadyRecord & { nonce: string } = {
      ...createReadyRecord(identity),
      nonce: identity.nonce,
    }
    await writeFile(readyPath, JSON.stringify(record), "utf8")
    await expect(waitForReadyHandshake(readyPath, identity)).rejects.toThrow(/record shape/)
  })
})

describe("removeReadyFile", () => {
  it("removes the record and is idempotent when it is absent", async () => {
    await writeReadyHandshake(readyPath, identity)
    await removeReadyFile(readyPath)
    await removeReadyFile(readyPath)
    await expect(stat(readyPath)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
