import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { quoteShell } from "../../src/shell-quote.js"
import {
  SshClient,
  SshClientError,
  type SshClientOptions,
} from "../../src/ssh/client.js"

const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("SshClient", () => {
  it("passes literal argv, sends the script on stdin, and preserves the remote exit status", async () => {
    const fixture = await createFixture({
      FAKE_SSH_STDOUT: "remote output",
      FAKE_SSH_STDERR: "remote warning",
      FAKE_SSH_EXIT_CODE: "23",
    })
    const alias = "host alias $(not-local)\n--still-one-argument"
    const cwd = "/srv/work dir/'$(touch nope);line\nnext"
    const client = fixture.client(alias)

    const result = await client.exec("printf '%s' command", { cwd })

    expect(result).toMatchObject({
      stdout: "remote output",
      stderr: "remote warning",
      exitCode: 23,
      signal: null,
    })
    expect(await readCalls(fixture.logPath)).toEqual([
      [
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
        alias,
        "sh",
        "-s",
      ],
    ])
    expect(await readFile(fixture.inputPath, "utf8")).toBe(
      `cd ${quoteShell(cwd)} || exit $?\nprintf '%s' command`
    )
  })

  it("forwards chunks before exec settles while preserving final output", async () => {
    const fixture = await createFixture({
      FAKE_SSH_CHUNKS: JSON.stringify([
        { stream: "stdout", data: "first" },
        { stream: "stderr", data: "warning", delayMs: 150 },
        { stream: "stdout", data: "last" },
      ]),
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let resolveFirstChunk!: (chunk: Buffer) => void
    const firstChunk = new Promise<Buffer>((resolve) => {
      resolveFirstChunk = resolve
    })
    let settled = false
    const command = fixture.client("streamed").exec("true", {
      onStdout: (chunk) => {
        stdoutChunks.push(chunk)
        resolveFirstChunk(chunk)
      },
      onStderr: (chunk) => stderrChunks.push(chunk),
    })
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
        throw new Error("SSH command settled before the stdout observer ran")
      }),
    ])
    expect(Buffer.isBuffer(observed)).toBe(true)
    expect(observed.toString()).toBe("first")
    expect(settled).toBe(false)

    const result = await command
    expect(Buffer.concat(stdoutChunks).toString()).toBe("firstlast")
    expect(Buffer.concat(stderrChunks).toString()).toBe("warning")
    expect(result).toMatchObject({
      stdout: "firstlast",
      stderr: "warning",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
    })
  })

  it("bounds both output streams", async () => {
    const fixture = await createFixture({
      FAKE_SSH_CHUNKS: JSON.stringify([
        { stream: "stdout", data: "abcd" },
        { stream: "stderr", data: "12345" },
        { stream: "stdout", data: "efgh", delayMs: 25 },
        { stream: "stderr", data: "678", delayMs: 25 },
      ]),
    })
    const client = fixture.client("bounded", { maxStdoutBytes: 4, maxStderrBytes: 5 })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    await expect(
      client.exec("true", {
        onStdout: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      })
    ).resolves.toMatchObject({
      stdout: "abcd",
      stderr: "12345",
      stdoutTruncated: true,
      stderrTruncated: true,
      exitCode: 0,
    })
    expect(Buffer.concat(stdoutChunks).toString()).toBe("abcdefgh")
    expect(Buffer.concat(stderrChunks).toString()).toBe("12345678")
  })

  it("canonicalizes root and workdirs with spaces using pwd -P", async () => {
    const rootFixture = await createFixture({ FAKE_SSH_STDOUT: "/\n" })
    await expect(rootFixture.client("root").canonicalizeWorkdir("/")).resolves.toBe("/")
    expect(await readFile(rootFixture.inputPath, "utf8")).toBe("cd / || exit $?\npwd -P")

    const spacedFixture = await createFixture({ FAKE_SSH_STDOUT: "/srv/real workspace\n" })
    const requested = "/srv/link workspace;$(not-run)"
    await expect(spacedFixture.client("spaces").canonicalizeWorkdir(requested)).resolves.toBe(
      "/srv/real workspace"
    )
    expect(await readFile(spacedFixture.inputPath, "utf8")).toBe(
      `cd ${quoteShell(requested)} || exit $?\npwd -P`
    )
  })

  it("rejects relative or missing workdirs clearly", async () => {
    const relativeFixture = await createFixture()
    await expect(relativeFixture.client("relative").canonicalizeWorkdir("tmp/work")).rejects.toThrow(
      /absolute POSIX path/
    )
    await expect(readFile(relativeFixture.logPath, "utf8")).rejects.toThrow()

    const missingFixture = await createFixture({ FAKE_SSH_EXIT_CODE: "1" })
    await expect(
      missingFixture.client("missing").canonicalizeWorkdir("/does not exist")
    ).rejects.toThrow(/not an existing directory/)
  })

  it("times out one local SSH channel without retrying", async () => {
    const fixture = await createFixture({ FAKE_SSH_COMMAND_DELAY_MS: "1000" })
    const command = fixture
      .client("slow", { killGraceMs: 20 })
      .exec("sleep", { timeout: 500 })
    await waitForFile(fixture.logPath)
    const error = await command.catch((value: unknown) => value)

    expect(error).toMatchObject({ name: "TimeoutError", alias: "slow" })
    expect(await readCalls(fixture.logPath)).toHaveLength(1)
  })

  it("honors AbortSignal and reports transport failures", async () => {
    const abortFixture = await createFixture({ FAKE_SSH_COMMAND_DELAY_MS: "1000" })
    const controller = new AbortController()
    const command = abortFixture
      .client("abort", { killGraceMs: 20 })
      .exec("wait", { signal: controller.signal })
    await waitForFile(abortFixture.logPath)
    controller.abort(new Error("test abort"))

    const abortError = await command.catch((value: unknown) => value)
    expect(abortError).toMatchObject({ name: "AbortError", alias: "abort" })
    expect(await readCalls(abortFixture.logPath)).toHaveLength(1)

    const failedFixture = await createFixture({
      FAKE_SSH_EXIT_CODE: "255",
      FAKE_SSH_STDERR: "connection lost",
    })
    const transportError = await failedFixture.client("failed").exec("true").catch(
      (value: unknown) => value
    )
    expect(transportError).toBeInstanceOf(SshClientError)
    expect((transportError as Error).message).toMatch(/transport failed/)
  })
})

interface Fixture {
  logPath: string
  inputPath: string
  socketPath: string
  client(alias: string, options?: SshClientOptions): SshClient
}

async function createFixture(extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "ssh-client-test-"))
  temporaryDirectories.push(directory)
  const logPath = join(directory, "ssh-argv.jsonl")
  const inputPath = join(directory, "ssh-input")
  const socketPath = join(directory, "control socket")

  return {
    logPath,
    inputPath,
    socketPath,
    client: (alias, options = {}) =>
      new SshClient(alias, socketPath, {
        ...options,
        sshBinary: fakeSsh,
        env: {
          ...process.env,
          ...extraEnv,
          FAKE_SSH_LOG: logPath,
          FAKE_SSH_INPUT: inputPath,
        },
      }),
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await readFile(path).then(() => true, () => false)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for fixture file ${path}`)
}
