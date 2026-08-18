import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { describe, expect, it } from "vitest"
import type { RemoteConfig } from "../../src/config.js"
import { ManifestManager } from "../../src/manifest.js"
import { PathMapper } from "../../src/path-mapper.js"
import { RemotePathResolver } from "../../src/remote-path-resolver.js"
import { createLaunchPaths, createRuntimePaths } from "../../src/runtime-paths.js"
import { quoteShell } from "../../src/shell-quote.js"
import { createSSHPool } from "../../src/ssh-pool.js"
import { SshClient } from "../../src/ssh/client.js"
import { ControlMaster } from "../../src/ssh/control-master.js"
import { RemoteFileConflict, SyncEngine } from "../../src/sync-engine.js"
import { createBashTool } from "../../src/tools/bash.js"
import { createEditTool } from "../../src/tools/edit.js"
import { createGlobTool } from "../../src/tools/glob.js"
import { createGrepTool } from "../../src/tools/grep.js"
import { createPatchTool } from "../../src/tools/patch.js"
import { createReadTool } from "../../src/tools/read.js"
import { createStatusTool } from "../../src/tools/status.js"
import { createWriteTool } from "../../src/tools/write.js"

const alias = process.env.OPENCODE_SSH_TEST_ALIAS
const requestedWorkdir = process.env.OPENCODE_SSH_TEST_WORKDIR
const enabled = Boolean(alias && requestedWorkdir)

describe("opt-in real SSH fit", () => {
  it.skipIf(!enabled)(
    "runs every supported remote tool in a disposable directory",
    async () => {
      const targetAlias = alias!
      const localRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-ssh-real-fit-"))
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        XDG_STATE_HOME: path.join(localRoot, "state"),
        XDG_CACHE_HOME: path.join(localRoot, "cache"),
        XDG_RUNTIME_DIR: path.join(localRoot, "run"),
      }
      const controller = new AbortController()
      const launchPaths = await createLaunchPaths({ env })
      let master: ControlMaster | undefined
      let pool: Awaited<ReturnType<typeof createSSHPool>> | undefined
      let automatedDir: string | undefined

      try {
        master = await ControlMaster.start(
          targetAlias,
          launchPaths.socketPath,
          controller.signal,
          { env, startupTimeoutMs: 120_000 }
        )
        const transport = new SshClient(targetAlias, launchPaths.socketPath, { env })
        const canonicalWorkdir = await transport.canonicalizeWorkdir(requestedWorkdir!)
        const paths = await createRuntimePaths({
          alias: targetAlias,
          canonicalWorkdir,
          launchID: launchPaths.launchID,
          env,
        })
        const config: RemoteConfig = {
          alias: targetAlias,
          remoteWorkdir: canonicalWorkdir,
          controlSocket: paths.socketPath,
          targetID: paths.targetID,
          launchID: paths.launchID,
          readyPath: paths.readyPath,
          readyNonce: "real-fit-ready-nonce-0123456789abcdef0123456789abcdef",
          runtimeDir: paths.runtimeDir,
          mirrorRoot: paths.mirrorDir,
          sshBinary: "ssh",
          sftpBinary: "sftp",
          active: true,
        }
        pool = await createSSHPool(config)
        const mapper = new PathMapper(config)
        const manifest = new ManifestManager(mapper)
        const sync = new SyncEngine(config, mapper, manifest, pool)
        const resolver = new RemotePathResolver(canonicalWorkdir, pool)
        const permissions: Array<Parameters<ToolContext["ask"]>[0]> = []
        const ctx = context(async (request) => {
          permissions.push(request)
        })

        const candidateAutomatedDir = path.posix.join(canonicalWorkdir, "automated")
        expect(
          (
            await pool.exec(`mkdir -- ${quoteShell(candidateAutomatedDir)}`, {
              timeout: 10_000,
            })
          ).exitCode
        ).toBe(0)
        automatedDir = candidateAutomatedDir
        const testDir = candidateAutomatedDir

        const bash = createBashTool(pool, canonicalWorkdir, resolver)
        const read = createReadTool(mapper, sync, pool, resolver)
        const write = createWriteTool(mapper, sync, resolver)
        const edit = createEditTool(mapper, sync, resolver)
        const glob = createGlobTool(config, pool, resolver)
        const grep = createGrepTool(config, pool, resolver)
        const patch = createPatchTool(config, mapper, sync, resolver)
        const status = createStatusTool(config, pool)

        expect(output(await status.execute({}, ctx))).toContain('"controlMaster": "healthy"')
        expect(
          output(
            await bash.execute(
              { command: "pwd -P; whoami; uname -s", description: "real fit identity" },
              ctx
            )
          )
        ).toContain(canonicalWorkdir)
        expect(
          output(
            await bash.execute(
              { command: "sudo -n id -u", description: "passwordless sudo check" },
              ctx
            )
          ).trim()
        ).toBe("0")

        const samplePath = path.posix.join(testDir, "sample file.txt")
        const globLiteralPath = path.posix.join(testDir, "literal[1]?.txt")
        await write.execute({ filePath: samplePath, content: "alpha beta\n" }, ctx)
        await write.execute({ filePath: globLiteralPath, content: "literal glob name\n" }, ctx)
        expect(output(await read.execute({ filePath: globLiteralPath }, ctx))).toContain(
          "literal glob name"
        )

        await edit.execute(
          {
            filePath: samplePath,
            oldString: "alpha beta",
            newString: "updated beta",
          },
          ctx
        )
        await patch.execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Add File: automated/added.txt",
              "+added through patch",
              "*** Update File: automated/sample file.txt",
              "@@",
              "-updated beta",
              "+updated gamma",
              "*** End Patch",
            ].join("\n"),
          },
          ctx
        )

        expect(
          output(await glob.execute({ pattern: "*.txt", path: testDir }, ctx))
        ).toContain(samplePath)
        expect(
          output(
            await grep.execute(
              { pattern: "updated gamma", path: testDir, include: "*.txt" },
              ctx
            )
          )
        ).toContain(samplePath)
        expect(output(await read.execute({ filePath: samplePath }, ctx))).toContain(
          "updated gamma"
        )

        const externalPermissionsBefore = permissions.filter(
          (permission) => permission.permission === "external_directory"
        ).length
        expect(output(await read.execute({ filePath: "/etc/os-release" }, ctx))).toContain(
          "<type>file</type>"
        )
        expect(
          permissions.filter((permission) => permission.permission === "external_directory")
        ).toHaveLength(externalPermissionsBefore + 1)

        const rootPermissions: Array<Parameters<ToolContext["ask"]>[0]> = []
        await new RemotePathResolver("/", pool).resolveExisting(
          "/etc/os-release",
          context(async (request) => rootPermissions.push(request))
        )
        expect(rootPermissions).toEqual([])

        const conflictPath = path.posix.join(testDir, "conflict.txt")
        await write.execute({ filePath: conflictPath, content: "initial\n" }, ctx)
        const conflictContext = context(async (request) => {
          if (request.permission !== "edit") return
          const changed = await pool!.exec(
            `printf '%s\\n' 'second writer' > ${quoteShell(conflictPath)}`,
            { timeout: 10_000 }
          )
          if (changed.exitCode !== 0) throw new Error(changed.stderr)
        })
        await expect(
          write.execute({ filePath: conflictPath, content: "stale writer\n" }, conflictContext)
        ).rejects.toBeInstanceOf(RemoteFileConflict)
        const conflictContent = await pool.exec(`cat -- ${quoteShell(conflictPath)}`, {
          timeout: 10_000,
        })
        expect(conflictContent.stdout).toBe("second writer\n")

        await expect(
          patch.execute(
            {
              patchText: [
                "*** Begin Patch",
                "*** Delete File: automated/added.txt",
                "*** End Patch",
              ].join("\n"),
            },
            ctx
          )
        ).rejects.toThrow(/deletion is disabled/)

        const lockCheck = await pool.exec(
          `find ${quoteShell(testDir)} -maxdepth 1 -name '.opencode-lock-*' -print`,
          { timeout: 10_000 }
        )
        expect(lockCheck.stdout).toBe("")
      } finally {
        if (pool && automatedDir) {
          await pool.exec(`rm -rf -- ${quoteShell(automatedDir)}`, {
            timeout: 10_000,
          }).catch(() => undefined)
        }
        await pool?.close().catch(() => undefined)
        await master?.close().catch(() => undefined)
        await rm(localRoot, { recursive: true, force: true })
      }
    },
    180_000
  )
})

function context(ask: ToolContext["ask"]): ToolContext {
  return {
    sessionID: "real-fit-session",
    messageID: "real-fit-message",
    agent: "build",
    directory: "/remote-fit",
    worktree: "/remote-fit",
    abort: new AbortController().signal,
    metadata: () => {},
    ask,
  }
}

function output(result: ToolResult): string {
  return typeof result === "string" ? result : result.output
}
