import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  runCli,
  type LauncherRawStderrCaptureContext,
} from "../../src/cli.js"
import { REMOTE_ENV } from "../../src/config.js"
import { resolveDailyLogFilePath } from "../../src/logger.js"
import { spawnProcess } from "../../src/process.js"
import { RAW_STDERR_CAPTURE_MAX_BYTES } from "../../src/raw-stderr-capture.js"
import { computeTargetID } from "../../src/runtime-paths.js"
import { TASK_RESUME_PROTOCOL } from "../../src/task-resume-capability.js"
import { scrubFixtureEnvironment } from "../helpers/fixture-environment.js"

const fakeOpenCode = fileURLToPath(new URL("../fixtures/bin/opencode", import.meta.url))
const fakeOpenCodeDebug = fileURLToPath(
  new URL("../fixtures/bin/opencode-debug", import.meta.url)
)
const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const cliEntrypoint = fileURLToPath(new URL("../../dist/cli.js", import.meta.url))
const safetyInstructionsPath = fileURLToPath(
  new URL("../../opencode-ssh-remote-use/opencode-ssh-safety.md", import.meta.url)
)
const BASELINE_VERSION = "1.18.18"
const temporaryRoots: string[] = []

interface OpenCodeInvocation {
  argv: string[]
  cwd: string
  PWD?: string
  configContent?: string
  env: Record<string, string>
  readyNonceHash?: string
}

interface LauncherLogRecord {
  event: string
  fields?: Record<string, unknown>
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("launcher lifecycle", () => {
  it("scrubs hostile ambient fake controls from the launcher fixture", async () => {
    const hostile = {
      FAKE_OPENCODE_IGNORE_SIGTERM: "1",
      FAKE_OPENCODE_HOST_DESCENDANT_READY_MARKER: "/ambient/descendant-ready",
      FAKE_OPENCODE_HOST_STDERR_BASE64: "YW1iaWVudCBwcml2YXRlIGJ5dGVz",
      FAKE_OPENCODE_HOST_STDERR_TEXT: "ambient private host stderr",
      FAKE_SFTP_DELAY_MS: "60000",
      FAKE_SSH_COMMAND_DELAY_MS: "60000",
      FAKE_SSH_MASTER_STDERR: "ambient private diagnostic",
      FAKE_SSH_MASTER_STDERR_DELAY_MS: "60000",
      FAKE_SSH_NEVER_READY: "1",
      FAKE_SSH_RESPONSES: "not-json",
    }
    const saved = new Map(
      Object.keys(hostile).map((name) => [name, process.env[name]])
    )
    Object.assign(process.env, hostile)

    try {
      const fixture = await createFixture("/srv/hostile-ambient", {
        FAKE_OPENCODE_WRITE_READY: "1",
        FAKE_OPENCODE_EXIT_CODE: "0",
      })
      for (const name of Object.keys(hostile)) {
        expect(fixture.env[name]).toBeUndefined()
      }
      await expect(
        runCli(["hostile-ambient-host", "/srv/requested"], fixture.env)
      ).resolves.toBe(0)
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("launches OpenCode without forwarded args and cleans each launch-specific artifact", async () => {
    const alias = "deploy-host.example"
    const requestedWorkdir = "/srv/link workspace"
    const canonicalWorkdir = "/srv/canonical workspace"
    const existingConfig = {
      model: "provider/model",
      mcp: { search: { enabled: true } },
      instructions: ["keep normal instructions"],
      plugin: ["existing-plugin", ["file:///tmp/other-plugin.js", { enabled: true }]],
    }
    const secret = "must-not-appear-in-the-fake-opencode-log"
    const fixture = await createFixture(canonicalWorkdir, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(existingConfig),
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "30",
      FAKE_OPENCODE_EXIT_CODE: "23",
      [REMOTE_ENV.expectedOpenCodeRuntimeVersion]: "9.9.9",
      UNRELATED_PROVIDER_SECRET: secret,
    })

    await expect(runCli([alias, requestedWorkdir], fixture.env)).resolves.toBe(23)
    await expect(runCli([alias, requestedWorkdir], fixture.env)).resolves.toBe(23)

    const rawOpenCodeLog = await readFile(fixture.openCodeLog, "utf8")
    const invocations = parseJsonLines<OpenCodeInvocation>(rawOpenCodeLog)
    const expectedTargetID = computeTargetID(alias, canonicalWorkdir)
    const expectedWorkspace = path.join(
      fixture.stateHome,
      "opencode-ssh",
      expectedTargetID,
      "workspace"
    )

    expect(invocations).toHaveLength(2)
    expect(rawOpenCodeLog).not.toContain(secret)
    expect(invocations[0].env[REMOTE_ENV.launchID]).not.toBe(
      invocations[1].env[REMOTE_ENV.launchID]
    )
    expect(invocations[0].env[REMOTE_ENV.readyPath]).not.toBe(
      invocations[1].env[REMOTE_ENV.readyPath]
    )

    for (const invocation of invocations) {
      expect(invocation.argv).toEqual([])
      expect(invocation.cwd).toBe(expectedWorkspace)
      expect(invocation.PWD).toBe(expectedWorkspace)
      expect(invocation.readyNonceHash).toMatch(/^[a-f0-9]{64}$/)
      expect(invocation.env).toMatchObject({
        [REMOTE_ENV.alias]: alias,
        [REMOTE_ENV.workdir]: canonicalWorkdir,
        [REMOTE_ENV.targetID]: expectedTargetID,
        [REMOTE_ENV.sshBinary]: fakeSsh,
        [REMOTE_ENV.sftpBinary]: fakeSftp,
        [REMOTE_ENV.expectedOpenCodeRuntimeVersion]: BASELINE_VERSION,
        [REMOTE_ENV.taskResumeCapability]: TASK_RESUME_PROTOCOL,
        OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
      })
      expect(invocation.env).not.toHaveProperty("UNRELATED_PROVIDER_SECRET")

      const merged = JSON.parse(invocation.configContent ?? "") as typeof existingConfig
      expect(merged.model).toBe(existingConfig.model)
      expect(merged.mcp).toEqual(existingConfig.mcp)
      expect(merged.instructions).toEqual([
        ...existingConfig.instructions,
        safetyInstructionsPath,
      ])
      expect(merged.plugin.slice(0, existingConfig.plugin.length)).toEqual(
        existingConfig.plugin
      )
      expect(merged.plugin).toHaveLength(existingConfig.plugin.length + 1)
      const injected = merged.plugin.at(-1) as unknown as [
        string,
        {
          launchID: string
          expectedOpenCodeRuntimeVersion: string
          taskResumeCapability: string
        },
      ]
      expect(injected[0]).toMatch(/^file:.*\/$/)
      expect(injected[0]).not.toContain("/src/")
      expect(injected[1]).toEqual({
        launchID: invocation.env[REMOTE_ENV.launchID],
        expectedOpenCodeRuntimeVersion: BASELINE_VERSION,
        taskResumeCapability: TASK_RESUME_PROTOCOL,
      })

      const readyPath = invocation.env[REMOTE_ENV.readyPath]
      const socketPath = invocation.env[REMOTE_ENV.socket]
      const mirrorPath = invocation.env[REMOTE_ENV.mirrorRoot]
      expect(await pathExists(readyPath)).toBe(false)
      expect(await pathExists(socketPath)).toBe(false)
      expect(await pathExists(mirrorPath)).toBe(false)
      expect(await pathExists(`${socketPath}.fake-ssh-master`)).toBe(false)
    }

    const stateEntries = await readdir(path.dirname(invocations[0].env[REMOTE_ENV.readyPath]))
    expect(stateEntries.filter((entry) => entry.includes("plugin-ready"))).toEqual([])
    await expect
      .poll(() => readdir(invocations[0].env[REMOTE_ENV.runtimeDir]), {
        interval: 20,
        timeout: 2_000,
      })
      .toEqual([])

    const sshCalls = parseJsonLines<string[]>(await readFile(fixture.sshLog, "utf8"))
    for (const call of sshCalls) {
      const separator = call.indexOf("--")
      expect(separator).toBeGreaterThanOrEqual(0)
      expect(call[separator + 1]).toBe(alias)
    }
    expect(sshCalls.filter((call) => valueAfter(call, "-O") === "exit")).toHaveLength(2)
  })

  it("inherits production stdout while keeping raw host stderr off the inherited terminal channel", async () => {
    const stdoutMarker = "production-stdout-remains-inherited\n"
    const stderrMarker = "private-production-stderr-marker\n"
    const fixture = await createFixture("/srv/stdio-routing", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_HOST_STDOUT_TEXT: stdoutMarker,
      FAKE_OPENCODE_HOST_STDERR_TEXT: stderrMarker,
    })

    const result = await spawnProcess(
      process.execPath,
      [cliEntrypoint, "stdio-routing-host", "/srv/requested"],
      {
        env: fixture.env,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 256 * 1024,
        stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
      }
    )

    expect(result).toMatchObject({ exitCode: 0, signal: null })
    expect(result.stdout).toBe(stdoutMarker)
    expect(result.stderr).not.toContain(stderrMarker.trim())
    const operatorLine = result.stderr
      .split("\n")
      .find((line) => line.startsWith("opencode-ssh: raw OpenCode stderr saved to "))
    expect(operatorLine).toBeDefined()
    const operatorMatch = operatorLine?.match(
      /^opencode-ssh: raw OpenCode stderr saved to (.+) \(startupID ([a-f0-9]{32}); observed (\d+) bytes; captured (\d+) bytes; written (\d+) bytes; truncated (true|false)\)$/u
    )
    expect(operatorMatch).not.toBeNull()
    if (!operatorMatch) throw new Error("Missing raw stderr operator report")

    const rawPath = operatorMatch[1]
    const markerBytes = Buffer.byteLength(stderrMarker)
    expect(operatorMatch.slice(3)).toEqual([
      String(markerBytes),
      String(markerBytes),
      String(markerBytes),
      "false",
    ])
    expect(path.relative(fixture.stateHome, rawPath)).not.toMatch(/^\.\./u)
    expect(await readFile(rawPath, "utf8")).toBe(stderrMarker)

    const rawLog = await readFile(launcherLogPath(fixture), "utf8")
    const records = parseJsonLines<LauncherLogRecord>(rawLog)
    const captureRecord = records.find(
      (record) => record.event === "opencode.host.stderr.captured"
    )
    expect(captureRecord?.fields).toMatchObject({
      component: "launcher",
      startupID: operatorMatch[2],
      observedBytes: markerBytes,
      capturedBytes: markerBytes,
      writtenBytes: markerBytes,
      truncated: false,
    })
    expect(captureRecord?.fields).not.toHaveProperty("filePath")
    expect(rawLog).not.toContain(stderrMarker.trim())
    expect(rawLog).not.toContain(rawPath)
    expect(operatorLine).not.toContain(stderrMarker.trim())
  }, 15_000)

  it("retains exactly the bounded prefix and reports host stderr overflow safely", async () => {
    const observedBytes = RAW_STDERR_CAPTURE_MAX_BYTES + 8_192
    const fixture = await createFixture("/srv/stderr-overflow", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_HOST_STDERR_BYTES: String(observedBytes),
    })

    const result = await spawnProcess(
      process.execPath,
      [cliEntrypoint, "stderr-overflow-host", "/srv/requested"],
      {
        env: fixture.env,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 256 * 1024,
        stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
      }
    )

    expect(result).toMatchObject({ exitCode: 0, signal: null })
    const operatorLine = result.stderr
      .split("\n")
      .find((line) => line.startsWith("opencode-ssh: raw OpenCode stderr saved to "))
    const operatorMatch = operatorLine?.match(
      /^opencode-ssh: raw OpenCode stderr saved to (.+) \(startupID ([a-f0-9]{32}); observed (\d+) bytes; captured (\d+) bytes; written (\d+) bytes; truncated (true|false)\)$/u
    )
    expect(operatorMatch?.slice(3)).toEqual([
      String(observedBytes),
      String(RAW_STDERR_CAPTURE_MAX_BYTES),
      String(RAW_STDERR_CAPTURE_MAX_BYTES),
      "true",
    ])
    if (!operatorMatch) throw new Error("Missing overflow raw stderr report")

    const rawPath = operatorMatch[1]
    const rawBytes = await readFile(rawPath)
    expect(rawBytes.byteLength).toBe(RAW_STDERR_CAPTURE_MAX_BYTES)
    expect(rawBytes.equals(Buffer.alloc(RAW_STDERR_CAPTURE_MAX_BYTES, "x"))).toBe(true)
    expect(result.stderr).not.toContain("xxxxxxxxxxxxxxxx")

    const rawLog = await readFile(launcherLogPath(fixture), "utf8")
    const records = parseJsonLines<LauncherLogRecord>(rawLog)
    const captureRecord = records.find(
      (record) => record.event === "opencode.host.stderr.captured"
    )
    expect(captureRecord?.fields).toMatchObject({
      startupID: operatorMatch[2],
      observedBytes,
      capturedBytes: RAW_STDERR_CAPTURE_MAX_BYTES,
      writtenBytes: RAW_STDERR_CAPTURE_MAX_BYTES,
      truncated: true,
      storageStatus: "complete",
      retentionStatus: "completed",
    })
    expect(captureRecord?.fields).not.toHaveProperty("filePath")
    expect(rawLog).not.toContain(rawPath)
    expect(Buffer.byteLength(rawLog)).toBeLessThan(64 * 1024)
  }, 15_000)

  it("persists non-empty host stderr only after the host exits and cleanup settles", async () => {
    const stderrMarker = "deferred-raw-stderr-marker\n"
    const fixture = await createFixture("/srv/deferred-stderr", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_HOST_STDERR_TEXT: stderrMarker,
      FAKE_OPENCODE_DELAY_MS: "1000",
      FAKE_OPENCODE_ACTIVE_MARKER: "pending",
      FAKE_OPENCODE_EXIT_MARKER: "pending",
    })
    const fixtureRoot = path.dirname(fixture.openCodeLog)
    const activeMarker = path.join(fixtureRoot, "stderr-host-active")
    const exitMarker = path.join(fixtureRoot, "stderr-host-exited")
    fixture.env.FAKE_OPENCODE_ACTIVE_MARKER = activeMarker
    fixture.env.FAKE_OPENCODE_EXIT_MARKER = exitMarker
    const summaries: LauncherRawStderrCaptureContext[] = []
    let hostHadExitedAtHook = false
    let artifactPaths: string[] = []
    let artifactsCleanedAtHook: boolean[] = []

    const launch = runCli(
      ["deferred-stderr-host", "/srv/requested"],
      fixture.env,
      {
        onRawStderrCaptureFinalized: (summary) => {
          hostHadExitedAtHook = existsSync(exitMarker)
          artifactsCleanedAtHook = artifactPaths.map(
            (artifactPath) => !existsSync(artifactPath)
          )
          summaries.push(summary)
          throw new Error("operator reporting failed")
        },
      }
    )
    await expect.poll(() => pathExists(activeMarker), {
      interval: 10,
      timeout: 3_000,
    }).toBe(true)
    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    expect(existsSync(exitMarker)).toBe(false)
    const readyPath = invocation.env[REMOTE_ENV.readyPath]
    const mirrorPath = invocation.env[REMOTE_ENV.mirrorRoot]
    const socketPath = invocation.env[REMOTE_ENV.socket]
    const fakeMasterPath = `${socketPath}.fake-ssh-master`
    expect([readyPath, mirrorPath, fakeMasterPath].map(existsSync)).toEqual([
      true,
      true,
      true,
    ])
    await writeFile(socketPath, "fake control socket artifact", { mode: 0o600 })
    expect(existsSync(socketPath)).toBe(true)
    artifactPaths = [readyPath, mirrorPath, socketPath, fakeMasterPath]
    const filesWhileActive = await listRegularFiles(fixture.stateHome)
    expect(summaries).toEqual([])

    await expect(launch).resolves.toBe(0)
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]
    expect(summary?.filePath).toEqual(expect.any(String))
    if (!summary?.filePath) throw new Error("Missing finalized raw stderr path")
    expect(hostHadExitedAtHook).toBe(true)
    expect(artifactsCleanedAtHook).toEqual([true, true, true, true])
    expect(filesWhileActive).not.toContain(summary.filePath)
    expect(await readFile(summary.filePath, "utf8")).toBe(stderrMarker)
  }, 10_000)

  it("creates no raw file or capture event for empty production stderr", async () => {
    const fixture = await createFixture("/srv/empty-stderr", {
      FAKE_OPENCODE_WRITE_READY: "1",
    })
    const summaries: LauncherRawStderrCaptureContext[] = []

    await expect(
      runCli(["empty-stderr-host", "/srv/requested"], fixture.env, {
        onRawStderrCaptureFinalized: (summary) => summaries.push(summary),
      })
    ).resolves.toBe(0)

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      observedBytes: 0,
      capturedBytes: 0,
      writtenBytes: 0,
      truncated: false,
    })
    expect(summaries[0]).not.toHaveProperty("filePath")
    expect(await listRegularFiles(rawStderrDirectory(fixture))).toEqual([])
    const records = parseJsonLines<LauncherLogRecord>(
      await readFile(launcherLogPath(fixture), "utf8")
    )
    expect(
      records.filter((record) => record.event.startsWith("opencode.host.stderr."))
    ).toEqual([])
  })

  it("preserves a nonzero exit and prints only a safe warning when raw storage fails", async () => {
    const stderrMarker = "storage-failure-private-stderr\n"
    const fixture = await createFixture("/srv/raw-storage-failure", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_HOST_STDERR_TEXT: stderrMarker,
      FAKE_OPENCODE_EXIT_CODE: "37",
    })
    const rawDirectory = rawStderrDirectory(fixture)
    await mkdir(path.dirname(rawDirectory), { recursive: true })
    await writeFile(rawDirectory, "blocks raw directory creation", { mode: 0o600 })

    const result = await spawnProcess(
      process.execPath,
      [cliEntrypoint, "raw-storage-failure-host", "/srv/requested"],
      {
        env: fixture.env,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 256 * 1024,
        stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
      }
    )

    expect(result).toMatchObject({ exitCode: 37, signal: null })
    expect(result.stderr).toContain(
      "warning: raw OpenCode stderr was observed but could not be saved"
    )
    expect(result.stderr).toContain("raw stderr retention maintenance failed")
    expect(result.stderr).toMatch(/startupID [a-f0-9]{32}; diagnostics:/u)
    expect(
      result.stderr.split("\n").filter((line) => line.startsWith("opencode-ssh: warning:"))
    ).toHaveLength(1)
    expect(result.stderr).not.toContain(stderrMarker.trim())
    expect(result.stderr).not.toContain("EEXIST")

    const rawLog = await readFile(launcherLogPath(fixture), "utf8")
    const records = parseJsonLines<LauncherLogRecord>(rawLog)
    const failureRecord = records.find(
      (record) => record.event === "opencode.host.stderr.capture_failed"
    )
    const retentionRecord = records.find(
      (record) => record.event === "opencode.host.stderr.retention_failed"
    )
    expect(failureRecord?.fields).toMatchObject({
      component: "launcher",
      observedBytes: Buffer.byteLength(stderrMarker),
      capturedBytes: Buffer.byteLength(stderrMarker),
      writtenBytes: 0,
      truncated: false,
    })
    expect(retentionRecord?.fields).toMatchObject({
      component: "launcher",
      retentionStatus: "failed",
    })
    expect(failureRecord?.fields).not.toHaveProperty("filePath")
    expect(rawLog).not.toContain(stderrMarker.trim())
    expect(rawLog).not.toContain(rawDirectory)
  }, 15_000)

  it("reports retention failure even when production stderr is empty", async () => {
    const fixture = await createFixture("/srv/empty-retention-failure", {
      FAKE_OPENCODE_WRITE_READY: "1",
    })
    const rawDirectory = rawStderrDirectory(fixture)
    await mkdir(path.dirname(rawDirectory), { recursive: true })
    await writeFile(rawDirectory, "blocks raw retention maintenance", {
      mode: 0o600,
    })

    const result = await spawnProcess(
      process.execPath,
      [cliEntrypoint, "empty-retention-failure-host", "/srv/requested"],
      {
        env: fixture.env,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 256 * 1024,
        stdio: { stdin: "ignore", stdout: "capture", stderr: "capture" },
      }
    )

    expect(result).toMatchObject({ exitCode: 0, signal: null })
    expect(result.stderr).toContain("warning: raw stderr retention maintenance failed")
    expect(result.stderr).toMatch(/startupID [a-f0-9]{32}; diagnostics:/u)
    expect(result.stderr).not.toContain("raw OpenCode stderr saved to")
    expect(result.stderr).not.toContain("partial raw OpenCode stderr retained at")
    const records = parseJsonLines<LauncherLogRecord>(
      await readFile(launcherLogPath(fixture), "utf8")
    )
    expect(
      records.filter(
        (record) => record.event === "opencode.host.stderr.retention_failed"
      )
    ).toHaveLength(1)
    expect(
      records.filter((record) => record.event === "opencode.host.stderr.capture_failed")
    ).toEqual([])
  }, 15_000)

  it("settles when a production descendant inherits and holds captured stderr", async () => {
    const descendantMarker = "inherited-descendant-stderr\n"
    const fixture = await createFixture("/srv/descendant-stderr", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_HOST_DESCENDANT_STDERR_TEXT: descendantMarker,
      FAKE_OPENCODE_HOST_DESCENDANT_STDERR_HOLD_MS: "60000",
    })
    const descendantReadyMarker = path.join(
      path.dirname(fixture.openCodeLog),
      "descendant-stderr-ready"
    )
    fixture.env.FAKE_OPENCODE_HOST_DESCENDANT_READY_MARKER = descendantReadyMarker
    const summaries: LauncherRawStderrCaptureContext[] = []

    await expect(
      runCli(["descendant-stderr-host", "/srv/requested"], fixture.env, {
        onRawStderrCaptureFinalized: (summary) => summaries.push(summary),
      })
    ).resolves.toBe(0)

    expect(await readFile(descendantReadyMarker, "utf8")).toMatch(/^\d+\n$/u)
    const rawPath = summaries[0]?.filePath
    expect(rawPath).toEqual(expect.any(String))
    if (!rawPath) throw new Error("Missing descendant raw stderr path")
    expect((await readFile(rawPath, "utf8")).startsWith(descendantMarker)).toBe(true)
  }, 10_000)

  it("fails closed quickly when OpenCode exits without becoming ready", async () => {
    const alias = "unready-host"
    const fixture = await createFixture("/srv/unready", {
      FAKE_OPENCODE_DELAY_MS: "20",
      FAKE_OPENCODE_EXIT_CODE: "29",
    })
    const startedAt = Date.now()

    const error = await runCli([alias, "/srv/requested"], fixture.env).catch(
      (value: unknown) => value
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(
      /OpenCode exited before the remote plugin became ready \(exit code 29\)/
    )
    expect(Date.now() - startedAt).toBeLessThan(5_000)

    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    const readyPath = invocation.env[REMOTE_ENV.readyPath]
    const socketPath = invocation.env[REMOTE_ENV.socket]
    expect(await pathExists(readyPath)).toBe(false)
    expect(await pathExists(socketPath)).toBe(false)
    expect(await pathExists(`${socketPath}.fake-ssh-master`)).toBe(false)

    const sshCalls = parseJsonLines<string[]>(await readFile(fixture.sshLog, "utf8"))
    expect(sshCalls.filter((call) => valueAfter(call, "-O") === "exit")).toEqual([
      ["-S", socketPath, "-O", "exit", "--", alias],
    ])
  }, 10_000)

  it("preserves the startup error, reports cleanup failure, and continues cleanup", async () => {
    const alias = "cleanup-failure-host"
    const fixture = await createFixture("/srv/cleanup-failure", {
      FAKE_OPENCODE_DELAY_MS: "20",
      FAKE_OPENCODE_EXIT_CODE: "29",
      FAKE_SSH_CONTROL_EXIT_CODE: "7",
    })
    const sigintListeners = process.listenerCount("SIGINT")
    const sigtermListeners = process.listenerCount("SIGTERM")

    const error = await runCli([alias, "/srv/requested"], fixture.env).catch(
      (value: unknown) => value
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as Error).message).toMatch(
      /OpenCode exited before the remote plugin became ready \(exit code 29\).*cleanup also failed.*master/i
    )
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringMatching(/OpenCode exited before.*exit code 29/i),
    })
    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    expect(await pathExists(invocation.env[REMOTE_ENV.readyPath])).toBe(false)
    expect(await pathExists(invocation.env[REMOTE_ENV.mirrorRoot])).toBe(false)
    expect(await pathExists(invocation.env[REMOTE_ENV.socket])).toBe(false)
    expect(await pathExists(`${invocation.env[REMOTE_ENV.socket]}.fake-ssh-master`)).toBe(
      false
    )
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners)
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners)
  }, 15_000)

  it("does not return a successful launch result when cleanup is known to fail", async () => {
    const fixture = await createFixture("/srv/cleanup-only-failure", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "20",
      FAKE_OPENCODE_EXIT_CODE: "0",
      FAKE_SSH_CONTROL_EXIT_CODE: "7",
    })

    const error = await runCli(
      ["cleanup-only-failure-host", "/srv/requested"],
      fixture.env
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as Error).message).toMatch(/OpenCode SSH cleanup failed.*master/i)
  }, 15_000)

  it("preserves SIGTERM exit semantics and warns when cleanup is incomplete", async () => {
    const stderrMarker = "sigterm-cleanup-private-stderr\n"
    const fixture = await createFixture("/srv/signal-cleanup-failure", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_HOST_STDERR_TEXT: stderrMarker,
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_OPENCODE_ACTIVE_MARKER: "pending",
    })
    const activeMarker = path.join(path.dirname(fixture.openCodeLog), "signal-active")
    fixture.env.FAKE_OPENCODE_ACTIVE_MARKER = activeMarker
    const previousListeners = new Set(process.listeners("SIGTERM"))
    const warnings: string[] = []
    const summaries: LauncherRawStderrCaptureContext[] = []
    const launch = runCli(
      ["signal-cleanup-failure-host", "/srv/requested"],
      fixture.env,
      {
        onRawStderrCaptureFinalized: (summary) => summaries.push(summary),
        writeWarning: (message) => warnings.push(message),
      }
    )
    await expect.poll(() => pathExists(activeMarker), {
      interval: 10,
      timeout: 3_000,
    }).toBe(true)
    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    const readyPath = invocation.env[REMOTE_ENV.readyPath]
    await rm(readyPath, { force: true })
    await mkdir(readyPath)
    const signalListener = process
      .listeners("SIGTERM")
      .find((listener) => !previousListeners.has(listener))
    expect(signalListener).toEqual(expect.any(Function))

    signalListener!("SIGTERM")

    await expect(launch).resolves.toBe(143)
    expect(warnings).toEqual([
      expect.stringMatching(/cleanup after SIGTERM was incomplete.*ready-marker/i),
    ])
    const rawPath = summaries[0]?.filePath
    expect(rawPath).toEqual(expect.any(String))
    if (!rawPath) throw new Error("Missing SIGTERM raw stderr path")
    expect(await readFile(rawPath, "utf8")).toBe(stderrMarker)
  }, 10_000)

  it.skipIf(process.platform === "win32")(
    "discards raw stderr when managed host settlement is unconfirmed",
    async () => {
      const stderrMarker = "unconfirmed-settlement-private-stderr\n"
      const fixture = await createFixture("/srv/unconfirmed-settlement", {
        FAKE_OPENCODE_WRITE_READY: "1",
        FAKE_OPENCODE_HOST_STDERR_TEXT: stderrMarker,
        FAKE_OPENCODE_DELAY_MS: "2000",
        FAKE_OPENCODE_ACTIVE_MARKER: "pending",
        FAKE_OPENCODE_START_MARKER: "pending",
      })
      const fixtureRoot = path.dirname(fixture.openCodeLog)
      const activeMarker = path.join(fixtureRoot, "unconfirmed-active")
      const startMarker = path.join(fixtureRoot, "unconfirmed-started")
      fixture.env.FAKE_OPENCODE_ACTIVE_MARKER = activeMarker
      fixture.env.FAKE_OPENCODE_START_MARKER = startMarker
      const previousListeners = new Set(process.listeners("SIGTERM"))
      const warnings: string[] = []
      const summaries: LauncherRawStderrCaptureContext[] = []
      const launch = runCli(
        ["unconfirmed-settlement-host", "/srv/requested"],
        fixture.env,
        {
          onRawStderrCaptureFinalized: (summary) => summaries.push(summary),
          writeWarning: (message) => warnings.push(message),
        }
      )
      await expect.poll(() => pathExists(activeMarker), {
        interval: 10,
        timeout: 3_000,
      }).toBe(true)
      const hostPid = Number((await readFile(startMarker, "utf8")).trim())
      expect(hostPid).toBeGreaterThan(0)
      const signalFailure = Object.assign(new Error("injected signal failure"), {
        code: "EPERM",
      })
      const originalKill = process.kill.bind(process)
      let injected = false
      const kill = vi.spyOn(process, "kill").mockImplementation(
        ((pid: number, signal?: NodeJS.Signals | number) => {
          if (!injected && pid === -hostPid && signal === "SIGTERM") {
            injected = true
            originalKill(pid, signal)
            throw signalFailure
          }
          return originalKill(pid, signal)
        }) as typeof process.kill
      )
      const signalListener = process
        .listeners("SIGTERM")
        .find((listener) => !previousListeners.has(listener))
      expect(signalListener).toEqual(expect.any(Function))

      let exitCode: number
      try {
        signalListener!("SIGTERM")
        exitCode = await launch
      } finally {
        kill.mockRestore()
      }

      expect(exitCode).toBe(143)
      expect(warnings).toEqual([
        expect.stringMatching(/cleanup after SIGTERM was incomplete.*opencode/i),
      ])
      expect(summaries).toEqual([
        expect.objectContaining({
          observedBytes: Buffer.byteLength(stderrMarker),
          capturedBytes: Buffer.byteLength(stderrMarker),
          writtenBytes: 0,
          storageStatus: "capture-failed",
          retentionStatus: "not-attempted",
          settlementConfirmed: false,
        }),
      ])
      expect(summaries[0]).not.toHaveProperty("filePath")
      expect(await listRegularFiles(rawStderrDirectory(fixture))).toEqual([])
    }
  )

  it("preserves SIGINT exit semantics and settled host stderr", async () => {
    const stderrMarker = "sigint-private-stderr\n"
    const fixture = await createFixture("/srv/sigint-stderr", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_HOST_STDERR_TEXT: stderrMarker,
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_OPENCODE_ACTIVE_MARKER: "pending",
    })
    const activeMarker = path.join(path.dirname(fixture.openCodeLog), "sigint-active")
    fixture.env.FAKE_OPENCODE_ACTIVE_MARKER = activeMarker
    const previousListeners = new Set(process.listeners("SIGINT"))
    const summaries: LauncherRawStderrCaptureContext[] = []
    const launch = runCli(["sigint-stderr-host", "/srv/requested"], fixture.env, {
      onRawStderrCaptureFinalized: (summary) => summaries.push(summary),
    })
    await expect.poll(() => pathExists(activeMarker), {
      interval: 10,
      timeout: 3_000,
    }).toBe(true)
    const signalListener = process
      .listeners("SIGINT")
      .find((listener) => !previousListeners.has(listener))
    expect(signalListener).toEqual(expect.any(Function))

    signalListener!("SIGINT")

    await expect(launch).resolves.toBe(130)
    const rawPath = summaries[0]?.filePath
    expect(rawPath).toEqual(expect.any(String))
    if (!rawPath) throw new Error("Missing SIGINT raw stderr path")
    expect(await readFile(rawPath, "utf8")).toBe(stderrMarker)
  }, 10_000)

  it("preserves binary stderr and a nonzero immediate exit after readiness", async () => {
    const stderrBytes = Buffer.from([
      0xff,
      0xfe,
      0x00,
      0x1b,
      0x5b,
      0x33,
      0x31,
      0x6d,
      0x0a,
    ])
    const fixture = await createFixture("/srv/immediate-ready", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_HOST_STDERR_BASE64: stderrBytes.toString("base64"),
      FAKE_OPENCODE_EXIT_CODE: "23",
    })
    const summaries: LauncherRawStderrCaptureContext[] = []

    await expect(
      runCli(["immediate-ready-host", "/srv/requested"], fixture.env, {
        onRawStderrCaptureFinalized: (summary) => summaries.push(summary),
      })
    ).resolves.toBe(23)
    const summary = summaries[0]
    expect(summary).toMatchObject({
      observedBytes: stderrBytes.byteLength,
      capturedBytes: stderrBytes.byteLength,
      writtenBytes: stderrBytes.byteLength,
      truncated: false,
      storageStatus: "complete",
    })
    expect(summary?.filePath).toEqual(expect.any(String))
    if (!summary?.filePath) throw new Error("Missing binary raw stderr path")
    expect(await readFile(summary.filePath)).toEqual(stderrBytes)
  })

  it("terminates OpenCode promptly and reports a pre-ready ControlMaster exit", async () => {
    const fixture = await createFixture("/srv/master-before-ready", {
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_SSH_MASTER_EXIT_CODE: "41",
      FAKE_OPENCODE_START_MARKER: "pending",
      FAKE_SSH_MASTER_EXIT_MARKER: "pending",
    })
    const markerPath = path.join(path.dirname(fixture.openCodeLog), "opencode-started")
    fixture.env.FAKE_OPENCODE_START_MARKER = markerPath
    fixture.env.FAKE_SSH_MASTER_EXIT_MARKER = markerPath
    const startedAt = Date.now()

    const error = await runCli(
      ["pre-ready-master-host", "/srv/requested"],
      fixture.env
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(
      /SSH ControlMaster exited before the remote plugin became ready \(exit code 41\)/
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  }, 10_000)

  it("reports a master that dies after readiness while OpenCode remains active", async () => {
    const fixture = await createFixture("/srv/master-after-ready", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_SSH_MASTER_EXIT_CODE: "42",
      FAKE_OPENCODE_ACTIVE_MARKER: "pending",
      FAKE_OPENCODE_ACTIVE_MARKER_DELAY_MS: "200",
      FAKE_SSH_MASTER_EXIT_MARKER: "pending",
    })
    const markerPath = path.join(path.dirname(fixture.openCodeLog), "opencode-active")
    fixture.env.FAKE_OPENCODE_ACTIVE_MARKER = markerPath
    fixture.env.FAKE_SSH_MASTER_EXIT_MARKER = markerPath

    await expect(
      runCli(["active-master-host", "/srv/requested"], fixture.env)
    ).rejects.toThrow(
      /SSH ControlMaster exited while OpenCode was running \(exit code 42\)/
    )
  }, 10_000)

  it("keeps ControlMaster diagnostics out of raw host stderr", async () => {
    const alias = "private-diagnostic-host"
    const canonicalWorkdir = "/srv/private-diagnostic-workdir"
    const privateDetail = "private.example /secret/path"
    const hostStderrMarker = "distinct-host-stderr-marker\n"
    const diagnosticLines = Array.from(
      { length: 66 },
      (_, index) =>
        `channel ${index + 1}: open failed: connect failed: ${privateDetail}-${index}\n`
    ).join("")
    const fixture = await createFixture(canonicalWorkdir, {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "1000",
      FAKE_OPENCODE_EXIT_CODE: "0",
      FAKE_OPENCODE_HOST_STDERR_TEXT: hostStderrMarker,
      FAKE_SSH_MASTER_STDERR: diagnosticLines,
      FAKE_SSH_MASTER_STDERR_DELAY_MS: "600",
    })
    const summaries: LauncherRawStderrCaptureContext[] = []

    await expect(
      runCli([alias, "/srv/requested"], fixture.env, {
        onRawStderrCaptureFinalized: (summary) => summaries.push(summary),
      })
    ).resolves.toBe(0)

    const rawPath = summaries[0]?.filePath
    expect(rawPath).toEqual(expect.any(String))
    if (!rawPath) throw new Error("Missing diagnostic-routing raw stderr path")
    const rawHostStderr = await readFile(rawPath, "utf8")
    expect(rawHostStderr).toBe(hostStderrMarker)
    expect(rawHostStderr).not.toContain(privateDetail)
    expect(rawHostStderr).not.toContain("channel 1")

    const logPath = resolveDailyLogFilePath({
      logDirectory: path.join(fixture.stateHome, "opencode-ssh", "logs"),
    })
    const rawLog = await readFile(logPath, "utf8")
    const records = parseJsonLines<LauncherLogRecord>(rawLog)
    const diagnostics = records.filter(
      (record) => record.event === "ssh.master.channel_open.failed"
    )
    expect(diagnostics).toHaveLength(64)
    expect(
      diagnostics.every((diagnostic) =>
        Object.entries({
          component: "launcher",
          targetID: computeTargetID(alias, canonicalWorkdir),
          reason: "connect-failed",
          phase: "active",
        }).every(([key, value]) => diagnostic.fields?.[key] === value)
      )
    ).toBe(true)
    expect(
      records.filter((record) => record.event === "ssh.master.diagnostics_limited")
    ).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          reason: "event-limit",
          phase: "active",
        }),
      }),
    ])
    expect(rawLog).not.toContain(privateDetail)
    expect(rawLog).not.toContain("channel 1")
    expect(rawLog).not.toContain(hostStderrMarker.trim())
    expect(rawLog).not.toContain(rawPath)
    expect(rawLog).not.toContain(alias)
    expect(rawLog).not.toContain(canonicalWorkdir)
  }, 10_000)

  it("does not activate when readiness and master death are nearly simultaneous", async () => {
    const fixture = await createFixture("/srv/master-ready-race", {
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "2000",
      FAKE_OPENCODE_READY_MARKER: "pending",
      FAKE_SSH_MASTER_EXIT_CODE: "43",
      FAKE_SSH_MASTER_EXIT_MARKER: "pending",
    })
    const markerPath = path.join(path.dirname(fixture.openCodeLog), "ready-master-race")
    fixture.env.FAKE_OPENCODE_READY_MARKER = markerPath
    fixture.env.FAKE_SSH_MASTER_EXIT_MARKER = markerPath

    await expect(
      runCli(["ready-master-race-host", "/srv/requested"], fixture.env)
    ).rejects.toThrow(
      /SSH ControlMaster exited before the remote plugin became ready \(exit code 43\)/
    )
  }, 10_000)

  it("warns after a successful compatibility check for another version", async () => {
    const alias = "future-version-host"
    const fixture = await createFixture("/srv/future-version", {
      FAKE_OPENCODE_VERSION_STDOUT: "9.8.7\n",
      npm_config_opencode_ssh_probe_runtime_version: "9.8.7",
      [REMOTE_ENV.expectedOpenCodeRuntimeVersion]: "1.18.18",
      [REMOTE_ENV.taskResumeCapability]: TASK_RESUME_PROTOCOL,
      FAKE_OPENCODE_WRITE_READY: "1",
      FAKE_OPENCODE_DELAY_MS: "30",
      FAKE_OPENCODE_EXIT_CODE: "17",
    })
    const warnings: string[] = []
    const progress: string[] = []

    await expect(
      runCli([alias, "/srv/requested"], fixture.env, {
        writeWarning: (message) => warnings.push(message),
        writeProgress: (message) => progress.push(message),
      })
    ).resolves.toBe(17)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("OpenCode 9.8.7 passed the loader check")
    expect(warnings[0]).not.toContain("Task resume is unavailable")
    expect(progress).toEqual([
      "checking OpenCode compatibility...",
      "testing OpenCode 9.8.7 plugin loader...",
      expect.stringMatching(/^compatibility passed/u),
      "starting SSH session...",
    ])
    const [invocation] = parseJsonLines<OpenCodeInvocation>(
      await readFile(fixture.openCodeLog, "utf8")
    )
    expect(invocation.env[REMOTE_ENV.taskResumeCapability]).toBe(
      TASK_RESUME_PROTOCOL
    )
    expect(
      invocation.env[REMOTE_ENV.expectedOpenCodeRuntimeVersion]
    ).toBe("9.8.7")
    const config = JSON.parse(invocation.configContent ?? "") as {
      plugin: Array<[string, Record<string, unknown>]>
    }
    expect(config.plugin.at(-1)?.[1]).toMatchObject({
      expectedOpenCodeRuntimeVersion: "9.8.7",
      taskResumeCapability: TASK_RESUME_PROTOCOL,
    })
  }, 10_000)

  it("runs the installed-style self-test without starting SSH", async () => {
    const fixture = await createFixture("/srv/unused")
    const progress: string[] = []
    const summaries: LauncherRawStderrCaptureContext[] = []

    await expect(
      runCli(["self-test"], fixture.env, {
        onRawStderrCaptureFinalized: (summary) => summaries.push(summary),
        writeProgress: (message) => progress.push(message),
      })
    ).resolves.toBe(0)

    expect(progress.at(-1)).toBe(
      "self-test passed (OpenCode 1.18.18; Task resume enabled)"
    )
    expect(summaries).toEqual([])
    expect(await listRegularFiles(rawStderrDirectory(fixture))).toEqual([])
    expect(await pathExists(fixture.sshLog)).toBe(false)
    expect(await pathExists(fixture.openCodeLog)).toBe(false)
  })

  it("reports enabled resume for another compatible self-test binary", async () => {
    const fixture = await createFixture("/srv/unused", {
      FAKE_OPENCODE_VERSION_STDOUT: "1.18.19\n",
      npm_config_opencode_ssh_probe_runtime_version: "1.18.19",
    })
    const progress: string[] = []

    await expect(
      runCli(["self-test"], fixture.env, {
        writeProgress: (message) => progress.push(message),
      })
    ).resolves.toBe(0)

    expect(progress.at(-1)).toBe(
      "self-test passed (OpenCode 1.18.19; Task resume enabled)"
    )
    expect(await pathExists(fixture.sshLog)).toBe(false)
  })

  it("blocks before SSH when the loader probe fails", async () => {
    const fixture = await createFixture("/srv/unused")
    fixture.env.OPENCODE_SSH_OPENCODE_BIN = fakeOpenCodeDebug
    fixture.env.FAKE_OPENCODE_REAL_BIN = fakeOpenCode
    fixture.env.PATH = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(
      path.delimiter
    )

    await expect(runCli(["incompatible-host", "/srv/requested"], fixture.env)).rejects.toThrow(
      /plugin loader exited/u
    )
    expect(await pathExists(fixture.sshLog)).toBe(false)
  })

  it("fails before starting SSH when OpenCode is unavailable", async () => {
    const fixture = await createFixture("/srv/missing-opencode")
    fixture.env.OPENCODE_SSH_OPENCODE_BIN = path.join(
      path.dirname(fixture.openCodeLog),
      "missing-opencode"
    )

    await expect(runCli(["missing-opencode-host", "/srv/requested"], fixture.env)).rejects.toThrow(
      /OpenCode is required.*npm install --global opencode-ai@1\.18\.18/u
    )
    expect(await pathExists(fixture.sshLog)).toBe(false)
  })
})

interface LauncherFixture {
  env: NodeJS.ProcessEnv
  openCodeLog: string
  sshLog: string
  stateHome: string
}

async function createFixture(
  canonicalWorkdir: string,
  extraEnvironment: NodeJS.ProcessEnv = {}
): Promise<LauncherFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocssh-launch-"))
  temporaryRoots.push(root)
  const stateHome = path.join(root, "state")
  const env: NodeJS.ProcessEnv = scrubFixtureEnvironment(process.env)
  const controlledNames = [
    ...Object.values(REMOTE_ENV),
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS",
  ]
  for (const name of controlledNames) delete env[name]

  const openCodeLog = path.join(root, "opencode.jsonl")
  const sshLog = path.join(root, "ssh.jsonl")
  Object.assign(env, {
    HOME: path.join(root, "home"),
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "run"),
    OPENCODE_PURE: "0",
    OPENCODE_SSH_OPENCODE_BIN: fakeOpenCode,
    [REMOTE_ENV.sshBinary]: fakeSsh,
    [REMOTE_ENV.sftpBinary]: fakeSftp,
    FAKE_OPENCODE_LOG: openCodeLog,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_STDOUT: `${canonicalWorkdir}\n`,
    FAKE_SSH_EXIT_CODE: "0",
    ...extraEnvironment,
  })

  return { env, openCodeLog, sshLog, stateHome }
}

function parseJsonLines<T>(contents: string): T[] {
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function launcherLogPath(fixture: LauncherFixture): string {
  return resolveDailyLogFilePath({
    logDirectory: path.join(fixture.stateHome, "opencode-ssh", "logs"),
  })
}

function rawStderrDirectory(fixture: LauncherFixture): string {
  return path.join(fixture.stateHome, "opencode-ssh", "logs", "raw")
}

async function listRegularFiles(root: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(root, { recursive: true })
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(root, entry)
    try {
      if ((await stat(entryPath)).isFile()) files.push(entryPath)
    } catch (error) {
      if (!errnoIs(error, "ENOENT")) throw error
    }
  }
  return files.sort()
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false
  )
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function errnoIs(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}
