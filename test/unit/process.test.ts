import { describe, expect, it } from "vitest"
import {
  ProcessError,
  spawnChecked,
  spawnManaged,
  spawnProcess,
} from "../../src/process.js"

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
})
