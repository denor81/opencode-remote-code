import path from "node:path"
import type { SSHPool } from "./ssh-pool.js"
import { quoteShell } from "./shell-quote.js"

export interface RemoteSystemContext {
  alias: string
  remoteWorkdir: string
  remotePlatform: string
  isGitRepo: boolean
  targetID: string
  sshPool: SSHPool
}

/** Build a compact context element without replacing OpenCode's normal prompt. */
export async function buildRemoteSystemContext(ctx: RemoteSystemContext): Promise<string> {
  const parts = [
    "OpenCode SSH remote project context:",
    `- SSH alias: ${ctx.alias}`,
    `- Remote workspace: ${ctx.remoteWorkdir}`,
    `- Remote platform: ${ctx.remotePlatform}`,
    `- Remote git repository: ${ctx.isGitRepo ? "yes" : "no"}`,
    `- Connection ID: ${ctx.targetID}`,
    "- bash, read, write, edit, glob, grep, and apply_patch operate on this SSH target.",
    "- Other OpenCode tools, plugins, MCP servers, LSP, formatters, and TUI APIs may remain local.",
    "- The remote workspace is the default directory, not a privilege boundary. Paths outside it require permission.",
    "- Each bash call is a separate remote shell. A cd command does not persist into later calls.",
    "- Use sudo -n only for explicit administrative shell commands; file tools do not elevate through sudo.",
  ]

  const agentsPath = path.posix.join(ctx.remoteWorkdir, "AGENTS.md")
  try {
    const result = await ctx.sshPool.exec(
      `if [ -f ${quoteShell(agentsPath)} ]; then head -c 32768 -- ${quoteShell(agentsPath)}; fi`,
      { timeout: 10_000 }
    )
    if (result.exitCode === 0 && result.stdout.trim()) {
      parts.push(`\nInstructions from remote ${agentsPath}:\n${result.stdout}`)
    }
  } catch {
    // Remote instructions are optional; transport health is checked separately.
  }

  return parts.join("\n")
}
