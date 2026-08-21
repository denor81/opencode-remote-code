import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { PROBE_ENV, PROBE_PROTOCOL, type ProbeRecord } from "./opencode-probe.js"
import {
  ProcessError,
  spawnManaged,
  spawnProcess,
  type ProcessResult,
} from "./process.js"

const PROBE_TIMEOUT_MS = 5_000
const PROBE_OUTPUT_BYTES = 4_096
const LOADER_PROBE_TIMEOUT_MS = 30_000
const PLAIN_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

export interface OpenCodeCompatibilityHooks {
  writeProgress?: (message: string) => void
  writeWarning?: (message: string) => void
}

interface OpenCodePreflightOptions {
  binary: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  testedVersion: string
  pluginURL: URL
  writeProgress?: (message: string) => void
  writeWarning?: (message: string) => void
}

export async function runOpenCodeCompatibilityCheck(
  options: OpenCodePreflightOptions
): Promise<void> {
  const startedAt = Date.now()
  options.writeProgress?.("checking OpenCode compatibility...")

  let version: string | undefined
  try {
    version = await detectOpenCodeVersion(options.binary, options.env, options.signal)
  } catch (error) {
    if (
      error instanceof ProcessError &&
      error.result === undefined &&
      errnoIs(error.cause, "ENOENT")
    ) {
      throw new Error(
        `OpenCode is required. Install the tested version with: npm install --global opencode-ai@${options.testedVersion}`,
        { cause: error }
      )
    }
    throw error
  }
  if (!version) {
    throw compatibilityError("version could not be determined")
  }

  options.writeProgress?.(`testing OpenCode ${version} plugin loader...`)
  await runLoaderProbe(options)
  options.writeProgress?.(
    `compatibility passed (${((Date.now() - startedAt) / 1_000).toFixed(1)}s)`
  )

  if (version !== options.testedVersion) {
    options.writeWarning?.(
      `OpenCode ${version} passed the loader check but differs from the tested version ${options.testedVersion}; visual TUI checks remain required.`
    )
  }
}

async function detectOpenCodeVersion(
  binary: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<string | undefined> {
  const result = await spawnProcess(binary, ["--version"], {
    env,
    signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxStdoutBytes: PROBE_OUTPUT_BYTES,
    maxStderrBytes: PROBE_OUTPUT_BYTES,
    stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
  })
  throwIfAborted(signal)

  if (result.timedOut) {
    throw compatibilityError("version check timed out")
  }
  if (result.signal !== null) {
    throw compatibilityError(`version check exited on ${result.signal}`)
  }
  if (result.exitCode !== 0) {
    throw compatibilityError(`version check exited with code ${result.exitCode ?? "unknown"}`)
  }

  const stdout = result.stdout.trim()
  if (
    result.termination === null &&
    !result.stdoutTruncated &&
    PLAIN_VERSION.test(stdout)
  ) {
    return stdout
  }
  return undefined
}

async function runLoaderProbe(options: OpenCodePreflightOptions): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-ssh-probe-"))
  try {
    const probeConfigHome = path.resolve(
      options.env.XDG_CACHE_HOME ??
        path.join(options.env.HOME ?? os.homedir(), ".cache"),
      "opencode-ssh",
      "probe-config-home"
    )
    const probeConfig = path.join(probeConfigHome, "opencode")
    const directories = {
      home: path.join(root, "home"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      state: path.join(root, "state"),
      runtime: path.join(root, "runtime"),
      temporary: path.join(root, "tmp"),
      workspace: path.join(root, "workspace"),
    }
    await Promise.all(
      [...Object.values(directories), probeConfig].map((directory) =>
        mkdir(directory, { recursive: true, mode: 0o700 })
      )
    )

    const token = randomBytes(32).toString("hex")
    const resultPath = path.join(root, "result.json")
    const childEnv: NodeJS.ProcessEnv = {
      PATH: options.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: directories.home,
      PWD: directories.workspace,
      SHELL: options.env.SHELL ?? "/bin/sh",
      USER: options.env.USER ?? "opencode-ssh-probe",
      LOGNAME: options.env.LOGNAME ?? options.env.USER ?? "opencode-ssh-probe",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      TERM: "dumb",
      NO_COLOR: "1",
      CI: "1",
      TMPDIR: directories.temporary,
      XDG_CONFIG_HOME: probeConfigHome,
      XDG_DATA_HOME: directories.data,
      XDG_CACHE_HOME: directories.cache,
      XDG_STATE_HOME: directories.state,
      XDG_RUNTIME_DIR: directories.runtime,
      OPENCODE_CONFIG_DIR: probeConfig,
      OPENCODE_CONFIG_CONTENT: `${JSON.stringify({
        plugin: [[options.pluginURL.href, { compatibilityProbe: token }]],
      })}\n`,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_PRUNE: "1",
      OPENCODE_DISABLE_SHARE: "1",
      [PROBE_ENV.token]: token,
      [PROBE_ENV.resultPath]: resultPath,
    }
    copyNpmEnvironment(options.env, childEnv)

    const probeProcess = spawnManaged(options.binary, ["debug", "config"], {
      cwd: directories.workspace,
      env: childEnv,
      signal: options.signal,
      killGraceMs: 1_000,
      maxStdoutBytes: PROBE_OUTPUT_BYTES,
      maxStderrBytes: PROBE_OUTPUT_BYTES,
      stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
    })
    try {
      await waitForProbeRecord(resultPath, token, probeProcess.result, options.signal)
    } finally {
      const result = await probeProcess.terminate()
      if (
        result.termination === null &&
        (result.exitCode !== 0 || result.signal !== null)
      ) {
        throw loaderExitError(result)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function waitForProbeRecord(
  resultPath: string,
  token: string,
  processResult: Promise<ProcessResult>,
  signal: AbortSignal
): Promise<void> {
  const deadline = Date.now() + LOADER_PROBE_TIMEOUT_MS
  let exited: ProcessResult | undefined
  let processFailure: unknown
  void processResult.then(
    (result) => {
      exited = result
    },
    (error: unknown) => {
      processFailure = error
    }
  )

  while (true) {
    throwIfAborted(signal)
    try {
      const contents = await readFile(resultPath, "utf8")
      let record: unknown
      try {
        record = JSON.parse(contents) as unknown
      } catch {
        throw compatibilityError("plugin loader returned an invalid result")
      }
      if (!isProbeRecord(record, token)) {
        throw compatibilityError("plugin loader returned an invalid result")
      }
      return
    } catch (error) {
      if (!errnoIs(error, "ENOENT")) throw error
    }

    if (processFailure) throw processFailure
    if (exited) throw loaderExitError(exited)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw compatibilityError("plugin loader timed out")
    }
    await delay(Math.min(25, remaining), undefined, { signal })
  }
}

function loaderExitError(result: ProcessResult): Error {
  if (result.exitCode === 0 && result.signal === null) {
    return compatibilityError("plugin loader exited without returning a result")
  }
  const detail = result.signal
    ? `plugin loader exited on ${result.signal}`
    : `plugin loader exited with code ${result.exitCode ?? "unknown"}`
  return compatibilityError(detail)
}

function compatibilityError(detail: string): Error {
  return new Error(
    `OpenCode compatibility check failed: ${detail}; SSH connection was not started`
  )
}

function errnoIs(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function copyNpmEnvironment(
  source: NodeJS.ProcessEnv,
  target: NodeJS.ProcessEnv
): void {
  const transportNames = new Set([
    "BUN_CONFIG_REGISTRY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
  ])
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (/^npm_config_/iu.test(name) || transportNames.has(name.toUpperCase()))
    ) {
      target[name] = value
    }
  }
  if (!Object.keys(target).some((name) => name.toLowerCase() === "npm_config_userconfig")) {
    target.npm_config_userconfig = path.join(source.HOME ?? os.homedir(), ".npmrc")
  }
}

function isProbeRecord(value: unknown, token: string): value is ProbeRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 2 &&
    record.protocol === PROBE_PROTOCOL &&
    record.token === token
  )
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error("OpenCode launch aborted")
}
