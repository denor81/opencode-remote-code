import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spawnManaged, spawnProcess, type ProcessResult } from "../../src/process.js"
import {
  createReadyRecord,
  type ReadyHandshakeIdentity,
} from "../../src/ready-handshake.js"
import {
  FIXTURE_CONTROL_ENV_NAMES,
  scrubFixtureEnvironment,
} from "../helpers/fixture-environment.js"
import {
  detectInstalledOpenCode,
  waitForReadyEvent,
  waitForSshPidEvent,
} from "../helpers/installed-opencode-task-fixture.js"

const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))

describe("scripted OpenAI provider fixture", () => {
  it("reads only the OpenAI message history for tool evidence", async () => {
    const {
      providerHasToolCall,
      providerHistoryContains,
      providerMessageTexts,
      providerToolResultText,
    } = await import("../helpers/scripted-openai-provider.js")
    const request = {
      sequence: 1,
      method: "POST",
      pathname: "/v1/chat/completions",
      headers: {},
      body: {
        messages: [
          { role: "system", content: "system marker" },
          { role: "user", content: "user marker" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_task",
                type: "function",
                function: {
                  name: "task",
                  arguments: '{"prompt":"argument marker"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_task",
            content: '<task id="ses_visible" state="completed">\nresult marker',
          },
        ],
        decoy: {
          tool_call_id: "call_decoy",
          content: "decoy marker",
        },
      },
    }

    expect(providerMessageTexts(request, "system")).toEqual(["system marker"])
    expect(providerHistoryContains(request, "argument marker")).toBe(true)
    expect(providerHistoryContains(request, "result marker")).toBe(true)
    expect(providerHistoryContains(request, "decoy marker")).toBe(false)
    expect(providerHasToolCall(request, "call_task")).toBe(true)
    expect(providerHasToolCall(request, "call_decoy")).toBe(false)
    expect(providerToolResultText(request, "call_task")).toContain("ses_visible")
    expect(providerToolResultText(request, "call_decoy")).toBeUndefined()
  })

  it("binds to loopback, captures requests, and streams text and tool calls", async () => {
    const { startScriptedOpenAIProvider } = await import(
      "../helpers/scripted-openai-provider.js"
    )
    const provider = await startScriptedOpenAIProvider()
    provider.configure([
      {
        name: "text completion",
        match: (request) => request.body?.purpose === "text",
        response: { type: "text", text: "fixture text" },
      },
      {
        name: "tool call",
        match: (request) => request.body?.purpose === "tool",
        response: {
          type: "tool-call",
          id: "call_fixture",
          name: "remote_status",
          arguments: {},
        },
      },
      {
        name: "parallel tool calls",
        match: (request) => request.body?.purpose === "parallel-tools",
        response: {
          type: "tool-calls",
          calls: [
            {
              id: "call_first",
              name: "task",
              arguments: { subagent_type: "explore" },
            },
            {
              id: "call_second",
              name: "task",
              arguments: { subagent_type: "custom-general" },
            },
          ],
        },
      },
    ])
    expect(() => provider.configure([])).toThrow(/already configured/u)

    try {
      expect(provider.hostname).toBe("127.0.0.1")
      const textResponse = await requestCompletion(provider.baseURL, { purpose: "text" })
      const toolResponse = await requestCompletion(provider.baseURL, { purpose: "tool" })
      const parallelResponse = await requestCompletion(provider.baseURL, {
        purpose: "parallel-tools",
      })

      expect(textResponse).toContain('"content":"fixture text"')
      expect(toolResponse).toContain('"name":"remote_status"')
      expect(toolResponse).toContain('"arguments":"{}"')
      const parallelEvents = parseSseEvents(parallelResponse)
      expect(parallelEvents[1].choices[0].delta.tool_calls).toEqual([
        {
          index: 0,
          id: "call_first",
          type: "function",
          function: { name: "task", arguments: "" },
        },
        {
          index: 1,
          id: "call_second",
          type: "function",
          function: { name: "task", arguments: "" },
        },
      ])
      expect(parallelEvents[2].choices[0].delta.tool_calls).toEqual([
        {
          index: 0,
          function: { arguments: '{"subagent_type":"explore"}' },
        },
        {
          index: 1,
          function: { arguments: '{"subagent_type":"custom-general"}' },
        },
      ])
      expect(provider.requests).toHaveLength(3)
      expect(provider.requests[0]).toMatchObject({
        method: "POST",
        pathname: "/v1/chat/completions",
        matchedStep: "text completion",
      })
      expect(provider.requests[0].headers.authorization).toBe("Bearer fixture-key")
      expect(() => provider.assertComplete()).not.toThrow()
    } finally {
      await provider.close()
    }
  })

  it("fails unmatched requests with bounded diagnostics", async () => {
    const { startScriptedOpenAIProvider } = await import(
      "../helpers/scripted-openai-provider.js"
    )
    const provider = await startScriptedOpenAIProvider([
      {
        name: "only expected request",
        match: () => false,
        response: { type: "text", text: "unused" },
      },
    ])

    try {
      const response = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unexpected: "x".repeat(10_000) }),
      })

      expect(response.status).toBe(400)
      expect((await response.text()).length).toBeLessThan(4_096)
      expect(() => provider.assertComplete()).toThrow(/only expected request.*unmatched/u)
    } finally {
      await provider.close()
    }
  })

  it("does not finish close until an active response handler settles", async () => {
    const { startScriptedOpenAIProvider } = await import(
      "../helpers/scripted-openai-provider.js"
    )
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const provider = await startScriptedOpenAIProvider([
      {
        name: "delayed active handler",
        match: () => true,
        response: async () => {
          markEntered()
          await released
          return { type: "text", text: "settled" }
        },
      },
    ])
    const request = requestCompletion(provider.baseURL, { purpose: "delayed" }).catch(
      (error: unknown) => error
    )

    await entered
    let closeSettled = false
    const closing = provider.close().then(() => {
      closeSettled = true
    })
    await delay(25)
    expect(closeSettled).toBe(false)

    release()
    await closing
    await request
    expect(() => provider.assertComplete()).not.toThrow()
  })
})

describe("installed OpenCode Task fixture", () => {
  it("preserves the selected command directory when PATH uses a symlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-command-path-test-"))
    const commandDirectory = path.join(root, "bin")
    const command = path.join(commandDirectory, "opencode")

    try {
      await mkdir(commandDirectory, { mode: 0o700 })
      await symlink(process.execPath, command)

      expect(detectInstalledOpenCode({ PATH: commandDirectory })).toEqual({
        kind: "available",
        binary: await realpath(process.execPath),
        commandDirectory,
        originalCommandPath: command,
        resolvedExecutable: await realpath(process.execPath),
        expectedVersion: undefined,
        required: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("requires an explicit executable in exact-version mode", () => {
    expect(
      detectInstalledOpenCode({
        PATH: "",
        OPENCODE_TASK_TEST_EXPECTED_VERSION: "1.18.18",
      })
    ).toEqual({
      kind: "absent",
      reason: "OPENCODE_TASK_TEST_BINARY is required in exact-version mode",
      required: true,
    })
  })

  it("polls ready and PID files even when watcher notifications are unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-task-poll-test-"))
    const readyPath = path.join(root, "ready.json")
    const pidPath = path.join(root, "pids.jsonl")
    const identity: ReadyHandshakeIdentity = {
      launchID: "poll-launch",
      nonce: "poll-ready-nonce",
      alias: "poll-host",
      canonicalWorkdir: "/srv/poll",
      targetID: "poll-target",
    }
    const launcherResult = new Promise<ProcessResult>(() => undefined)

    try {
      const ready = waitForReadyEvent(readyPath, identity, launcherResult, 1_000, {
        useWatcher: false,
        pollIntervalMs: 5,
      })
      const records = waitForSshPidEvent(
        pidPath,
        { event: "started", count: 1, timeoutMs: 1_000 },
        { useWatcher: false, pollIntervalMs: 5 }
      )
      await delay(25)
      await Promise.all([
        writeFile(readyPath, `${JSON.stringify(createReadyRecord(identity))}\n`, "utf8"),
        writeFile(
          pidPath,
          `${JSON.stringify({
            event: "started",
            pid: process.pid,
            input: "printf POLLED_PID",
          })}\n`,
          "utf8"
        ),
      ])

      await expect(ready).resolves.toEqual(createReadyRecord(identity))
      await expect(records).resolves.toEqual([
        { event: "started", pid: process.pid, input: "printf POLLED_PID" },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("fixture environment isolation", () => {
  it("removes every centralized fake fixture control from hostile ambient input", () => {
    const hostile = Object.fromEntries(
      FIXTURE_CONTROL_ENV_NAMES.map((name) => [name, `hostile-${name}`])
    )
    const isolated = scrubFixtureEnvironment({ ...hostile, KEEP_ME: "preserved" })

    expect(isolated.KEEP_ME).toBe("preserved")
    for (const name of FIXTURE_CONTROL_ENV_NAMES) {
      expect(isolated).not.toHaveProperty(name)
    }
  })
})

describe("fake SSH response router", () => {
  it("does not let an early check delete a later master state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fake-ssh-master-race-test-"))
    const socketPath = path.join(root, "master.sock")
    const statePath = `${socketPath}.fake-ssh-master`
    const markerPath = path.join(root, "check-missed")
    const releasePath = path.join(root, "release-check")
    const env = fixtureEnvironment({
      FAKE_SSH_CHECK_MISS_MARKER: markerPath,
      FAKE_SSH_CHECK_MISS_RELEASE: releasePath,
    })
    const check = spawnProcess(
      fakeSsh,
      ["-S", socketPath, "-O", "check", "--", "fixture-host"],
      { env }
    )
    let master: ReturnType<typeof spawnManaged> | undefined

    try {
      await waitForFile(markerPath)
      master = spawnManaged(
        fakeSsh,
        ["-MN", "-o", `ControlPath=${socketPath}`, "--", "fixture-host"],
        { env }
      )
      const state = await waitForJsonFile<{ pid: number }>(statePath)
      expect(state.pid).toBe(master.pid)
      await writeFile(releasePath, "release\n", "utf8")

      expect((await check).exitCode).toBe(255)
      await expect(readFile(statePath, "utf8")).resolves.toBe(
        JSON.stringify({ pid: master.pid })
      )
    } finally {
      await writeFile(releasePath, "release\n", "utf8").catch(() => undefined)
      await check.catch(() => undefined)
      await master?.terminate().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("routes exact stdin and fails unmatched input", async () => {
    const input = "cd /srv/fixture || exit $?\nprintf LOCAL_EXECUTION_CANARY"
    const env = fixtureEnvironment({
      FAKE_SSH_RESPONSES: JSON.stringify([
        { input, stdout: "REMOTE_FIXTURE_OUTPUT\n", stderr: "remote note\n", exitCode: 7 },
      ]),
      FAKE_SSH_FAIL_UNMATCHED: "1",
      FAKE_SSH_STDOUT: "legacy fallback must not be used",
    })

    const matched = await runFakeSsh(input, env)
    const unmatched = await runFakeSsh("different input", env)

    expect(matched).toMatchObject({
      stdout: "REMOTE_FIXTURE_OUTPUT\n",
      stderr: "remote note\n",
      exitCode: 7,
    })
    expect(unmatched.exitCode).toBe(2)
    expect(unmatched.stderr).toMatch(/unmatched exact stdin/u)
    expect(unmatched.stderr.length).toBeLessThan(2_048)
  })

  it("validates response tables and can require a live fake master", async () => {
    const invalid = await runFakeSsh(
      "true",
      fixtureEnvironment({
        FAKE_SSH_RESPONSES: JSON.stringify([{ input: "true", unexpected: true }]),
      })
    )
    expect(invalid.exitCode).not.toBe(0)
    expect(invalid.stderr).toMatch(/FAKE_SSH_RESPONSES entry 0 is invalid/u)

    const noMaster = await runFakeSsh(
      "true",
      fixtureEnvironment({
        FAKE_SSH_REQUIRE_LIVE_MASTER: "1",
        FAKE_SSH_RESPONSES: JSON.stringify([{ input: "true", stdout: "not reached" }]),
      })
    )
    expect(noMaster.exitCode).toBe(255)
    expect(noMaster.stderr).toMatch(/live fake ControlMaster/u)
  })

  it("supports validated route-local delay and PID lifecycle logging", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fake-ssh-route-test-"))
    const pidLog = path.join(root, "ssh-pids.jsonl")
    const input = "printf LONG_RUNNING_ROUTE"
    const controller = new AbortController()

    try {
      const command = runFakeSsh(
        input,
        fixtureEnvironment({
          FAKE_SSH_PID_LOG: pidLog,
          FAKE_SSH_RESPONSES: JSON.stringify([
            { input, stdout: "must not complete", delayMs: 60_000, trackPid: true },
          ]),
        }),
        controller.signal
      )
      const [started] = await waitForPidRecords(pidLog, 1)
      expect(started).toMatchObject({ event: "started", input })

      let settled = false
      void command.then(() => {
        settled = true
      })
      await delay(25)
      expect(settled).toBe(false)

      controller.abort(new Error("fixture cancellation"))
      const result = await command
      expect(result).toMatchObject({ aborted: true, termination: "abort" })
      const records = await waitForPidRecords(pidLog, 2)
      expect(records).toEqual([
        { event: "started", pid: started.pid, input },
        { event: "exited", pid: started.pid, input },
      ])
      expect(() => process.kill(started.pid, 0)).toThrow()

      for (const response of [
        { input: "true", delayMs: -1 },
        { input: "true", trackPid: "yes" },
      ]) {
        const invalid = await runFakeSsh(
          "true",
          fixtureEnvironment({ FAKE_SSH_RESPONSES: JSON.stringify([response]) })
        )
        expect(invalid.exitCode).not.toBe(0)
        expect(invalid.stderr).toMatch(/FAKE_SSH_RESPONSES entry 0 is invalid/u)
      }
    } finally {
      controller.abort()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function requestCompletion(baseURL: string, body: Record<string, string>): Promise<string> {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  return response.text()
}

function parseSseEvents(contents: string): any[] {
  return contents
    .split("\n\n")
    .filter((event) => event.startsWith("data: {") && event !== "data: [DONE]")
    .map((event) => JSON.parse(event.slice("data: ".length)))
}

function fixtureEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    ...extra,
  }
}

async function runFakeSsh(
  input: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
) {
  return spawnProcess(
    fakeSsh,
    ["-T", "-S", "/tmp/missing-fixture.sock", "--", "fixture-host", "sh", "-s"],
    { env, input, signal }
  )
}

interface SshPidRecord {
  event: "started" | "exited"
  pid: number
  input: string
}

async function waitForPidRecords(
  filePath: string,
  count: number
): Promise<SshPidRecord[]> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const contents = await readFile(filePath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      }
    )
    const records = contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SshPidRecord)
    if (records.length >= count) return records
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${count} fake SSH PID records`)
}

async function waitForFile(filePath: string): Promise<void> {
  await waitForJsonFile<string>(filePath, false)
}

async function waitForJsonFile<T>(
  filePath: string,
  parse = true
): Promise<T> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const contents = await readFile(filePath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      }
    )
    if (contents !== undefined) {
      return (parse ? JSON.parse(contents) : contents) as T
    }
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}
