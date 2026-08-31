import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ProcessError,
  ProcessTerminationError,
  spawnChecked,
  spawnManaged,
  spawnProcess,
} from "../../src/process.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("process helpers", () => {
  it("preserves adversarial arguments as literal argv entries", async () => {
    const values = ["a b", "$(id)", `single'and\"double`, "line one\nline two"]
    const result = await spawnChecked(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...values]
    )

    expect(JSON.parse(result.stdout)).toEqual(values)
  })

  it("writes input to stdin", async () => {
    const result = await spawnChecked(
      process.execPath,
      [
        "-e",
        "let value='';process.stdin.on('data',c=>value+=c);process.stdin.on('end',()=>process.stdout.write(value))",
      ],
      { input: "literal $(input)\nsecond line" }
    )

    expect(result.stdout).toBe("literal $(input)\nsecond line")
  })

  it("observes a stdout chunk before the delayed process settles", async () => {
    let resolveFirstChunk!: (chunk: Buffer) => void
    const firstChunk = new Promise<Buffer>((resolve) => {
      resolveFirstChunk = resolve
    })
    let settled = false
    const command = spawnProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write('first');setTimeout(()=>process.stdout.write('second'),150)",
      ],
      { onStdout: resolveFirstChunk }
    )
    void command.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    const observed = await Promise.race([
      firstChunk,
      command.then(() => {
        throw new Error("Process settled before the stdout observer ran")
      }),
    ])
    expect(Buffer.isBuffer(observed)).toBe(true)
    expect(observed.toString()).toBe("first")
    expect(settled).toBe(false)

    const result = await command
    expect(result.stdout).toBe("firstsecond")
  })

  it("observes complete output after bounded captures are full", async () => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const result = await spawnProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write('abcd');process.stderr.write('12345');setTimeout(()=>{process.stdout.write('efgh');process.stderr.write('678')},50)",
      ],
      {
        maxStdoutBytes: 4,
        maxStderrBytes: 5,
        onStdout: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      }
    )

    expect(stdoutChunks.every(Buffer.isBuffer)).toBe(true)
    expect(stderrChunks.every(Buffer.isBuffer)).toBe(true)
    expect(Buffer.concat(stdoutChunks).toString()).toBe("abcdefgh")
    expect(Buffer.concat(stderrChunks).toString()).toBe("12345678")
    expect(result).toMatchObject({
      stdout: "abcd",
      stderr: "12345",
      stdoutTruncated: true,
      stderrTruncated: true,
    })
  })

  it("bounds stdout and stderr while draining both streams", async () => {
    const result = await spawnProcess(
      process.execPath,
      ["-e", "process.stdout.write('abcdefgh');process.stderr.write('12345678')"],
      { maxStdoutBytes: 4, maxStderrBytes: 5 }
    )

    expect(result).toMatchObject({
      stdout: "abcd",
      stderr: "12345",
      stdoutTruncated: true,
      stderrTruncated: true,
      exitCode: 0,
      signal: null,
    })
  })

  it.skipIf(process.platform === "win32")(
    "settles after child exit when a detached descendant inherits captured stderr",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "process-inherited-stderr-test-"))
      temporaryDirectories.push(directory)
      const pidPath = join(directory, "descendant.pid")
      const descendantScript = [
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid))',
        "setTimeout(() => process.exit(0), 2000)",
      ].join(";")
      const parentScript = [
        'const { spawn } = require("node:child_process")',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}, process.argv[1]], { detached: true, stdio: ["ignore", "ignore", 2] })`,
        "child.unref()",
        'child.once("spawn", () => { process.stderr.write("master diagnostic\\n"); setTimeout(() => process.exit(0), 20) })',
      ].join(";")
      const startedAt = Date.now()
      const child = spawnManaged(
        process.execPath,
        ["-e", parentScript, pidPath],
        {
          closeCapturedOutputOnExit: true,
          maxStderrBytes: 0,
        }
      )

      const result = await child.wait()

      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(result).toMatchObject({
        exitCode: 0,
        stderr: "",
        stderrTruncated: true,
      })
      await expect
        .poll(() => readFile(pidPath, "utf8").catch(() => ""))
        .toMatch(/^\d+$/u)
      const descendantPid = Number(await readFile(pidPath, "utf8"))
      try {
        process.kill(descendantPid, "SIGKILL")
      } catch {
        // The bounded descendant may already have exited.
      }
    }
  )

  it("reports non-zero exit codes through ProcessError", async () => {
    const error = await spawnChecked(process.execPath, ["-e", "process.exit(7)"]).catch(
      (value: unknown) => value
    )

    expect(error).toBeInstanceOf(ProcessError)
    expect((error as ProcessError).result).toMatchObject({ exitCode: 7, signal: null })
  })

  it("terminates a timed-out process with TERM followed by KILL", async () => {
    const error = await spawnChecked(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { timeoutMs: 150, killGraceMs: 50 }
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ProcessError)
    expect((error as ProcessError).result).toMatchObject({
      signal: "SIGKILL",
      termination: "timeout",
      timedOut: true,
    })
  })

  it("honors AbortSignal and exposes the terminating signal", async () => {
    const controller = new AbortController()
    const child = spawnManaged(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      { signal: controller.signal, killGraceMs: 100 }
    )
    setTimeout(() => controller.abort(), 250)

    const result = await child.result
    expect(result).toMatchObject({
      termination: "abort",
      aborted: true,
    })
    expect(
      (result.exitCode === 0 && result.signal === null) ||
        (result.exitCode === null && result.signal === "SIGTERM")
    ).toBe(true)
  })

  it.skipIf(process.platform === "win32")(
    "terminates an owned process group including a TERM-resistant descendant",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "process-tree-test-"))
      temporaryDirectories.push(directory)
      const descendantReadyPath = join(directory, "descendant.pid")
      const descendantScript = [
        'const { writeFileSync } = require("node:fs")',
        'process.on("SIGTERM", () => {})',
        'writeFileSync(process.argv[1], `${process.pid}\\n`)',
        "setInterval(() => {}, 1000)",
      ].join(";")
      const parentScript = [
        'const { spawn } = require("node:child_process")',
        'process.on("SIGTERM", () => {})',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}, process.argv[1]], { stdio: "ignore" })`,
        "setInterval(() => {}, 1000)",
      ].join(";")
      const child = spawnManaged(
        process.execPath,
        ["-e", parentScript, descendantReadyPath],
        { terminationMode: "process-group", killGraceMs: 50 }
      )
      const childPid = child.pid
      expect(childPid).toEqual(expect.any(Number))
      const descendantPid = Number((await waitForFile(descendantReadyPath)).trim())

      try {
        const result = await child.terminate()

        expect(result).toMatchObject({
          signal: "SIGKILL",
          termination: "requested",
        })
        await expectProcessGone(childPid!)
        await expectProcessGone(descendantPid)
      } finally {
        terminatePid(descendantPid)
        terminatePid(childPid!)
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "reports non-ESRCH process-group signal failures after bounded attempts",
    async () => {
      const child = spawnManaged(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { terminationMode: "process-group", killGraceMs: 20 }
      )
      const childPid = child.pid
      expect(childPid).toEqual(expect.any(Number))
      const originalKill = process.kill.bind(process)
      const signalFailure = Object.assign(new Error("injected signal failure"), {
        code: "EPERM",
      })
      const kill = vi.spyOn(process, "kill").mockImplementation(
        ((pid: number, signal?: NodeJS.Signals | number) => {
          if (pid < 0) throw signalFailure
          return originalKill(pid, signal)
        }) as typeof process.kill
      )

      try {
        const error = await child.terminate().catch((value: unknown) => value)

        expect(error).toBeInstanceOf(ProcessTerminationError)
        expect((error as ProcessTerminationError).failures).toHaveLength(3)
        expect((error as Error).message).toMatch(/owned process group/i)
      } finally {
        kill.mockRestore()
        terminatePid(childPid!)
        await expectProcessGone(childPid!)
      }
    }
  )
})

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const contents = await readFile(filePath, "utf8").catch(() => undefined)
    if (contents !== undefined) return contents
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

async function expectProcessGone(pid: number): Promise<void> {
  await expect.poll(
    () => {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    },
    { interval: 10, timeout: 2_000 }
  ).toBe(true)
}

function terminatePid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Already gone.
  }
}
