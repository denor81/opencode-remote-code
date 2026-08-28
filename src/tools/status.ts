import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { RemoteConfig } from "../config.js"
import type { StatusAttemptToken } from "../session-safety.js"
import type { SSHPool } from "../ssh-pool.js"
import type { RemoteCommandResult } from "../ssh/client.js"
import type { SubagentPolicy } from "../subagent-policy.js"

export function createStatusTool(
  config: RemoteConfig,
  sshPool: SSHPool,
  getSubagentPolicy: () => SubagentPolicy,
  beginStatusCheck: (sessionID: string) => StatusAttemptToken,
  recordStatusResult: (
    sessionID: string,
    attempt: StatusAttemptToken,
    result: RemoteCommandResult
  ) => void
): ToolDefinition {
  return tool({
    description: "Report the active OpenCode SSH target and connection health.",
    args: {},
    async execute(_args, ctx) {
      const attempt = beginStatusCheck(ctx.sessionID)
      const subagentPolicy = getSubagentPolicy()
      await ctx.ask({
        permission: "remote_status",
        patterns: [config.targetID],
        always: [],
        metadata: {
          executor: "ssh",
          targetAlias: config.alias,
          remoteWorkdir: config.remoteWorkdir,
          connectionId: config.targetID,
        },
      })
      const health = await sshPool.exec("true", {
        cwd: config.remoteWorkdir,
        timeout: 5_000,
        signal: ctx.abort,
      })
      throwIfAborted(ctx.abort)
      // Only a completed SSH invocation can restore status after the begin transition.
      recordStatusResult(ctx.sessionID, attempt, health)
      const status = {
        executor: "ssh",
        targetAlias: config.alias,
        remoteWorkdir: config.remoteWorkdir,
        connectionId: config.targetID,
        controlMaster: health.exitCode === 0 ? "healthy" : "unhealthy",
        subagentPolicy,
      }
      return {
        title: `${config.alias}:${config.remoteWorkdir}`,
        output: JSON.stringify(status, null, 2),
        metadata: status,
      }
    },
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error("OpenCode SSH remote_status was aborted before completion")
  error.name = "AbortError"
  throw error
}
