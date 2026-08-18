import { setTimeout as delay } from "node:timers/promises"
import { spawnProcess } from "./process.js"

const PROBE_TIMEOUT_MS = 5_000
const PROBE_OUTPUT_BYTES = 4_096
const WARNING_DELAY_MS = 3_000
const PLAIN_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

export interface OpenCodeCompatibilityHooks {
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  writeWarning?: (message: string) => void
}

interface OpenCodeCompatibilityOptions extends OpenCodeCompatibilityHooks {
  binary: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  testedVersion: string
}

export async function warnIfOpenCodeIsUntested(
  options: OpenCodeCompatibilityOptions
): Promise<void> {
  let detectedVersion: string | undefined

  const result = await spawnProcess(options.binary, ["--version"], {
    env: options.env,
    signal: options.signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxStdoutBytes: PROBE_OUTPUT_BYTES,
    maxStderrBytes: PROBE_OUTPUT_BYTES,
    stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
  })
  throwIfAborted(options.signal)

  const stdout = result.stdout.trim()
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    result.termination === null &&
    !result.stdoutTruncated &&
    PLAIN_VERSION.test(stdout)
  ) {
    detectedVersion = stdout
  }

  if (detectedVersion === options.testedVersion) return

  const detail = detectedVersion
    ? `local OpenCode ${detectedVersion} differs from the tested version ${options.testedVersion}`
    : `the local OpenCode version could not be determined; the tested version is ${options.testedVersion}`
  const warning =
    `opencode-ssh: warning: ${detail}. ` +
    "Run the five manual TUI checks from the OpenCode SSH installation guide before relying on this version. " +
    "Continuing in 3 seconds; press Ctrl-C to cancel."
  const writeWarning =
    options.writeWarning ?? ((message: string) => process.stderr.write(`${message}\n`))
  writeWarning(warning)

  const wait =
    options.wait ??
    ((milliseconds: number, signal: AbortSignal) =>
      delay(milliseconds, undefined, { signal }))
  await wait(WARNING_DELAY_MS, options.signal)
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error("OpenCode launch aborted")
}
