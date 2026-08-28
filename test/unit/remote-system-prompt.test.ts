import { describe, expect, it, vi } from "vitest"
import { buildRemoteSystemContext } from "../../src/remote-system-prompt.js"
import type { SSHPool } from "../../src/ssh-pool.js"

const REMOTE_AGENTS_MARKER = "REMOTE_AGENTS_TASK2_MARKER"

describe("remote system context", () => {
  it("does not use SSH to build provider context", async () => {
    const sshPool = remoteAgentsPool()

    await buildRemoteSystemContext(contextInput(sshPool))

    expect(sshPool.exec).not.toHaveBeenCalled()
  })

  it("contains only the bounded generated target context", async () => {
    const context = await buildRemoteSystemContext(contextInput(remoteAgentsPool()))

    expect(context).toBe(
      [
        "OpenCode SSH remote project context:",
        "- SSH alias: fixture-host",
        "- Remote workspace: /srv/canonical project",
        "- Remote platform: linux",
        "- Remote git repository: yes",
        "- Connection ID: target-123",
        "- bash, read, write, edit, glob, grep, and apply_patch operate on this SSH target.",
        "- Package remote_status internally runs and validates hostname; whoami; pwd -P in the remote workspace and completes this session's preflight.",
        "- Other OpenCode tools, plugins, MCP servers, LSP, formatters, and TUI APIs may remain local.",
        "- The remote workspace is the default directory, not a privilege boundary. Paths outside it require permission.",
        "- Each bash call is a separate remote shell. A cd command does not persist into later calls.",
        "- Use sudo -n only for explicit administrative shell commands; file tools do not elevate through sudo.",
        "- Task resume is disabled for the selected OpenCode version.",
      ].join("\n")
    )
    expect(context).not.toContain(REMOTE_AGENTS_MARKER)
    expect(context).not.toContain("Instructions from remote")
  })

  it("exposes the bounded same-launch resume capability and repeated preflight", async () => {
    const context = await buildRemoteSystemContext({
      ...contextInput(remoteAgentsPool()),
      taskResumeEnabled: true,
    })

    expect(context).toContain(
      "Task resume is limited to the exact task_id of a successfully completed foreground direct child created by this root during this launch."
    )
    expect(context).toContain(
      "A resumed child must repeat the one-step package remote_status preflight before project tools."
    )
    expect(context).not.toContain("Task resume is disabled")
  })
})

function contextInput(sshPool: SSHPool) {
  return {
    alias: "fixture-host",
    remoteWorkdir: "/srv/canonical project",
    remotePlatform: "linux",
    isGitRepo: true,
    targetID: "target-123",
    taskResumeEnabled: false,
    sshPool,
  }
}

function remoteAgentsPool(): SSHPool {
  return {
    exec: vi.fn(async () => ({
      stdout: `${REMOTE_AGENTS_MARKER}: untrusted remote instructions\n`,
      stderr: "",
      exitCode: 0,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
    })),
    download: vi.fn(async () => undefined),
    upload: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}
