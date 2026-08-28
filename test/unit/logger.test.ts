import { spawnSync } from "node:child_process"
import { constants } from "node:fs"
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  LOGGER_CHILD_ENV,
  createFileLogger,
  resolveDailyLogFilePath,
  resolveDefaultLogDirectory,
} from "../../src/logger.js"

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-logger-"))
  temporaryRoots.push(root)
  return root
}

function dailyLogPath(directory: string, day: string): string {
  return path.join(directory, `opencode-ssh-${day}.jsonl`)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("file logger", () => {
  it("purely resolves default, explicit, and daily paths without trusting child overrides", async () => {
    const root = await temporaryRoot()
    const stateHome = path.join(root, "state%home")
    const ambientChildDirectory = path.join(root, "ambient-child-logs")
    const explicitDirectory = path.join(root, "explicit%child-logs")
    const env = {
      HOME: path.join(root, "home"),
      XDG_STATE_HOME: stateHome,
      [LOGGER_CHILD_ENV.directory]: ambientChildDirectory,
      [LOGGER_CHILD_ENV.startupID]: "startup-123",
    }
    const expectedDefault = path.join(stateHome, "opencode-ssh", "logs")
    const now = new Date("2026-08-28T23:59:59.123Z")

    expect(LOGGER_CHILD_ENV).toEqual({
      directory: "OPENCODE_SSH_LOG_DIRECTORY",
      startupID: "OPENCODE_SSH_LOG_STARTUP_ID",
    })
    expect(resolveDefaultLogDirectory({ env })).toBe(expectedDefault)
    expect(resolveDailyLogFilePath({ env, now })).toBe(
      path.join(expectedDefault, "opencode-ssh-2026-08-28.jsonl")
    )
    expect(resolveDailyLogFilePath({ env, logDirectory: explicitDirectory, now })).toBe(
      path.join(explicitDirectory, "opencode-ssh-2026-08-28.jsonl")
    )
    await expect(stat(expectedDefault)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(ambientChildDirectory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("writes JSON Lines to the XDG state directory using the UTC day", async () => {
    const root = await temporaryRoot()
    const stateHome = path.join(root, "state")
    const logDirectory = path.join(stateHome, "opencode-ssh", "logs")
    const now = new Date("2026-08-28T23:59:59.123Z")
    const logger = createFileLogger({
      env: { HOME: path.join(root, "home"), XDG_STATE_HOME: stateHome },
      now: () => now,
    })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const error = Object.assign(new Error("connection failed"), {
      config: { token: "config-secret" },
      environment: { TOKEN: "environment-secret" },
    })

    await expect(
      logger.log({
        level: "info",
        event: "launcher.started",
        fields: {
          count: 2,
          large: 9n,
          unavailable: Number.POSITIVE_INFINITY,
          omitted: undefined,
          circular,
        },
      })
    ).resolves.toBe(true)
    await expect(
      logger.log({ level: "error", event: "launcher.failed", error })
    ).resolves.toBe(true)

    expect(await readdir(logDirectory)).toEqual(["opencode-ssh-2026-08-28.jsonl"])
    const contents = await readFile(
      path.join(logDirectory, "opencode-ssh-2026-08-28.jsonl"),
      "utf8"
    )
    const lines = contents.trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records[0]).toMatchObject({
      timestamp: "2026-08-28T23:59:59.123Z",
      level: "info",
      event: "launcher.started",
      pid: process.pid,
      fields: {
        count: 2,
        large: "9",
        unavailable: null,
        circular: { self: "[Circular]" },
      },
    })
    expect((records[0].fields as Record<string, unknown>)).not.toHaveProperty("omitted")
    expect(records[1]).toMatchObject({
      level: "error",
      event: "launcher.failed",
      error: { name: "Error", message: "connection failed" },
    })
    expect(records[1].error as Record<string, unknown>).toHaveProperty("stack")
    expect(contents).not.toContain("config-secret")
    expect(contents).not.toContain("environment-secret")
  })

  it("creates its directory and daily file with private modes", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "private%state", "logs")
    const logger = createFileLogger({
      logDirectory,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    })

    await expect(logger.log({ level: "debug", event: "mode.checked" })).resolves.toBe(true)

    if (process.platform !== "win32") {
      expect((await stat(logDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(path.join(logDirectory, "opencode-ssh-2026-08-28.jsonl"))).mode & 0o777).toBe(
        0o600
      )
    }
  })

  it("removes sparse daily files older than the five-day UTC window", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "logs")
    await mkdir(logDirectory)
    await writeFile(dailyLogPath(logDirectory, "2026-08-05"), "old\n", "utf8")
    await writeFile(dailyLogPath(logDirectory, "2026-08-06"), "retained\n", "utf8")
    const logger = createFileLogger({
      logDirectory,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })

    await expect(logger.log({ level: "info", event: "day.logged" })).resolves.toBe(true)

    await expect(stat(dailyLogPath(logDirectory, "2026-08-05"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect((await readdir(logDirectory)).sort()).toEqual([
      "opencode-ssh-2026-08-06.jsonl",
      "opencode-ssh-2026-08-10.jsonl",
    ])
  })

  it("keeps at most the current UTC day and previous four under future clock skew", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "logs")
    await mkdir(logDirectory)
    for (const day of [
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
      "2026-08-11",
      "2026-08-12",
    ]) {
      await writeFile(dailyLogPath(logDirectory, day), `${day}\n`, "utf8")
    }
    await writeFile(path.join(logDirectory, "notes.txt"), "keep\n", "utf8")
    await writeFile(path.join(logDirectory, "opencode-ssh-2026-99-99.jsonl"), "keep\n", "utf8")
    await writeFile(path.join(logDirectory, "opencode-ssh-2026-08-05.jsonl.backup"), "keep\n", "utf8")
    await mkdir(path.join(logDirectory, "opencode-ssh-2020-01-01.jsonl"))
    const logger = createFileLogger({
      logDirectory,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })

    await expect(logger.log({ level: "info", event: "day.logged" })).resolves.toBe(true)

    expect((await readdir(logDirectory)).sort()).toEqual(
      [
        "notes.txt",
        "opencode-ssh-2020-01-01.jsonl",
        "opencode-ssh-2026-08-05.jsonl.backup",
        "opencode-ssh-2026-08-06.jsonl",
        "opencode-ssh-2026-08-07.jsonl",
        "opencode-ssh-2026-08-08.jsonl",
        "opencode-ssh-2026-08-09.jsonl",
        "opencode-ssh-2026-08-10.jsonl",
        "opencode-ssh-2026-99-99.jsonl",
      ].sort()
    )
    expect(await readFile(path.join(logDirectory, "notes.txt"), "utf8")).toBe("keep\n")
  })

  it("uses a fresh pruning day when an append crosses UTC midnight", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "logs")
    await mkdir(logDirectory)
    await writeFile(dailyLogPath(logDirectory, "2026-08-06"), "expires after midnight\n", "utf8")
    await writeFile(dailyLogPath(logDirectory, "2026-08-11"), "next process day\n", "utf8")
    const beforeMidnight = new Date("2026-08-10T23:59:59.999Z")
    const afterMidnight = new Date("2026-08-11T00:00:00.001Z")
    let clockCalls = 0
    const logger = createFileLogger({
      logDirectory,
      now: () => (clockCalls++ === 0 ? beforeMidnight : afterMidnight),
    })

    await expect(logger.log({ level: "info", event: "rollover.write" })).resolves.toBe(true)

    expect((await readdir(logDirectory)).sort()).toEqual([
      "opencode-ssh-2026-08-10.jsonl",
      "opencode-ssh-2026-08-11.jsonl",
    ])
    expect(await readFile(dailyLogPath(logDirectory, "2026-08-11"), "utf8")).toBe(
      "next process day\n"
    )
  })

  it("prunes once per successful UTC day for each logger instance", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "logs")
    let now = new Date("2026-08-10T12:00:00.000Z")
    const logger = createFileLogger({ logDirectory, now: () => now })

    await expect(logger.log({ level: "info", event: "first.write" })).resolves.toBe(true)
    const stalePath = dailyLogPath(logDirectory, "2026-08-01")
    await writeFile(stalePath, "stale\n", "utf8")
    await expect(logger.log({ level: "info", event: "second.write" })).resolves.toBe(true)
    expect(await readFile(stalePath, "utf8")).toBe("stale\n")

    now = new Date("2026-08-11T00:00:00.000Z")
    await expect(logger.log({ level: "info", event: "next-day.write" })).resolves.toBe(true)
    await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("appends concurrent logger instances without truncating records", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "logs")
    const options = {
      logDirectory,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    }
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, sequence) =>
        createFileLogger(options).log({
          level: "info",
          event: "concurrent.write",
          fields: { sequence },
        })
      )
    )

    expect(results).toEqual(Array.from({ length: 24 }, () => true))
    const contents = await readFile(
      path.join(logDirectory, "opencode-ssh-2026-08-28.jsonl"),
      "utf8"
    )
    const records = contents
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { fields: { sequence: number } })
    expect(records).toHaveLength(24)
    expect(records.map((record) => record.fields.sequence).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 24 }, (_, sequence) => sequence)
    )
  })

  it("resolves false instead of throwing when logging I/O fails", async () => {
    const root = await temporaryRoot()
    const blockingFile = path.join(root, "not-a-directory")
    await writeFile(blockingFile, "unchanged\n", "utf8")
    const logger = createFileLogger({
      logDirectory: path.join(blockingFile, "logs"),
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    })

    await expect(logger.log({ level: "error", event: "write.failed" })).resolves.toBe(false)
    expect(await readFile(blockingFile, "utf8")).toBe("unchanged\n")
  })

  it("times out non-fatally, handles late failure, and suppresses later writes", async () => {
    let rejectOperation: ((reason: unknown) => void) | undefined
    const operation = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectOperation = reject
        })
    )
    const logger = createFileLogger({ localIOTimeoutMs: 25 }, { operation })

    vi.useFakeTimers()
    try {
      const first = logger.log({ level: "info", event: "timeout.first" })
      await vi.advanceTimersByTimeAsync(25)
      await expect(first).resolves.toBe(false)
      await expect(logger.log({ level: "info", event: "timeout.suppressed" })).resolves.toBe(false)
      expect(operation).toHaveBeenCalledTimes(1)

      rejectOperation?.(new Error("late operation failure"))
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      rejectOperation?.(new Error("test cleanup"))
      vi.useRealTimers()
    }
  })

  it.skipIf(process.platform !== "linux")(
    "rejects a FIFO path without waiting for the local I/O deadline",
    async () => {
      const root = await temporaryRoot()
      const logDirectory = path.join(root, "logs")
      await mkdir(logDirectory)
      const fifoPath = dailyLogPath(logDirectory, "2026-08-28")
      const creation = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" })
      expect(creation.error).toBeUndefined()
      expect(creation.status, creation.stderr).toBe(0)
      const logger = createFileLogger({
        logDirectory,
        localIOTimeoutMs: 500,
        now: () => new Date("2026-08-28T12:00:00.000Z"),
      })

      const started = performance.now()
      const result = await logger.log({ level: "error", event: "fifo.rejected" })
      const elapsedMs = performance.now() - started

      const reader = await open(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK)
      await new Promise<void>((resolve) => setImmediate(resolve))
      await reader.close()
      expect(result).toBe(false)
      expect(elapsedMs).toBeLessThan(250)
    }
  )

  it("rejects invalid event names and oversized records without creating a log", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "logs")
    const logger = createFileLogger({
      logDirectory,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    })

    await expect(logger.log({ level: "info", event: "contains spaces" })).resolves.toBe(false)
    await expect(logger.log({ level: "info", event: "x".repeat(129) })).resolves.toBe(false)
    await expect(
      logger.log({
        level: "info",
        event: "record.too-large",
        fields: { payload: "x".repeat(70 * 1024) },
      })
    ).resolves.toBe(false)
    await expect(stat(logDirectory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("bounds serialized Error strings below the overall record limit", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "logs")
    const error = new Error("m".repeat(20 * 1024))
    error.name = "N".repeat(1_024)
    error.stack = "s".repeat(40 * 1024)
    const logger = createFileLogger({
      logDirectory,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    })

    await expect(
      logger.log({ level: "error", event: "bounded.error", error })
    ).resolves.toBe(true)
    const record = JSON.parse(await readFile(dailyLogPath(logDirectory, "2026-08-28"), "utf8")) as {
      error: { name: string; message: string; stack: string }
    }
    expect(Buffer.byteLength(record.error.name, "utf8")).toBe(128)
    expect(Buffer.byteLength(record.error.message, "utf8")).toBe(4 * 1024)
    expect(Buffer.byteLength(record.error.stack, "utf8")).toBe(16 * 1024)
  })
})
