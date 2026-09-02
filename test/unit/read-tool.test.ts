import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PathMapper } from "../../src/path-mapper.js"
import type { RemotePathResolver } from "../../src/remote-path-resolver.js"
import { quoteShell } from "../../src/shell-quote.js"
import type { SSHPool } from "../../src/ssh-pool.js"
import type { ExecOptions, RemoteCommandResult } from "../../src/ssh/client.js"
import type { SyncEngine, SyncTransaction } from "../../src/sync-engine.js"
import { createReadTool } from "../../src/tools/read.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("remote read tool", () => {
  it("single-quotes a canonical path before every shell probe", async () => {
    const remotePath = "/workspace/$(touch /tmp/not-executed);name'quoted"
    const commands: string[] = []
    const pool = {
      async exec(command: string): Promise<RemoteCommandResult> {
        commands.push(command)
        return result(commands.length === 1 ? "DIR\n" : "")
      },
    } as SSHPool
    const ask = vi.fn(async () => undefined)
    const resolver = {
      resolveExisting: vi.fn(async () => remotePath),
    } as unknown as RemotePathResolver
    const mapper = {
      remoteRoot: "/workspace",
      toLocal: vi.fn(),
    } as unknown as PathMapper

    await createReadTool(mapper, {} as SyncEngine, pool, resolver).execute(
      { filePath: remotePath },
      context(ask)
    )

    const quoted = quoteShell(remotePath)
    expect(commands).toEqual([
      `if [ -d ${quoted} ]; then echo "DIR"; elif [ -f ${quoted} ]; then echo "FILE"; else echo "MISSING"; fi`,
      `ls -1pA ${quoted}`,
    ])
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "read",
        patterns: ["$(touch /tmp/not-executed);name'quoted"],
      })
    )
  })

  it.each([
    ["PNG", "image/png", Buffer.from("89504e470d0a1a0a00000000", "hex")],
    ["JPEG", "image/jpeg", Buffer.from("ffd8ffe00000000000000000", "hex")],
    ["GIF", "image/gif", Buffer.from("474946383961000000000000", "hex")],
    ["WebP", "image/webp", Buffer.from("524946460000000057454250", "hex")],
  ])("returns %s bytes as an image attachment", async (_name, mime, bytes) => {
    const fixture = await fileFixture({ remoteBytes: bytes })

    const value = await fixture.tool.execute(
      { filePath: fixture.remotePath },
      context(fixture.ask)
    )
    if (typeof value === "string") throw new Error("Expected a structured tool result")

    expect(value).toEqual({
      title: fixture.remotePath,
      output: "Image read successfully",
      metadata: { preview: "Image read successfully", truncated: false },
      attachments: [
        {
          type: "file",
          mime,
          url: `data:${mime};base64,${bytes.toString("base64")}`,
        },
      ],
    })
    expect(value.output).not.toContain(bytes.toString("base64"))
    expect(value.metadata?.preview).not.toContain(bytes.toString("base64"))
    expect(fixture.pull).toHaveBeenCalledWith(
      fixture.remotePath,
      expect.any(AbortSignal),
      3 * 1024 * 1024
    )
    expect(fixture.ask).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "read", patterns: ["image.dat"] })
    )
  })

  it("detects an image from content even when the extension is binary", async () => {
    const bytes = Buffer.from("ffd8ffe00000000000000000", "hex")
    const fixture = await fileFixture({
      remoteBytes: bytes,
      remotePath: "/workspace/photo.bin",
    })

    const value = await fixture.tool.execute(
      { filePath: fixture.remotePath },
      context(fixture.ask)
    )
    if (typeof value === "string") throw new Error("Expected a structured tool result")

    expect(value.attachments).toEqual([
      {
        type: "file",
        mime: "image/jpeg",
        url: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      },
    ])
  })

  it("quotes the canonical image path in the size and header probe", async () => {
    const remotePath = "/workspace/$(touch /tmp/not-executed);image'quoted.png"
    const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex")
    const fixture = await fileFixture({ remoteBytes: bytes, remotePath })

    await fixture.tool.execute({ filePath: remotePath }, context(fixture.ask))

    const quoted = quoteShell(remotePath)
    expect(fixture.commands[1]).toBe(
      [
        `size=$(stat -c %s -- ${quoted}) || exit $?`,
        `printf '%s\\n' "$size"`,
        `dd bs=12 count=1 if=${quoted} 2>/dev/null | od -An -v -tx1 2>/dev/null || :`,
      ].join("; ")
    )
  })

  it.each([
    ["misleading PNG", "/workspace/not-image.png", Buffer.from("plain text\n")],
    ["SVG", "/workspace/vector.svg", Buffer.from("<svg></svg>\n")],
    ["BMP", "/workspace/image.bmp", Buffer.from("BMnot-supported")],
  ])("keeps %s out of image attachments", async (_name, remotePath, bytes) => {
    const fixture = await fileFixture({ remoteBytes: bytes, remotePath })

    await expect(
      fixture.tool.execute({ filePath: remotePath }, context(fixture.ask))
    ).rejects.toThrow(/Cannot read binary file.*Only PNG, JPEG, GIF, and WebP/su)
    expect(fixture.transaction).not.toHaveBeenCalled()
  })

  it("rejects an oversized image before download", async () => {
    const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex")
    const fixture = await fileFixture({
      remoteBytes: bytes,
      reportedSize: 3 * 1024 * 1024 + 1,
    })

    await expect(
      fixture.tool.execute({ filePath: fixture.remotePath }, context(fixture.ask))
    ).rejects.toThrow(/Image exceeds the 3 MiB limit/u)
    expect(fixture.transaction).not.toHaveBeenCalled()
    expect(fixture.pull).not.toHaveBeenCalled()
  })

  it("rejects an image that grows beyond the limit during download", async () => {
    const remoteBytes = Buffer.from("89504e470d0a1a0a00000000", "hex")
    const downloadedBytes = Buffer.concat([
      remoteBytes,
      Buffer.alloc(3 * 1024 * 1024 + 1 - remoteBytes.byteLength),
    ])
    const fixture = await fileFixture({ remoteBytes, downloadedBytes })

    await expect(
      fixture.tool.execute({ filePath: fixture.remotePath }, context(fixture.ask))
    ).rejects.toThrow(/exceeds the 3 MiB limit after download/u)
  })

  it("rejects an image whose size changes during download", async () => {
    const remoteBytes = Buffer.from("89504e470d0a1a0a00000000", "hex")
    const fixture = await fileFixture({
      remoteBytes,
      downloadedBytes: Buffer.concat([remoteBytes, Buffer.from([0])]),
    })

    await expect(
      fixture.tool.execute({ filePath: fixture.remotePath }, context(fixture.ask))
    ).rejects.toThrow(/File changed during download/u)
  })

  it("rejects an image whose type changes during download", async () => {
    const fixture = await fileFixture({
      remoteBytes: Buffer.from("89504e470d0a1a0a00000000", "hex"),
      downloadedBytes: Buffer.from("ffd8ffe00000000000000000", "hex"),
    })

    await expect(
      fixture.tool.execute({ filePath: fixture.remotePath }, context(fixture.ask))
    ).rejects.toThrow(/File type changed during download/u)
  })

  it("revalidates the canonical image path immediately before download", async () => {
    const fixture = await fileFixture({
      remoteBytes: Buffer.from("89504e470d0a1a0a00000000", "hex"),
    })
    const changed = new Error("canonical path changed")
    fixture.revalidateExisting
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(changed)

    await expect(
      fixture.tool.execute({ filePath: fixture.remotePath }, context(fixture.ask))
    ).rejects.toBe(changed)
    expect(fixture.pull).not.toHaveBeenCalled()
  })

  it("continues to read ordinary text after the image probe", async () => {
    const bytes = Buffer.from("plain text\n")
    const fixture = await fileFixture({
      remoteBytes: bytes,
      remotePath: "/workspace/notes.txt",
    })

    const value = await fixture.tool.execute(
      { filePath: fixture.remotePath },
      context(fixture.ask)
    )
    if (typeof value === "string") throw new Error("Expected a structured tool result")

    expect(value.output).toContain("1: plain text")
    expect(value).not.toHaveProperty("attachments")
    expect(fixture.commands).toHaveLength(4)
  })
})

interface FileFixtureOptions {
  downloadedBytes?: Buffer
  remoteBytes: Buffer
  remotePath?: string
  reportedSize?: number
}

async function fileFixture(options: FileFixtureOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocssh-read-tool-"))
  temporaryDirectories.push(root)
  const remotePath = options.remotePath ?? "/workspace/image.dat"
  const localPath = path.join(root, "content")
  const downloadedBytes = options.downloadedBytes ?? options.remoteBytes
  const commands: string[] = []
  const observedSignals: Array<AbortSignal | undefined> = []
  const pool = {
    async exec(command: string, execOptions: ExecOptions): Promise<RemoteCommandResult> {
      commands.push(command)
      observedSignals.push(execOptions.signal)
      if (command.startsWith("if [ -d ")) return result("FILE\n")
      if (command.startsWith("size=$(stat -c %s -- ")) {
        const header = options.remoteBytes.subarray(0, 12)
        const octets = Array.from(header, (byte) => byte.toString(16).padStart(2, "0"))
        return result(`${options.reportedSize ?? options.remoteBytes.byteLength}\n${octets.join(" ")}\n`)
      }
      if (command.startsWith("file -b ")) return result("ASCII text\n")
      if (command.startsWith("dd bs=4096 ")) return result("NO_NULL\n")
      throw new Error(`Unexpected remote command: ${command}`)
    },
  } as SSHPool
  const ask = vi.fn<ToolContext["ask"]>(async () => undefined)
  const revalidateExisting = vi.fn(async () => undefined)
  const resolver = {
    resolveExisting: vi.fn(async () => remotePath),
    revalidateExisting,
  } as unknown as RemotePathResolver
  const mapper = {
    remoteRoot: "/workspace",
    toLocal: vi.fn(() => localPath),
  } as unknown as PathMapper
  const pull = vi.fn(async () => {
    await writeFile(localPath, downloadedBytes)
    return true
  })
  const transaction = vi.fn(
    async (
      operation: (transaction: SyncTransaction) => Promise<unknown>,
      _signal?: AbortSignal
    ) => operation({ pull } as unknown as SyncTransaction)
  )
  const syncEngine = { transaction } as unknown as SyncEngine

  return {
    ask,
    commands,
    observedSignals,
    pull,
    revalidateExisting,
    remotePath,
    tool: createReadTool(mapper, syncEngine, pool, resolver),
    transaction,
  }
}

function context(ask: ToolContext["ask"]): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: new AbortController().signal,
    metadata: () => {},
    ask,
  }
}

function result(stdout: string): RemoteCommandResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}
