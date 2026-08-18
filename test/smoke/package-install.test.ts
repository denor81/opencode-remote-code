import { constants as fsConstants } from "node:fs"
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type SpawnOptions } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const projectRoot = fileURLToPath(new URL("../../", import.meta.url))
const requiredPackageFiles = [
  "dist/cli.js",
  "dist/index.js",
  "docs/installation-and-usage.md",
  "docs/upstream-fit-checklist.md",
  "docs/upstream-fit-report.md",
  "LICENSE",
  "opencode-ssh-remote-use/opencode-ssh-safety.md",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "UPSTREAM.md",
]

interface PackResult {
  filename: string
  files: Array<{ path: string }>
  name: string
  version: string
}

interface CommandResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

describe("installed package", () => {
  it("packs a clean artifact and runs its CLI without starting SSH", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-ssh-package-"))

    try {
      const packDirectory = path.join(temporaryRoot, "pack")
      const installPrefix = path.join(temporaryRoot, "prefix")
      const isolatedHome = path.join(temporaryRoot, "home")
      const sshTrapDirectory = path.join(temporaryRoot, "ssh-traps")
      await Promise.all(
        [packDirectory, installPrefix, isolatedHome, sshTrapDirectory].map((directory) =>
          mkdir(directory, { recursive: true })
        )
      )

      await Promise.all(
        ["dist/index.js", "dist/cli.js"].map((file) => access(path.join(projectRoot, file)))
      )
      const sourceManifest = JSON.parse(
        await readFile(path.join(projectRoot, "package.json"), "utf8")
      ) as { description: string; name: string; version: string }
      const npmEnvironment = createNpmEnvironment(
        temporaryRoot,
        isolatedHome,
        installPrefix
      )

      const packCommand = await runNpm(
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
        { cwd: projectRoot, env: npmEnvironment },
        60_000
      )
      expectSuccess(packCommand)

      const packResults = JSON.parse(packCommand.stdout) as PackResult[]
      expect(packResults).toHaveLength(1)
      const [packed] = packResults
      expect(packed).toMatchObject({
        name: sourceManifest.name,
        version: sourceManifest.version,
      })

      const packageFiles = packed.files.map((file) => file.path.replaceAll("\\", "/"))
      expect(packageFiles).toEqual(expect.arrayContaining(requiredPackageFiles))
      expect(packageFiles.filter(isForbiddenPackageArtifact)).toEqual([])

      const tarballPath = path.join(packDirectory, packed.filename)
      expect((await stat(tarballPath)).isFile()).toBe(true)

      const installCommand = await runNpm(
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          "--no-save",
          "--omit=dev",
          "--prefix",
          installPrefix,
          tarballPath,
        ],
        { cwd: temporaryRoot, env: npmEnvironment },
        120_000
      )
      expectSuccess(installCommand)

      const installedPackage = path.join(
        installPrefix,
        "node_modules",
        sourceManifest.name
      )
      const installedManifest = JSON.parse(
        await readFile(path.join(installedPackage, "package.json"), "utf8")
      ) as { bin: Record<string, string>; description: string; version: string }
      expect(installedManifest.bin).toEqual({ "opencode-ssh": "dist/cli.js" })
      expect(installedManifest.description).toContain("tested against OpenCode 1.18.18")

      const safetyDocument = await readFile(
        path.join(
          installedPackage,
          "opencode-ssh-remote-use",
          "opencode-ssh-safety.md"
        ),
        "utf8"
      )
      const installationGuide = await readFile(
        path.join(installedPackage, "docs", "installation-and-usage.md"),
        "utf8"
      )
      expect(new Set(safetyDocument.match(/<[A-Z_]+>/gu) ?? [])).toEqual(
        new Set(["<ALLOWED_MUTATION_SCOPE>"])
      )
      expect(safetyDocument).not.toContain("<SSH_ALIAS>")
      expect(safetyDocument).not.toContain("<REMOTE_WORKDIR>")
      expect(installationGuide).toContain("## Manual TUI Checks")
      await expect(
        access(path.join(installedPackage, "opencode-ssh-remote-use", "AGENTS.md"))
      ).rejects.toMatchObject({ code: "ENOENT" })

      const cliDirectory = path.join(installPrefix, "node_modules", ".bin")
      const cliPath = path.join(cliDirectory, "opencode-ssh")
      const installedCli = path.join(installedPackage, "dist", "cli.js")
      await access(cliPath, fsConstants.X_OK)
      expect(await realpath(cliPath)).toBe(await realpath(installedCli))

      const sshAttemptLog = path.join(temporaryRoot, "ssh-attempts.log")
      const opencodeTrap = path.join(sshTrapDirectory, "opencode")
      const sshTrap = path.join(sshTrapDirectory, "ssh")
      const sftpTrap = path.join(sshTrapDirectory, "sftp")
      await Promise.all([
        writeSshTrap(opencodeTrap, sshAttemptLog),
        writeSshTrap(sshTrap, sshAttemptLog),
        writeSshTrap(sftpTrap, sshAttemptLog),
      ])

      const cliEnvironment = withoutLauncherEnvironment(npmEnvironment)
      cliEnvironment.PATH = [
        cliDirectory,
        sshTrapDirectory,
        npmEnvironment.PATH ?? "",
      ].join(path.delimiter)
      cliEnvironment.OPENCODE_SSH_SSH_BIN = sshTrap
      cliEnvironment.OPENCODE_SSH_SFTP_BIN = sftpTrap
      cliEnvironment.OPENCODE_SSH_OPENCODE_BIN = opencodeTrap

      const helpCommand = await runCommand(
        "opencode-ssh",
        ["--help"],
        { cwd: temporaryRoot, env: cliEnvironment },
        10_000
      )
      const versionCommand = await runCommand(
        "opencode-ssh",
        ["--version"],
        { cwd: temporaryRoot, env: cliEnvironment },
        10_000
      )

      expectSuccess(helpCommand)
      expectSuccess(versionCommand)
      await expect(access(sshAttemptLog)).rejects.toMatchObject({ code: "ENOENT" })
      expect(helpCommand.stderr).toBe("")
      expect(helpCommand.stdout).toContain(
        "Usage: opencode-ssh <ssh-alias> <absolute-remote-workdir>"
      )
      expect(versionCommand.stderr).toBe("")
      expect(versionCommand.stdout).toBe(`${installedManifest.version}\n`)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 180_000)
})

function createNpmEnvironment(
  temporaryRoot: string,
  isolatedHome: string,
  installPrefix: string
): NodeJS.ProcessEnv {
  const env = withoutLauncherEnvironment(process.env)
  const isolatedNpmSettings = new Set([
    "npm_config_audit",
    "npm_config_cache",
    "npm_config_color",
    "npm_config_fund",
    "npm_config_global",
    "npm_config_globalconfig",
    "npm_config_package_lock",
    "npm_config_prefix",
    "npm_config_update_notifier",
    "npm_config_userconfig",
  ])
  for (const name of Object.keys(env)) {
    if (isolatedNpmSettings.has(name.toLowerCase())) delete env[name]
  }

  return {
    ...env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_cache: path.join(temporaryRoot, "npm-cache"),
    npm_config_color: "false",
    npm_config_fund: "false",
    npm_config_global: "false",
    npm_config_globalconfig: path.join(temporaryRoot, "global.npmrc"),
    npm_config_package_lock: "false",
    npm_config_prefix: installPrefix,
    npm_config_update_notifier: "false",
    npm_config_userconfig: path.join(temporaryRoot, "user.npmrc"),
  }
}

function withoutLauncherEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const name of Object.keys(env)) {
    if (name.startsWith("OPENCODE_SSH")) delete env[name]
  }
  return env
}

function isForbiddenPackageArtifact(file: string): boolean {
  return [
    /^(?:src|test|launchers)(?:\/|$)/u,
    /(?:^|\/)AGENTS\.md$/u,
    /(?:^|\/)pic\.png$/u,
    /^docs\/superpowers(?:\/|$)/u,
    /(?:^|\/)\.env(?:\.[^/]*)?$/u,
    /(?:^|\/)(?:\.cache|\.opencode|audit|mirror|runtime|state)(?:\/|$)/u,
    /(?:^|\/)(?:manifest|ready)\.json$/u,
    /\.(?:key|log|pem|ppk|sock)$/iu,
  ].some((pattern) => pattern.test(file))
}

async function writeSshTrap(file: string, log: string): Promise<void> {
  const contents = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs")',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv) + "\\n")`,
    "process.exit(97)",
    "",
  ].join("\n")
  await writeFile(file, contents, { mode: 0o755 })
  await chmod(file, 0o755)
}

async function runNpm(
  args: string[],
  options: SpawnOptions,
  timeoutMs: number
): Promise<CommandResult> {
  const npmExecPath = process.env.npm_execpath
  return npmExecPath
    ? runCommand(process.execPath, [npmExecPath, ...args], options, timeoutMs)
    : runCommand("npm", args, options, timeoutMs)
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    let stdout = ""
    let timedOut = false

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    timer.unref()

    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms\n${stderr}`))
        return
      }
      resolve({ exitCode, signal, stderr, stdout })
    })
  })
}

function expectSuccess(result: CommandResult): void {
  expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0)
  expect(result.signal).toBeNull()
}
