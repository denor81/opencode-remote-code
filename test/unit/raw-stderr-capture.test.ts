import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  RAW_STDERR_CAPTURE_MAX_BYTES,
  createRawStderrCapture,
} from "../../src/raw-stderr-capture.js"

const temporaryRoots: string[] = []

interface WritableHandle {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null
  ): Promise<{ bytesWritten: number }>
}

interface ClosableHandle {
  close(): Promise<void>
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-raw-stderr-"))
  temporaryRoots.push(root)
  return root
}

function startupID(sequence: number): string {
  return sequence.toString(16).padStart(32, "0")
}

function stateEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    HOME: path.join(root, "home"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
}

function rawDirectory(root: string): string {
  return path.join(root, "state", "opencode-ssh", "logs", "raw")
}

function rawFilePath(directory: string, day: string, id: string): string {
  return path.join(directory, `opencode-host-stderr-${day}-${id}.bin`)
}

function asWritableHandle(handle: unknown): WritableHandle {
  return handle as WritableHandle
}

function asClosableHandle(handle: unknown): ClosableHandle {
  return handle as ClosableHandle
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("raw stderr capture", () => {
  it("exports a one MiB bound and rejects invalid explicit bounds", () => {
    expect(RAW_STDERR_CAPTURE_MAX_BYTES).toBe(1024 * 1024)
    expect(() =>
      createRawStderrCapture({
        startupID: startupID(1),
        maxBytes: RAW_STDERR_CAPTURE_MAX_BYTES + 1,
      })
    ).toThrow(RangeError)
  })

  it("treats invalid startup IDs as unavailable and never creates a file for them", async () => {
    const root = await temporaryRoot()
    let openCalls = 0
    for (const invalid of [
      "",
      "unavailable",
      "0".repeat(31),
      "0".repeat(33),
      "ABCDEF0123456789ABCDEF0123456789",
      "g".repeat(32),
      "../00000000000000000000000000000",
    ]) {
      let capture: ReturnType<typeof createRawStderrCapture> | undefined
      expect(() => {
        capture = createRawStderrCapture({
          env: stateEnvironment(root),
          startupID: invalid,
          now: () => new Date("2026-08-10T12:00:00.000Z"),
          fileSystem: {
            async open() {
              openCalls++
              throw new Error("invalid startup ID reached file creation")
            },
          },
        })
      }).not.toThrow()
      capture!.accept(Buffer.from("stderr"))

      await expect(capture!.finalize()).resolves.toEqual({
        observedBytes: 6,
        capturedBytes: 6,
        writtenBytes: 0,
        truncated: false,
        storageStatus: "capture-failed",
        retentionStatus: "completed",
      })
    }

    expect(openCalls).toBe(0)
    expect(await readdir(rawDirectory(root))).toEqual([])
  })

  it("performs retention when empty without creating a raw capture file", async () => {
    const root = await temporaryRoot()
    const directory = rawDirectory(root)
    await mkdir(directory, { recursive: true })
    const stalePath = rawFilePath(directory, "2026-08-05", startupID(2))
    await writeFile(stalePath, "stale")
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(1),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })

    await expect(capture.finalize()).resolves.toEqual({
      observedBytes: 0,
      capturedBytes: 0,
      writtenBytes: 0,
      truncated: false,
      storageStatus: "empty",
      retentionStatus: "completed",
    })
    expect(await readdir(directory)).toEqual([])
  })

  it("preserves binary, invalid UTF-8, NUL, CR/LF, ANSI, and OSC bytes exactly", async () => {
    const root = await temporaryRoot()
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0x1b]),
      Buffer.from("]0;private title\u0007\u001b[31mred\u001b[0m\r\n", "utf8"),
      Buffer.from([0x80, 0xc0, 0xaf]),
    ])
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(3),
      now: () => new Date("2026-08-10T23:59:59.999Z"),
    })

    capture.accept(bytes)
    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: bytes.length,
      capturedBytes: bytes.length,
      writtenBytes: bytes.length,
      truncated: false,
      storageStatus: "complete",
      retentionStatus: "completed",
    })
    expect(summary.filePath).toBe(
      rawFilePath(rawDirectory(root), "2026-08-10", startupID(3))
    )
    expect(await readFile(summary.filePath!)).toEqual(bytes)
  })

  it("keeps split chunks in delivery order without decoding them", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(4),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })
    const chunks = [
      Buffer.from([0x00, 0x01]),
      Buffer.from("middle\r"),
      Buffer.from([0x0a, 0xff]),
    ]

    for (const chunk of chunks) capture.accept(chunk)
    const summary = await capture.finalize()

    expect(await readFile(summary.filePath!)).toEqual(Buffer.concat(chunks))
    expect(summary).toMatchObject({
      observedBytes: 11,
      capturedBytes: 11,
      writtenBytes: 11,
      truncated: false,
    })
  })

  it("captures exactly one MiB without reporting truncation", async () => {
    const root = await temporaryRoot()
    const bytes = Buffer.alloc(RAW_STDERR_CAPTURE_MAX_BYTES, 0xa5)
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(5),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })

    capture.accept(bytes)
    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: RAW_STDERR_CAPTURE_MAX_BYTES,
      capturedBytes: RAW_STDERR_CAPTURE_MAX_BYTES,
      writtenBytes: RAW_STDERR_CAPTURE_MAX_BYTES,
      truncated: false,
      storageStatus: "complete",
    })
    expect((await readFile(summary.filePath!)).equals(bytes)).toBe(true)
  })

  it("stores only the bounded prefix on a one-byte overflow", async () => {
    const root = await temporaryRoot()
    const bytes = Buffer.alloc(RAW_STDERR_CAPTURE_MAX_BYTES + 1, 0x5a)
    bytes[RAW_STDERR_CAPTURE_MAX_BYTES] = 0x7f
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(6),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })

    capture.accept(bytes)
    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: RAW_STDERR_CAPTURE_MAX_BYTES + 1,
      capturedBytes: RAW_STDERR_CAPTURE_MAX_BYTES,
      writtenBytes: RAW_STDERR_CAPTURE_MAX_BYTES,
      truncated: true,
      storageStatus: "complete",
    })
    expect(
      (await readFile(summary.filePath!)).equals(
        bytes.subarray(0, RAW_STDERR_CAPTURE_MAX_BYTES)
      )
    ).toBe(true)
  })

  it("copies only the prefix of a chunk that crosses a configured lower limit", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(7),
      maxBytes: 5,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })

    capture.accept(Buffer.from("ab"))
    capture.accept(Buffer.from("cdefgh"))
    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: 8,
      capturedBytes: 5,
      writtenBytes: 5,
      truncated: true,
    })
    expect(await readFile(summary.filePath!)).toEqual(Buffer.from("abcde"))
  })

  it("handles many one-byte chunks while retaining only the fixed prefix buffer", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(8),
      maxBytes: 64,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })

    for (let index = 0; index < 100_000; index++) {
      capture.accept(Buffer.from([index & 0xff]))
    }
    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: 100_000,
      capturedBytes: 64,
      writtenBytes: 64,
      truncated: true,
    })
    expect(await readFile(summary.filePath!)).toEqual(
      Buffer.from(Array.from({ length: 64 }, (_, index) => index))
    )
  })

  it("does not throw for invalid observer input or a failing chunk copy", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(9),
      maxBytes: 16,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })
    const broken = Buffer.from("bad")
    broken.copy = () => {
      throw new Error("copy failed")
    }

    expect(() => capture.accept(null as unknown as Buffer)).not.toThrow()
    expect(() => capture.accept(broken)).not.toThrow()
    expect(() => capture.accept(Buffer.from("later"))).not.toThrow()
    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: 8,
      capturedBytes: 0,
      writtenBytes: 0,
      truncated: true,
      storageStatus: "capture-failed",
      retentionStatus: "completed",
    })
    expect(summary).not.toHaveProperty("filePath")
    expect(await readdir(rawDirectory(root))).toEqual([])
  })

  it("continues counting after allocation failure without creating a file", async () => {
    const root = await temporaryRoot()
    let allocatedSize = 0
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(33),
      maxBytes: 16,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      allocate(size) {
        allocatedSize = size
        throw new Error("allocation failed")
      },
    })

    expect(() => capture.accept(Buffer.from("stderr"))).not.toThrow()
    await expect(capture.finalize()).resolves.toEqual({
      observedBytes: 6,
      capturedBytes: 0,
      writtenBytes: 0,
      truncated: true,
      storageStatus: "capture-failed",
      retentionStatus: "completed",
    })
    expect(allocatedSize).toBe(16)
    expect(await readdir(rawDirectory(root))).toEqual([])
  })

  it("ignores accepts after finalization starts and returns one idempotent promise", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(10),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })
    capture.accept(Buffer.from("before"))

    const first = capture.finalize()
    capture.accept(Buffer.from("after"))
    const second = capture.finalize()

    expect(second).toBe(first)
    const summary = await first
    expect(summary).toMatchObject({
      observedBytes: 6,
      capturedBytes: 6,
      writtenBytes: 6,
      truncated: false,
    })
    expect(capture.finalize()).toBe(first)
    expect(await readFile(summary.filePath!)).toEqual(Buffer.from("before"))
  })

  it("lets discard own settlement, ignores later accepts, and reuses its promise", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(34),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })
    capture.accept(Buffer.from("before"))

    const first = capture.discard()
    capture.accept(Buffer.from("after"))

    expect(capture.discard()).toBe(first)
    expect(capture.finalize()).toBe(first)
    await expect(first).resolves.toEqual({
      observedBytes: 6,
      capturedBytes: 6,
      writtenBytes: 0,
      truncated: false,
      storageStatus: "capture-failed",
      retentionStatus: "not-attempted",
    })
    expect(capture.discard()).toBe(first)
    expect(capture.finalize()).toBe(first)
    expect(await pathExists(rawDirectory(root))).toBe(false)
  })

  it("performs no clock or filesystem work when discarding an empty capture", async () => {
    const root = await temporaryRoot()
    let dependencyCalls = 0
    const fail = async (): Promise<never> => {
      dependencyCalls++
      throw new Error("discard invoked a filesystem dependency")
    }
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(35),
      now: () => {
        dependencyCalls++
        throw new Error("discard invoked the clock")
      },
      fileSystem: {
        mkdir: fail,
        lstat: fail,
        chmod: fail,
        open: fail,
        fstat: fail,
        fchmod: fail,
        write: fail,
        close: fail,
        readdir: fail,
        unlink: fail,
      },
    })

    await expect(capture.discard()).resolves.toEqual({
      observedBytes: 0,
      capturedBytes: 0,
      writtenBytes: 0,
      truncated: false,
      storageStatus: "empty",
      retentionStatus: "not-attempted",
    })
    expect(dependencyCalls).toBe(0)
    expect(await pathExists(rawDirectory(root))).toBe(false)
  })

  it("lets finalize own settlement before discard", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(36),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })
    capture.accept(Buffer.from("stored"))

    const first = capture.finalize()
    expect(capture.discard()).toBe(first)
    expect(capture.finalize()).toBe(first)
    const summary = await first

    expect(summary).toMatchObject({
      observedBytes: 6,
      capturedBytes: 6,
      writtenBytes: 6,
      storageStatus: "complete",
      retentionStatus: "completed",
    })
    expect(capture.discard()).toBe(first)
    expect(await readFile(summary.filePath!)).toEqual(Buffer.from("stored"))
  })

  it("keeps the validated startup ID when the caller later mutates its options", async () => {
    const root = await temporaryRoot()
    const id = startupID(32)
    const options = {
      env: stateEnvironment(root),
      startupID: id,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    }
    const capture = createRawStderrCapture(options)
    options.startupID = "../mutated"
    capture.accept(Buffer.from("stable"))

    const summary = await capture.finalize()

    expect(summary.filePath).toBe(rawFilePath(rawDirectory(root), "2026-08-10", id))
    expect(await readFile(summary.filePath!)).toEqual(Buffer.from("stable"))
  })

  it("resolves XDG_STATE_HOME and the HOME fallback through the structured logger path", async () => {
    const xdgRoot = await temporaryRoot()
    const homeRoot = await temporaryRoot()
    const date = new Date("2026-08-10T12:00:00.000Z")
    const xdgCapture = createRawStderrCapture({
      env: stateEnvironment(xdgRoot),
      startupID: startupID(11),
      now: () => date,
    })
    const home = path.join(homeRoot, "selected-home")
    const homeCapture = createRawStderrCapture({
      env: { HOME: home },
      startupID: startupID(12),
      now: () => date,
    })
    xdgCapture.accept(Buffer.from("xdg"))
    homeCapture.accept(Buffer.from("home"))

    const [xdgSummary, homeSummary] = await Promise.all([
      xdgCapture.finalize(),
      homeCapture.finalize(),
    ])

    expect(xdgSummary.filePath).toBe(
      path.join(
        xdgRoot,
        "state",
        "opencode-ssh",
        "logs",
        "raw",
        `opencode-host-stderr-2026-08-10-${startupID(11)}.bin`
      )
    )
    expect(homeSummary.filePath).toBe(
      path.join(
        home,
        ".local",
        "state",
        "opencode-ssh",
        "logs",
        "raw",
        `opencode-host-stderr-2026-08-10-${startupID(12)}.bin`
      )
    )
  })

  it("repairs relevant directory modes to 0700 and creates the file as 0600", async () => {
    const root = await temporaryRoot()
    const applicationDirectory = path.join(root, "state", "opencode-ssh")
    const logDirectory = path.join(applicationDirectory, "logs")
    const directory = path.join(logDirectory, "raw")
    await mkdir(directory, { recursive: true, mode: 0o777 })
    await Promise.all(
      [applicationDirectory, logDirectory, directory].map((item) => chmod(item, 0o777))
    )
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(13),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })
    capture.accept(Buffer.from("private"))

    const summary = await capture.finalize()

    if (process.platform !== "win32") {
      for (const item of [applicationDirectory, logDirectory, directory]) {
        expect((await stat(item)).mode & 0o777).toBe(0o700)
      }
      expect((await stat(summary.filePath!)).mode & 0o777).toBe(0o600)
    }
  })

  it("strictly prunes only old matching regular files and preserves five days, future, malformed, symlink, and directory entries", async () => {
    const root = await temporaryRoot()
    const directory = rawDirectory(root)
    await mkdir(directory, { recursive: true })
    const staleRegular = rawFilePath(directory, "2026-08-05", startupID(14))
    const retainedBoundary = rawFilePath(directory, "2026-08-06", startupID(15))
    const future = rawFilePath(directory, "2026-08-11", startupID(16))
    const staleSymlink = rawFilePath(directory, "2026-08-01", startupID(17))
    const staleDirectory = rawFilePath(directory, "2026-08-01", startupID(18))
    const target = path.join(root, "symlink-target.bin")
    const preserved = [
      retainedBoundary,
      future,
      path.join(directory, `opencode-host-stderr-2026-99-99-${startupID(19)}.bin`),
      path.join(directory, "opencode-host-stderr-2026-08-01-ABCDEF0123456789ABCDEF0123456789.bin"),
      path.join(directory, `opencode-host-stderr-2026-08-01-${startupID(20)}.bin.backup`),
      path.join(directory, "notes.bin"),
    ]
    await writeFile(staleRegular, "remove")
    await Promise.all(preserved.map((filePath) => writeFile(filePath, "keep")))
    await writeFile(target, "target")
    await symlink(target, staleSymlink)
    await mkdir(staleDirectory)
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(21),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })
    capture.accept(Buffer.from("current"))

    const summary = await capture.finalize()

    expect(summary.retentionStatus).toBe("completed")
    expect(await pathExists(staleRegular)).toBe(false)
    for (const filePath of [...preserved, staleSymlink, staleDirectory, target]) {
      expect(await pathExists(filePath)).toBe(true)
    }
    expect((await lstat(staleSymlink)).isSymbolicLink()).toBe(true)
    expect((await lstat(staleDirectory)).isDirectory()).toBe(true)
  })

  it("rejects a symlinked raw directory without following it for storage or retention", async () => {
    const root = await temporaryRoot()
    const logDirectory = path.join(root, "state", "opencode-ssh", "logs")
    const externalDirectory = path.join(root, "external")
    await mkdir(logDirectory, { recursive: true })
    await mkdir(externalDirectory)
    await symlink(externalDirectory, path.join(logDirectory, "raw"))
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(22),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })
    capture.accept(Buffer.from("must not follow"))

    await expect(capture.finalize()).resolves.toMatchObject({
      observedBytes: 15,
      capturedBytes: 15,
      writtenBytes: 0,
      storageStatus: "open-failed",
      retentionStatus: "failed",
    })
    expect(await readdir(externalDirectory)).toEqual([])
    expect((await lstat(path.join(logDirectory, "raw"))).isSymbolicLink()).toBe(true)
  })

  it("uses exclusive no-follow creation and never overwrites a collision", async () => {
    const root = await temporaryRoot()
    const directory = rawDirectory(root)
    await mkdir(directory, { recursive: true })
    const id = startupID(23)
    const collision = rawFilePath(directory, "2026-08-10", id)
    await writeFile(collision, "existing")
    let observedFlags = 0
    let observedMode = 0
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: id,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      fileSystem: {
        async open(filePath, flags, mode) {
          observedFlags = flags
          observedMode = mode
          return await open(filePath, flags, mode)
        },
      },
    })
    capture.accept(Buffer.from("replacement"))

    await expect(capture.finalize()).resolves.toMatchObject({
      writtenBytes: 0,
      storageStatus: "open-failed",
      retentionStatus: "completed",
    })
    expect(observedFlags & constants.O_CREAT).toBe(constants.O_CREAT)
    expect(observedFlags & constants.O_EXCL).toBe(constants.O_EXCL)
    expect(observedFlags & constants.O_WRONLY).toBe(constants.O_WRONLY)
    expect(observedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(observedMode).toBe(0o600)
    expect(await readFile(collision, "utf8")).toBe("existing")
  })

  it("reports an injected open failure without rejecting", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(24),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      fileSystem: {
        async open() {
          throw new Error("open failed")
        },
      },
    })
    capture.accept(Buffer.from("stderr"))

    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: 6,
      capturedBytes: 6,
      writtenBytes: 0,
      storageStatus: "open-failed",
      retentionStatus: "completed",
    })
    expect(summary).not.toHaveProperty("filePath")
  })

  it("loops over injected partial writes until every captured byte is stored", async () => {
    const root = await temporaryRoot()
    let writeCalls = 0
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(25),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      fileSystem: {
        async write(handle, buffer, offset, length) {
          writeCalls++
          const result = await asWritableHandle(handle).write(
            buffer,
            offset,
            Math.min(length, 2),
            null
          )
          return result.bytesWritten
        },
      },
    })
    capture.accept(Buffer.from("partial"))

    const summary = await capture.finalize()

    expect(writeCalls).toBe(4)
    expect(summary).toMatchObject({
      capturedBytes: 7,
      writtenBytes: 7,
      storageStatus: "complete",
    })
    expect(await readFile(summary.filePath!)).toEqual(Buffer.from("partial"))
  })

  it("reports a partial write failure, preserves its path, and still closes the handle", async () => {
    const root = await temporaryRoot()
    let writeCalls = 0
    let closeCalls = 0
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(26),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      fileSystem: {
        async write(handle, buffer, offset, length) {
          writeCalls++
          if (writeCalls > 1) throw new Error("write failed")
          const result = await asWritableHandle(handle).write(
            buffer,
            offset,
            Math.min(length, 3),
            null
          )
          return result.bytesWritten
        },
        async close(handle) {
          closeCalls++
          await asClosableHandle(handle).close()
        },
      },
    })
    capture.accept(Buffer.from("failure"))

    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: 7,
      capturedBytes: 7,
      writtenBytes: 3,
      storageStatus: "write-failed",
      retentionStatus: "completed",
    })
    expect(summary.filePath).toBe(rawFilePath(rawDirectory(root), "2026-08-10", startupID(26)))
    expect(closeCalls).toBe(1)
    expect(await readFile(summary.filePath!)).toEqual(Buffer.from("fai"))
  })

  it("reports a close failure without losing confirmed bytes or the created path", async () => {
    const root = await temporaryRoot()
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(27),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      fileSystem: {
        async close(handle) {
          await asClosableHandle(handle).close()
          throw new Error("close failed")
        },
      },
    })
    capture.accept(Buffer.from("closed"))

    const summary = await capture.finalize()

    expect(summary).toMatchObject({
      observedBytes: 6,
      capturedBytes: 6,
      writtenBytes: 6,
      storageStatus: "close-failed",
      retentionStatus: "completed",
    })
    expect(summary.filePath).toBe(rawFilePath(rawDirectory(root), "2026-08-10", startupID(27)))
    expect(await readFile(summary.filePath!)).toEqual(Buffer.from("closed"))
  })

  it("reports prune failure separately while preserving successful storage", async () => {
    const root = await temporaryRoot()
    const directory = rawDirectory(root)
    await mkdir(directory, { recursive: true })
    const stalePath = rawFilePath(directory, "2026-08-01", startupID(28))
    await writeFile(stalePath, "stale")
    const capture = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(29),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      fileSystem: {
        async unlink(filePath) {
          if (filePath === stalePath) throw new Error("prune failed")
          throw new Error(`unexpected unlink: ${filePath}`)
        },
      },
    })
    capture.accept(Buffer.from("stored"))

    await expect(capture.finalize()).resolves.toMatchObject({
      observedBytes: 6,
      capturedBytes: 6,
      writtenBytes: 6,
      storageStatus: "complete",
      retentionStatus: "failed",
    })
    expect(await readFile(stalePath, "utf8")).toBe("stale")
  })

  it("never rejects when finalization time or pruning dependencies fail", async () => {
    const root = await temporaryRoot()
    const badClock = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(30),
      now: () => {
        throw new Error("clock failed")
      },
    })
    badClock.accept(Buffer.from("clock"))
    await expect(badClock.finalize()).resolves.toEqual({
      observedBytes: 5,
      capturedBytes: 5,
      writtenBytes: 0,
      truncated: false,
      storageStatus: "open-failed",
      retentionStatus: "failed",
    })

    const badPrune = createRawStderrCapture({
      env: stateEnvironment(root),
      startupID: startupID(31),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      fileSystem: {
        async readdir() {
          throw new Error("readdir failed")
        },
      },
    })
    await expect(badPrune.finalize()).resolves.toMatchObject({
      storageStatus: "empty",
      retentionStatus: "failed",
    })
  })
})
