import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { RemoteConfig } from "../config.js"
import {
  IDENTITY_COMMAND,
  type RemoteIdentity,
  type StatusAttemptToken,
} from "../session-safety.js"
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
  ) => RemoteIdentity | null
): ToolDefinition {
  return tool({
    description:
      "Verify the active OpenCode SSH target, remote identity, and session preflight.",
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
      const preflight = await sshPool.exec(IDENTITY_COMMAND, {
        cwd: config.remoteWorkdir,
        timeout: 5_000,
        signal: ctx.abort,
      })
      throwIfAborted(ctx.abort)
      // Only a completed, validated SSH invocation can restore preflight.
      const identity = recordStatusResult(ctx.sessionID, attempt, preflight)
      const status = {
        executor: "ssh",
        targetAlias: config.alias,
        remoteWorkdir: config.remoteWorkdir,
        connectionId: config.targetID,
        controlMaster: preflight.exitCode === 0 ? "healthy" : "unhealthy",
        ...(identity === null ? {} : { identity }),
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
