import type { ToolContext } from "@opencode-ai/plugin"
import { describe, expect, it, vi } from "vitest"
import type { PathMapper } from "../../src/path-mapper.js"
import type { RemotePathResolver } from "../../src/remote-path-resolver.js"
import { quoteShell } from "../../src/shell-quote.js"
import type { SSHPool } from "../../src/ssh-pool.js"
import type { RemoteCommandResult } from "../../src/ssh/client.js"
import type { SyncEngine } from "../../src/sync-engine.js"
import { createReadTool } from "../../src/tools/read.js"

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
})

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
