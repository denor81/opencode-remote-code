import type { ToolContext } from "@opencode-ai/plugin"
import { describe, expect, it, vi } from "vitest"
import {
  REMOTE_REALPATH_TIMEOUT_MS,
  RemotePathResolver,
} from "../../src/remote-path-resolver.js"
import { quoteShell } from "../../src/shell-quote.js"
import type { SSHPool } from "../../src/ssh-pool.js"
import type { ExecOptions, RemoteCommandResult } from "../../src/ssh/client.js"
import type { SftpTransferOptions } from "../../src/ssh/sftp.js"

describe("RemotePathResolver", () => {
  it("requests permission when an existing workspace symlink escapes", async () => {
    const pool = new FakePool((command) => {
      expect(command).toBe("realpath -e -- /workspace/link/passwd")
      return commandResult("/etc/passwd\n")
    })
    const ask = vi.fn<ToolContext["ask"]>(async () => undefined)

    const resolved = await new RemotePathResolver("/workspace", pool).resolveExisting(
      "link/passwd",
      toolContext(ask)
    )

    expect(resolved).toBe("/etc/passwd")
    expect(ask).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "external_directory",
        patterns: ["/etc/passwd"],
        always: [],
      })
    )
  })

  it("canonicalizes the nearest existing ancestor of missing mutation targets", async () => {
    const responses = new Map<string, RemoteCommandResult>([
      ["realpath -e -- /workspace/link/new/child", commandResult("", "missing", 1)],
      ["realpath -e -- /workspace/link/new", commandResult("", "missing", 1)],
      ["realpath -e -- /workspace/link", commandResult("/etc\n")],
    ])
    const pool = new FakePool((command) => {
      const result = responses.get(command)
      if (!result) throw new Error(`Unexpected command: ${command}`)
      return result
    })
    const ask = vi.fn<ToolContext["ask"]>(async () => undefined)

    const resolved = await new RemotePathResolver("/workspace", pool).resolveMutation(
      "/workspace/link/new/child",
      toolContext(ask)
    )

    expect(resolved.remotePath).toBe("/etc/new/child")
    expect(pool.commands).toEqual(Array.from(responses.keys()))
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0][0]).toMatchObject({
      permission: "external_directory",
      patterns: ["/etc/new/child"],
    })
  })

  it("revalidates a mutation path without opening another permission boundary", async () => {
    let realpathCalls = 0
    const pool = new FakePool((command) => {
      expect(command).toBe("realpath -e -- /workspace/link/file.txt")
      realpathCalls++
      return commandResult(
        realpathCalls === 1
          ? "/workspace/first/file.txt\n"
          : "/outside/second/file.txt\n"
      )
    })
    const ask = vi.fn(async () => undefined)
    const controller = new AbortController()
    const resolved = await new RemotePathResolver("/workspace", pool).resolveMutation(
      "/workspace/link/file.txt",
      toolContext(ask, controller.signal)
    )

    expect(resolved.remotePath).toBe("/workspace/first/file.txt")
    await expect(resolved.revalidate(controller.signal)).rejects.toMatchObject({
      code: "REMOTE_PATH_CHANGED",
      expectedPath: "/workspace/first/file.txt",
      actualPath: "/outside/second/file.txt",
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it("asks once before probing a lexical external path", async () => {
    const events: string[] = []
    const pool = new FakePool((command) => {
      events.push(`exec:${command}`)
      return commandResult("/private/target\n")
    })
    const ctx = toolContext(async (input) => {
      events.push(`ask:${input.patterns[0]}`)
    })

    await new RemotePathResolver("/workspace", pool).resolveExisting(
      "/outside/link",
      ctx
    )

    expect(events).toEqual([
      "ask:/outside/link",
      "exec:realpath -e -- /outside/link",
    ])
  })

  it("never requests external-directory permission for a root workspace", async () => {
    const pool = new FakePool(() => commandResult("/etc/passwd\n"))
    const ask = vi.fn(async () => undefined)

    await expect(
      new RemotePathResolver("/", pool).resolveExisting("etc/passwd", toolContext(ask))
    ).resolves.toBe("/etc/passwd")
    expect(ask).not.toHaveBeenCalled()
  })

  it("quotes path data, uses --, and forwards a finite timeout and AbortSignal", async () => {
    const input = "/workspace/name'; touch /tmp/injected; #"
    const controller = new AbortController()
    const pool = new FakePool(() => commandResult(`${input}\n`))

    await new RemotePathResolver("/workspace", pool).resolveExisting(
      input,
      toolContext(async () => undefined, controller.signal)
    )

    expect(pool.commands).toEqual([`realpath -e -- ${quoteShell(input)}`])
    expect(pool.options[0]).toMatchObject({
      timeout: REMOTE_REALPATH_TIMEOUT_MS,
      signal: controller.signal,
    })
    expect(REMOTE_REALPATH_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(REMOTE_REALPATH_TIMEOUT_MS)).toBe(true)
  })

  it("rejects control characters without permission or remote access", async () => {
    const pool = new FakePool(() => {
      throw new Error("should not execute")
    })
    const ask = vi.fn(async () => undefined)
    const resolver = new RemotePathResolver("/workspace", pool)

    for (const input of ["bad\0path", "bad\npath", "bad\u007fpath", "bad\u0080path"]) {
      await expect(resolver.resolveExisting(input, toolContext(ask))).rejects.toThrow(
        /without control characters/
      )
    }
    expect(pool.commands).toEqual([])
    expect(ask).not.toHaveBeenCalled()
  })

  it.each([
    ["empty", ""],
    ["relative", "not/absolute\n"],
    ["multiple results", "/one\n/two\n"],
    ["control character", "/bad\u0001path\n"],
    ["non-canonical", "/workspace/../etc\n"],
  ])("rejects a successful realpath with %s output", async (_name, stdout) => {
    const pool = new FakePool(() => commandResult(stdout))
    const resolver = new RemotePathResolver("/workspace", pool)

    await expect(
      resolver.resolveExisting("file", toolContext())
    ).rejects.toThrow(/realpath|control characters/)
  })

  it("fails when realpath cannot resolve an existing path or any mutation ancestor", async () => {
    const pool = new FakePool(() => commandResult("", "failure", 1))
    const resolver = new RemotePathResolver("/workspace", pool)

    await expect(resolver.resolveExisting("missing", toolContext())).rejects.toThrow(
      /does not exist or cannot be resolved/
    )
    await expect(resolver.resolveMutation("missing/child", toolContext())).rejects.toThrow(
      /No existing remote ancestor/
    )
    expect(pool.commands.at(-1)).toBe("realpath -e -- /")
  })
})

class FakePool implements SSHPool {
  readonly commands: string[] = []
  readonly options: ExecOptions[] = []

  constructor(
    private readonly handler: (
      command: string,
      options: ExecOptions
    ) => RemoteCommandResult | Promise<RemoteCommandResult>
  ) {}

  async exec(
    command: string,
    options: ExecOptions = {}
  ): Promise<RemoteCommandResult> {
    this.commands.push(command)
    this.options.push(options)
    return this.handler(command, options)
  }

  async download(
    _remotePath: string,
    _localPath: string,
    _options?: SftpTransferOptions
  ): Promise<void> {
    throw new Error("Unexpected download")
  }

  async upload(
    _localPath: string,
    _remotePath: string,
    _options?: SftpTransferOptions
  ): Promise<void> {
    throw new Error("Unexpected upload")
  }

  async close(): Promise<void> {}
}

function toolContext(
  ask: ToolContext["ask"] = async () => undefined,
  abort = new AbortController().signal
): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort,
    metadata: () => {},
    ask,
  }
}

function commandResult(
  stdout = "",
  stderr = "",
  exitCode = 0,
  stdoutTruncated = false
): RemoteCommandResult {
  return {
    stdout,
    stderr,
    exitCode,
    signal: null,
    stdoutTruncated,
    stderrTruncated: false,
  }
}
