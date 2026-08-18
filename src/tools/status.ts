import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { RemoteConfig } from "../config.js"
import type { SSHPool } from "../ssh-pool.js"

export function createStatusTool(config: RemoteConfig, sshPool: SSHPool): ToolDefinition {
  return tool({
    description: "Report the active OpenCode SSH target and connection health.",
    args: {},
    async execute(_args, ctx) {
      const health = await sshPool.exec("true", {
        cwd: config.remoteWorkdir,
        timeout: 5_000,
        signal: ctx.abort,
      })
      const status = {
        executor: "ssh",
        targetAlias: config.alias,
        remoteWorkdir: config.remoteWorkdir,
        connectionId: config.targetID,
        controlMaster: health.exitCode === 0 ? "healthy" : "unhealthy",
      }
      return {
        title: `${config.alias}:${config.remoteWorkdir}`,
        output: JSON.stringify(status, null, 2),
        metadata: status,
      }
    },
  })
}
