import { rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Hooks } from "@opencode-ai/plugin"

export const PROBE_PROTOCOL = "opencode-ssh-loader-probe-v1" as const

export const PROBE_ENV = {
  token: "OPENCODE_SSH_PROBE_TOKEN",
  resultPath: "OPENCODE_SSH_PROBE_RESULT",
} as const

export interface ProbeRecord {
  protocol: typeof PROBE_PROTOCOL
  token: string
}

export function activateCompatibilityProbe(
  options: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env
): Hooks | null {
  const token = env[PROBE_ENV.token]
  if (!token || options?.compatibilityProbe !== token) return null
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("OpenCode SSH compatibility probe has an invalid token")
  }

  const resultPath = env[PROBE_ENV.resultPath]
  if (!resultPath || !path.isAbsolute(resultPath)) {
    throw new Error("OpenCode SSH compatibility probe has an invalid result path")
  }

  const hooks: Hooks = {
    config: async () => {
      const record: ProbeRecord = { protocol: PROBE_PROTOCOL, token }
      const temporaryPath = `${resultPath}.${process.pid}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      })
      await rename(temporaryPath, resultPath)
    },
  }
  return hooks
}
