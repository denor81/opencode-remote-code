#!/usr/bin/env node

import { randomBytes } from "node:crypto"
import { realpath, rm } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { REMOTE_ENV } from "./config.js"
import {
  LauncherConfigError,
  mergeOpenCodeConfigContent,
  parseCli,
} from "./launcher-config.js"
import {
  warnIfOpenCodeIsUntested,
  type OpenCodeCompatibilityHooks,
} from "./opencode-compatibility.js"
import { readPackageMetadata } from "./package-metadata.js"
import { spawnManaged, type ManagedProcess, type ProcessResult } from "./process.js"
import {
  removeReadyFile,
  ReadyHandshakeTimeoutError,
  waitForReadyHandshake,
  type ReadyHandshakeIdentity,
} from "./ready-handshake.js"
import { createLaunchPaths, createRuntimePaths } from "./runtime-paths.js"
import { SshClient } from "./ssh/client.js"
import { ControlMaster } from "./ssh/control-master.js"

const HELP = `Usage: opencode-ssh <ssh-alias> <absolute-remote-workdir>

Run the local OpenCode TUI while bash, read, write, edit, glob, grep, and
apply_patch operate through the named system OpenSSH host.

Examples:
  opencode-ssh staging /srv/app
  opencode-ssh admin-host /
`

const SAFETY_INSTRUCTIONS_PATH = fileURLToPath(
  new URL("../opencode-ssh-remote-use/opencode-ssh-safety.md", import.meta.url)
)

interface ExitBeforeReady {
  kind: "exit"
  result: ProcessResult
}

interface Ready {
  kind: "ready"
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  compatibilityHooks: OpenCodeCompatibilityHooks = {}
): Promise<number> {
  const parsed = parseCli(argv)
  if (parsed.action === "help") {
    process.stdout.write(HELP)
    return 0
  }
  if (parsed.action === "version") {
    process.stdout.write(`${(await readPackageMetadata()).version}\n`)
    return 0
  }
  if (/^(1|true)$/i.test(env.OPENCODE_PURE ?? "")) {
    throw new LauncherConfigError(
      "OPENCODE_PURE=1 disables external plugins and cannot be used with opencode-ssh"
    )
  }

  const controller = new AbortController()
  let receivedSignal: NodeJS.Signals | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    receivedSignal ??= signal
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Received ${signal}`))
    }
  }
  const onSigint = () => onSignal("SIGINT")
  const onSigterm = () => onSignal("SIGTERM")
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)

  let master: ControlMaster | undefined
  let openCode: ManagedProcess | undefined
  let readyPath: string | undefined
  let socketPath: string | undefined
  let mirrorPath: string | undefined

  try {
    const opencodeBinary = env.OPENCODE_SSH_OPENCODE_BIN || "opencode"
    const { testedOpenCodeVersion } = await readPackageMetadata()
    await warnIfOpenCodeIsUntested({
      binary: opencodeBinary,
      env,
      signal: controller.signal,
      testedVersion: testedOpenCodeVersion,
      ...compatibilityHooks,
    })

    const launchPaths = await createLaunchPaths({ env })
    socketPath = launchPaths.socketPath
    const sshBinary = env.OPENCODE_SSH_SSH_BIN || "ssh"
    const sftpBinary = env.OPENCODE_SSH_SFTP_BIN || "sftp"

    master = await ControlMaster.start(
      parsed.alias,
      launchPaths.socketPath,
      controller.signal,
      {
        sshBinary,
        env,
        startupTimeoutMs: 120_000,
      }
    )

    const ssh = new SshClient(parsed.alias, launchPaths.socketPath, {
      sshBinary,
      env,
    })
    const canonicalWorkdir = await ssh.canonicalizeWorkdir(parsed.workdir)
    const paths = await createRuntimePaths({
      alias: parsed.alias,
      canonicalWorkdir,
      launchID: launchPaths.launchID,
      env,
    })
    readyPath = paths.readyPath
    mirrorPath = paths.mirrorDir
    await removeReadyFile(paths.readyPath)

    const nonce = randomBytes(32).toString("hex")
    const identity: ReadyHandshakeIdentity = {
      launchID: paths.launchID,
      nonce,
      alias: parsed.alias,
      canonicalWorkdir,
      targetID: paths.targetID,
    }
    // Loading the package root lets OpenCode select the ./server export and
    // skip this server-only plugin in the TUI plugin runtime.
    const pluginURL = new URL("../", import.meta.url)
    const configContent = mergeOpenCodeConfigContent(
      env.OPENCODE_CONFIG_CONTENT,
      pluginURL,
      paths.launchID,
      SAFETY_INSTRUCTIONS_PATH
    )
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      PWD: paths.workspaceDir,
      OPENCODE_CONFIG_CONTENT: configContent,
      [REMOTE_ENV.alias]: parsed.alias,
      [REMOTE_ENV.workdir]: canonicalWorkdir,
      [REMOTE_ENV.socket]: paths.socketPath,
      [REMOTE_ENV.targetID]: paths.targetID,
      [REMOTE_ENV.launchID]: paths.launchID,
      [REMOTE_ENV.readyPath]: paths.readyPath,
      [REMOTE_ENV.readyNonce]: nonce,
      [REMOTE_ENV.runtimeDir]: paths.runtimeDir,
      [REMOTE_ENV.mirrorRoot]: paths.mirrorDir,
      [REMOTE_ENV.sshBinary]: sshBinary,
      [REMOTE_ENV.sftpBinary]: sftpBinary,
    }

    openCode = spawnManaged(opencodeBinary, [], {
      cwd: paths.workspaceDir,
      env: childEnv,
      signal: controller.signal,
      stdio: { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    })

    const readinessController = new AbortController()
    const readinessSignal = AbortSignal.any([
      controller.signal,
      readinessController.signal,
    ])
    const first = await Promise.race<Ready | ExitBeforeReady>([
      waitForReadyHandshake(paths.readyPath, identity, {
        timeoutMs: 30_000,
        signal: readinessSignal,
      }).then(() => ({ kind: "ready" as const })),
      openCode.wait().then((result) => ({ kind: "exit" as const, result })),
    ]).finally(() => readinessController.abort())
    if (first.kind === "exit") {
      try {
        await waitForReadyHandshake(paths.readyPath, identity, {
          timeoutMs: 0,
          signal: controller.signal,
        })
      } catch (error) {
        if (!(error instanceof ReadyHandshakeTimeoutError)) throw error
        throw new Error(
          `OpenCode exited before the remote plugin became ready (${describeExit(first.result)})`
        )
      }
    }

    const active = await Promise.race<
      | { kind: "opencode"; result: ProcessResult }
      | { kind: "master"; result: ProcessResult }
    >([
      openCode.wait().then((result) => ({ kind: "opencode" as const, result })),
      master.wait().then((result) => ({ kind: "master" as const, result })),
    ])
    if (active.kind === "master" && !controller.signal.aborted) {
      throw new Error(
        `SSH ControlMaster exited while OpenCode was running (${describeExit(active.result)})`
      )
    }
    const result = active.kind === "opencode" ? active.result : await openCode.wait()
    if (receivedSignal === "SIGINT") return 130
    if (receivedSignal === "SIGTERM") return 143
    if (result.signal === "SIGINT") return 130
    if (result.signal === "SIGTERM") return 143
    return result.exitCode ?? 1
  } catch (error) {
    if (receivedSignal === "SIGINT") return 130
    if (receivedSignal === "SIGTERM") return 143
    throw error
  } finally {
    if (openCode) await openCode.terminate().catch(() => undefined)
    if (readyPath) await removeReadyFile(readyPath).catch(() => undefined)
    if (mirrorPath) await rm(mirrorPath, { recursive: true, force: true }).catch(() => undefined)
    if (master) await master.close().catch(() => undefined)
    if (socketPath) await rm(socketPath, { force: true }).catch(() => undefined)
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}

function describeExit(result: ProcessResult): string {
  if (result.signal) return `signal ${result.signal}`
  if (result.termination) return result.termination
  return `exit code ${result.exitCode ?? "unknown"}`
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`opencode-ssh: ${message}\n`)
    process.exitCode = 1
  }
}

async function isEntryPoint(): Promise<boolean> {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(await realpath(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
}

if (await isEntryPoint()) await main()
