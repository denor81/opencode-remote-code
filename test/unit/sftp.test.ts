import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  SftpClient,
  SftpClientError,
  quoteSftpPath,
  type SftpClientOptions,
} from "../../src/ssh/sftp.js"

const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("SftpClient", () => {
  it("escapes OpenSSH batch quotes and backslashes literally", () => {
    expect(quoteSftpPath(`/remote/a "quote" \\ slash`)).toBe(
      String.raw`/remote/a\ \"quote\"\ \\\ slash`
    )
    expect(quoteSftpPath("/remote/*?[name]")).toBe(
      String.raw`/remote/\*\?\[name\]`
    )
    expect(() => quoteSftpPath("/remote/line\nbreak")).toThrow(/CR, LF, or NUL/)
  })

  it("escapes literal glob metacharacters in exact batch syntax", async () => {
    const fixture = await createFixture()
    const remote = "/remote/literal*?[name]"
    const local = join(fixture.directory, "literal*?[name]")

    await fixture.client("literal-glob").download(remote, local)

    expect(await readFile(fixture.inputPath, "utf8")).toBe(
      `get ${String.raw`/remote/literal\*\?\[name\]`} ${fixture.directory}/${String.raw`literal\*\?\[name\]`}\n`
    )
  })

  it("downloads with literal argv and one safely quoted batch command", async () => {
    const fixture = await createFixture()
    const alias = "host alias $(not-local)\n--one-value"
    const remote = `/remote/a "double" 'single' \\ $dollar;semi.txt`
    const local = join(fixture.directory, `local "double" 'single' \\ target.txt`)

    await fixture.client(alias).download(remote, local)

    expect(await readCalls(fixture.logPath)).toEqual([
      [
        "-b",
        "-",
        "-o",
        `ControlPath=${fixture.socketPath}`,
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
      ],
    ])
    const input = await readFile(fixture.inputPath, "utf8")
    expect(input).toBe(`get ${quoteSftpPath(remote)} ${quoteSftpPath(local)}\n`)
    expect(input.trimEnd().split("\n")).toHaveLength(1)
  })

  it("uploads in local-to-remote order without interpreting path punctuation", async () => {
    const fixture = await createFixture()
    const local = join(fixture.directory, `source \\ "quoted";$(local).txt`)
    const remote = `/remote/target \\ "quoted";$(remote).txt`

    await fixture.client("upload").upload(local, remote)

    expect(await readFile(fixture.inputPath, "utf8")).toBe(
      `put ${quoteSftpPath(local)} ${quoteSftpPath(remote)}\n`
    )
  })

  it("rejects relative paths and CR, LF, or NUL before spawning", async () => {
    const fixture = await createFixture()
    const client = fixture.client("invalid")
    const local = join(fixture.directory, "local")

    await expect(client.download("relative", local)).rejects.toThrow(/absolute POSIX path/)
    await expect(client.download("/remote\nget /injected", local)).rejects.toThrow(/CR, LF, or NUL/)
    await expect(client.upload("relative", "/remote/file")).rejects.toThrow(/local path must be absolute/)
    await expect(client.upload(local, "/remote/with\0nul")).rejects.toThrow(/CR, LF, or NUL/)
    await expect(readFile(fixture.logPath, "utf8")).rejects.toThrow()
  })

  it("throws a bounded error for a failed transfer and does not retry", async () => {
    const fixture = await createFixture({
      FAKE_SFTP_EXIT_CODE: "1",
      FAKE_SFTP_STDERR: "abcdefgh",
    })
    const client = fixture.client("failure", { maxStderrBytes: 4 })
    const local = join(fixture.directory, "local")

    const error = await client.download("/remote/file", local).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(SftpClientError)
    expect(error).toMatchObject({
      operation: "download",
      result: { exitCode: 1, stderr: "abcd", stderrTruncated: true },
    })
    expect((error as Error).message).toMatch(/SFTP download failed/)
    expect(await readCalls(fixture.logPath)).toHaveLength(1)
  })
})

interface Fixture {
  directory: string
  logPath: string
  inputPath: string
  socketPath: string
  client(alias: string, options?: SftpClientOptions): SftpClient
}

async function createFixture(extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "sftp-client-test-"))
  temporaryDirectories.push(directory)
  const logPath = join(directory, "sftp-argv.jsonl")
  const inputPath = join(directory, "sftp-input")
  const socketPath = join(directory, "control socket")

  return {
    directory,
    logPath,
    inputPath,
    socketPath,
    client: (alias, options = {}) =>
      new SftpClient(alias, socketPath, {
        ...options,
        sftpBinary: fakeSftp,
        env: {
          ...process.env,
          ...extraEnv,
          FAKE_SFTP_LOG: logPath,
          FAKE_SFTP_INPUT: inputPath,
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
