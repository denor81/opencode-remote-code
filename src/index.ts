import fs from "node:fs/promises"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { writeReadyHandshake } from "./ready-handshake.js"
import { activateCompatibilityProbe } from "./opencode-probe.js"
import { RemotePathResolver } from "./remote-path-resolver.js"
import { buildRemoteSystemContext } from "./remote-system-prompt.js"
import { quoteShell } from "./shell-quote.js"
import { createSSHPool } from "./ssh-pool.js"
import { SyncEngine } from "./sync-engine.js"
import { createBashTool } from "./tools/bash.js"
import { createEditTool } from "./tools/edit.js"
import { createGlobTool } from "./tools/glob.js"
import { createGrepTool } from "./tools/grep.js"
import { createPatchTool } from "./tools/patch.js"
import { createReadTool } from "./tools/read.js"
import { createStatusTool } from "./tools/status.js"
import { createWriteTool } from "./tools/write.js"

const RemoteCodePlugin: Plugin = async (_input, options) => {
  const probe = activateCompatibilityProbe(options)
  if (probe) return probe

  const config = loadConfig(options)
  if (!config) return {}

  const pathMapper = new PathMapper(config)
  await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true })
  await fs.mkdir(pathMapper.mirrorBase, { recursive: true, mode: 0o700 })

  const manifest = new ManifestManager(pathMapper)
  const sshPool = await createSSHPool(config)
  const pathResolver = new RemotePathResolver(config.remoteWorkdir, sshPool)
  const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool)

  try {
    const platformResult = await sshPool.exec("uname -s", { timeout: 5_000 })
    if (platformResult.exitCode !== 0) {
      throw new Error(`Remote uname failed: ${platformResult.stderr || platformResult.stdout}`)
    }
    const remotePlatform = platformResult.stdout.trim().toLowerCase() || "unknown"

    const gitResult = await sshPool.exec(
      `git -C ${quoteShell(config.remoteWorkdir)} rev-parse --is-inside-work-tree 2>/dev/null`,
      { timeout: 5_000 }
    )
    const isGitRepo = gitResult.exitCode === 0 && gitResult.stdout.trim() === "true"

    const systemContext = await buildRemoteSystemContext({
      alias: config.alias,
      remoteWorkdir: config.remoteWorkdir,
      remotePlatform,
      isGitRepo,
      targetID: config.targetID,
      sshPool,
    })

    const tools = {
      bash: createBashTool(sshPool, config.remoteWorkdir, pathResolver),
      glob: createGlobTool(config, sshPool, pathResolver),
      grep: createGrepTool(config, sshPool, pathResolver),
      read: createReadTool(pathMapper, syncEngine, sshPool, pathResolver),
      write: createWriteTool(pathMapper, syncEngine, pathResolver),
      edit: createEditTool(pathMapper, syncEngine, pathResolver),
      apply_patch: createPatchTool(config, pathMapper, syncEngine, pathResolver),
      remote_status: createStatusTool(config, sshPool),
    }

    await writeReadyHandshake(config.readyPath, {
      launchID: config.launchID,
      nonce: config.readyNonce,
      alias: config.alias,
      canonicalWorkdir: config.remoteWorkdir,
      targetID: config.targetID,
    })

    let disposed = false
    const dispose = async () => {
      if (disposed) return
      disposed = true
      await manifest.save()
      await sshPool.close()
    }

    return {
      tool: tools,
      dispose,
      event: async ({ event }) => {
        if (event.type === "session.deleted") await manifest.save()
      },
      "experimental.chat.system.transform": async (_input, output) => {
        output.system.push(systemContext)
      },
    }
  } catch (error) {
    await sshPool.close()
    throw error
  }
}

export default {
  id: "opencode-ssh",
  server: RemoteCodePlugin,
} satisfies PluginModule
