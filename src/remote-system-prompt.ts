export interface RemoteSystemContext {
  alias: string
  remoteWorkdir: string
  remotePlatform: string
  isGitRepo: boolean
  targetID: string
  taskResumeEnabled: boolean
}

/** Build a compact context element without replacing OpenCode's normal prompt. */
export async function buildRemoteSystemContext(ctx: RemoteSystemContext): Promise<string> {
  return [
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
    ...(ctx.taskResumeEnabled
      ? [
          "- Task resume is limited to the exact task_id of a successfully completed foreground direct child created by this root during this launch.",
          "- A resumed child must repeat package remote_status and the exact identity Bash preflight before project tools.",
        ]
      : ["- Task resume is disabled for the selected OpenCode version."]),
  ].join("\n")
}
