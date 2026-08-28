import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { tool, type Hooks, type ToolContext } from "@opencode-ai/plugin"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import RemoteCodePlugin from "../../src/index.js"
import { REMOTE_ENV } from "../../src/config.js"
import {
  LOGGER_CHILD_ENV,
  resolveDailyLogFilePath,
} from "../../src/logger.js"
import { PROBE_ENV } from "../../src/opencode-probe.js"
import {
  READY_PROTOCOL,
  READY_STABILITY_INTERVAL_MS,
  confirmReadyHandshakeStability,
  createReadyRecord,
  validateReadyRecord,
  type ReadyHandshakeIdentity,
} from "../../src/ready-handshake.js"
import { computeTargetID } from "../../src/runtime-paths.js"
import {
  TASK_RESUME_PROTOCOL,
  TASK_RESUME_QUALIFIED_OPENCODE_VERSION,
} from "../../src/task-resume-capability.js"
import { FIXTURE_CONTROL_ENV_NAMES } from "../helpers/fixture-environment.js"

const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const fakeSsh = fileURLToPath(new URL("../fixtures/bin/ssh", import.meta.url))
const temporaryRoots: string[] = []
const isolatedEnvironmentNames = [
  ...Object.values(REMOTE_ENV),
  ...FIXTURE_CONTROL_ENV_NAMES,
  ...Object.values(PROBE_ENV),
  ...Object.values(LOGGER_CHILD_ENV),
]
let savedEnvironment = new Map<string, string | undefined>()

beforeEach(() => {
  savedEnvironment = new Map(
    isolatedEnvironmentNames.map((name) => [name, process.env[name]])
  )
  for (const name of isolatedEnvironmentNames) delete process.env[name]
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const name of isolatedEnvironmentNames) {
    const value = savedEnvironment.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("server plugin registration", () => {
  it("registers SSH tools and publishes readiness only after resolved policy", async () => {
    const fixture = await createPluginFixture()
    const sessionGet = vi.fn(async () => ({
      data: { id: "session", permission: [] },
    }))
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(
        pluginInput(sessionGet),
        pluginOptions(fixture)
      )
      expect(parseJsonLines<string>(await readFile(fixture.sshInputLog, "utf8"))).toEqual([
        "uname -s",
        `git -C '${fixture.remoteWorkdir}' rev-parse --is-inside-work-tree 2>/dev/null`,
      ])
      delete process.env.FAKE_SSH_FAIL_UNMATCHED
      expect(await pathExists(fixture.readyPath)).toBe(false)
      expect(hooks.config).toEqual(expect.any(Function))
      expect(hooks["tool.execute.before"]).toEqual(expect.any(Function))
      expect(hooks["tool.execute.after"]).toEqual(expect.any(Function))

      const tools = hooks.tool
      expect(tools).toBeDefined()
      expect(Object.keys(tools ?? {}).sort()).toEqual(
        ["bash", "read", "write", "edit", "glob", "grep", "apply_patch", "remote_status"].sort()
      )

      for (const definition of Object.values(tools ?? {})) {
        expect(definition.description).toEqual(expect.any(String))
        expect(definition.execute).toEqual(expect.any(Function))
        const parameters = tool.schema.object(definition.args)
        expect(parameters).toBeInstanceOf(tool.schema.ZodObject)
        expect(parameters._zod.def.type).toBe("object")
        for (const schema of Object.values(definition.args)) {
          expect(schema).toBeInstanceOf(tool.schema.ZodType)
          expect(schema._zod.def.type).toEqual(expect.any(String))
          expect("safeParse" in schema && typeof schema.safeParse === "function").toBe(
            true
          )
        }
      }
      expect(tools?.bash.args.command._zod.def.type).toBe("string")
      expect(tools?.bash.args.workdir._zod.def.type).toBe("optional")
      expect(tools?.remote_status.args).toEqual({})

      const reviewer = {
        mode: "subagent",
        permission: { "*": "deny" },
      }
      const resolvedConfig = {
        subagent_depth: 4,
        permission: { bash: "ask" },
        agent: { reviewer },
        experimental: { batch_tool: true, primary_tools: ["bash"] },
        model: "fixture/model",
      }
      const concurrentConfig = structuredClone(resolvedConfig)
      await Promise.all([
        hooks.config!(resolvedConfig as never),
        hooks.config!(concurrentConfig as never),
      ])
      expect(resolvedConfig).toEqual({
        subagent_depth: 1,
        permission: { bash: "ask", remote_status: "ask" },
        agent: { reviewer },
        experimental: {
          batch_tool: true,
          primary_tools: ["bash", "task"],
        },
        model: "fixture/model",
      })
      expect(concurrentConfig).toEqual(resolvedConfig)

      const identity: ReadyHandshakeIdentity = {
        launchID: fixture.launchID,
        nonce: fixture.nonce,
        alias: fixture.alias,
        canonicalWorkdir: fixture.remoteWorkdir,
        targetID: fixture.targetID,
      }
      const readyValue = JSON.parse(await readFile(fixture.readyPath, "utf8")) as unknown
      expect(validateReadyRecord(readyValue, identity)).toEqual(createReadyRecord(identity))
      expect(readyValue).toMatchObject({ protocol: READY_PROTOCOL })
      expect(readyValue).not.toHaveProperty("nonce")
      expect((await stat(fixture.readyPath)).mode & 0o777).toBe(0o600)

      const ask = vi.fn<ToolContext["ask"]>(async () => undefined)
      const ordinaryCalls: Array<[string, Record<string, unknown>]> = [
        ["read", { filePath: `${fixture.remoteWorkdir}/file.txt` }],
        ["write", { filePath: `${fixture.remoteWorkdir}/file.txt`, content: "x" }],
        ["edit", { filePath: `${fixture.remoteWorkdir}/file.txt`, oldString: "x", newString: "y" }],
        ["glob", { pattern: "*.ts" }],
        ["grep", { pattern: "value" }],
        ["apply_patch", { patchText: "*** Begin Patch\n*** End Patch" }],
      ]
      for (const [name, args] of ordinaryCalls) {
        await expect(
          tools![name].execute(args, toolContext(ask))
        ).rejects.toThrow(/preflight/i)
      }
      expect(ask).not.toHaveBeenCalled()

      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "task-call" },
          { args: {} }
        )
      ).rejects.toThrow(/preflight/i)
      expect(sessionGet).toHaveBeenCalledWith({ path: { id: "session" } })

      const statusResult = await tools!.remote_status.execute(
        {},
        toolContext(ask)
      )
      expect(statusResult).toMatchObject({
        metadata: {
          executor: "ssh",
          targetAlias: fixture.alias,
          remoteWorkdir: fixture.remoteWorkdir,
          connectionId: fixture.targetID,
          controlMaster: "healthy",
          subagentPolicy: {
            requestedDepth: 4,
            effectiveDepth: 1,
            depthWasNarrowed: true,
            taskPrimaryOnly: true,
          },
        },
      })
      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({ permission: "remote_status", always: [] })
      )

      await tools!.bash.execute(
        {
          command: "hostname; whoami; pwd -P",
          description: "Verify remote identity",
        },
        toolContext(ask)
      )
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "ready-task" },
          { args: {} }
        )
      ).resolves.toBeUndefined()
      expect(
        ask.mock.calls.every(([request]) => request.always.length === 0)
      ).toBe(true)

      const statusDenied = new Error("repeated remote_status denied")
      await expect(
        tools!.remote_status.execute(
          {},
          toolContext(
            vi.fn(async () => {
              throw statusDenied
            })
          )
        )
      ).rejects.toBe(statusDenied)
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "denied-task" },
          { args: {} }
        )
      ).rejects.toThrow(/preflight/i)

      await tools!.remote_status.execute({}, toolContext(ask))
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "denied-recheck-task" },
          { args: {} }
        )
      ).rejects.toThrow(/preflight/i)
      await tools!.bash.execute(
        {
          command: "hostname; whoami; pwd -P",
          description: "Re-verify after denied status",
        },
        toolContext(ask)
      )
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "denied-reverified-task" },
          { args: {} }
        )
      ).resolves.toBeUndefined()

      process.env.FAKE_SSH_EXIT_CODE = "1"
      const unhealthyStatus = await tools!.remote_status.execute(
        {},
        toolContext(ask)
      )
      expect(unhealthyStatus).toMatchObject({
        metadata: { controlMaster: "unhealthy" },
      })
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "unhealthy-task" },
          { args: {} }
        )
      ).rejects.toThrow(/preflight/i)

      process.env.FAKE_SSH_EXIT_CODE = "0"
      await tools!.remote_status.execute({}, toolContext(ask))
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "recheck-task" },
          { args: {} }
        )
      ).rejects.toThrow(/preflight/i)
      await tools!.bash.execute(
        {
          command: "hostname; whoami; pwd -P",
          description: "Re-verify remote identity",
        },
        toolContext(ask)
      )
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "reverified-task" },
          { args: {} }
        )
      ).resolves.toBeUndefined()

      await hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { info: { id: "session" } },
        } as never,
      })
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "deleted-task" },
          { args: {} }
        )
      ).rejects.toThrow(/preflight/i)

      await writeFile(fixture.readyPath, "one-shot-sentinel\n", "utf8")
      const restrictedConfig = {
        subagent_depth: 0,
        permission: { remote_status: "deny", bash: "ask" },
        agent: {
          explore: {
            permission: { "remote_*": "deny", read: "allow" },
          },
        },
        experimental: { primary_tools: ["read", "task"] },
      }
      await hooks.config!(restrictedConfig as never)
      expect(restrictedConfig).toEqual({
        subagent_depth: 0,
        permission: { remote_status: "deny", bash: "ask" },
        agent: {
          explore: {
            permission: { "remote_*": "deny", read: "allow" },
          },
        },
        experimental: { primary_tools: ["read", "task"] },
      })
      expect(await readFile(fixture.readyPath, "utf8")).toBe("one-shot-sentinel\n")

      const originalSystem = ["normal OpenCode system prompt", "context from another plugin"]
      const output = { system: [...originalSystem] }
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "session-1", model: {} as never },
        output
      )
      expect(output.system.slice(0, originalSystem.length)).toEqual(originalSystem)
      expect(output.system).toHaveLength(originalSystem.length + 1)
      expect(output.system.at(-1)).toContain(`SSH alias: ${fixture.alias}`)
      expect(output.system.at(-1)).toContain(`Remote workspace: ${fixture.remoteWorkdir}`)
      expect(output.system.at(-1)).toContain("Task resume is disabled")
      expect(output.system.at(-1)).not.toContain("REMOTE_AGENTS_TASK2_MARKER")

      const sshCalls = parseJsonLines<string[]>(await readFile(fixture.sshLog, "utf8"))
      expect(sshCalls).toHaveLength(12)
      for (const args of sshCalls) {
        expect(args).toEqual([
          "-T",
          "-S",
          fixture.socketPath,
          "-o",
          "ControlMaster=no",
          "-o",
          "BatchMode=yes",
          "-o",
          "PasswordAuthentication=no",
          "-o",
          "KbdInteractiveAuthentication=no",
          "-o",
          "ProxyCommand=false",
          "--",
          fixture.alias,
          "sh",
          "-s",
        ])
      }
      const sshInputs = parseJsonLines<string>(await readFile(fixture.sshInputLog, "utf8"))
      expect(sshInputs).toHaveLength(12)
      expect(sshInputs.some((input) => input.includes("AGENTS.md"))).toBe(false)

      expect(hooks.dispose).toEqual(expect.any(Function))
      await hooks.dispose?.()
      await hooks.dispose?.()
    } finally {
      await hooks?.dispose?.()
    }
  })

  it("closes the SSH pool before permission-held Bash can start a command", async () => {
    const fixture = await createPluginFixture()
    const askStarted = deferred()
    const releaseAsk = deferred()
    let hooks: Hooks | undefined
    let execution: Promise<unknown> | undefined

    try {
      hooks = await RemoteCodePlugin.server(pluginInput(vi.fn()), {
        ...pluginOptions(fixture),
      })
      delete process.env.FAKE_SSH_FAIL_UNMATCHED
      await hooks.config?.({
        permission: { remote_status: "allow", bash: "allow" },
      } as never)
      await completePluginPreflight(
        hooks.tool!,
        vi.fn(async () => undefined),
        "session",
        "build"
      )

      const blockedAsk = vi.fn<ToolContext["ask"]>(async (request) => {
        expect(request.permission).toBe("bash")
        askStarted.resolve()
        await releaseAsk.promise
      })
      execution = hooks.tool!.bash.execute(
        { command: "printf held", description: "permission-held command" },
        toolContext(blockedAsk)
      )
      const executionResult = expect(execution).rejects.toThrow(/SSH pool is closed/i)
      await askStarted.promise
      const callsBeforeDisposal = parseJsonLines<string>(
        await readFile(fixture.sshInputLog, "utf8")
      )

      const disposal = hooks.dispose!()
      releaseAsk.resolve()
      await executionResult
      await disposal

      expect(
        parseJsonLines<string>(await readFile(fixture.sshInputLog, "utf8"))
      ).toEqual(callsBeforeDisposal)
    } finally {
      releaseAsk.resolve()
      await execution?.catch(() => undefined)
      await hooks?.dispose?.()
    }
  })

  it("requires callable session lookup before ownership, mirror, or SSH side effects", async () => {
    const fixture = await createPluginFixture()

    await expect(
      RemoteCodePlugin.server(
        { client: { session: { get: "not-callable" } } } as never,
        pluginOptions(fixture)
      )
    ).rejects.toThrow(/Task safety.*client\.session\.get.*callable/i)
    expect(await pathExists(fixture.readyPath)).toBe(false)
    expect(await pathExists(fixture.mirrorRoot)).toBe(false)
    expect(await pathExists(fixture.sshLog)).toBe(false)
    expect(await pathExists(fixture.sshInputLog)).toBe(false)

    const hooks = await RemoteCodePlugin.server(
      pluginInput(vi.fn()),
      pluginOptions(fixture)
    )
    try {
      expect(await pathExists(fixture.mirrorRoot)).toBe(true)
      expect(await pathExists(fixture.sshLog)).toBe(true)
    } finally {
      await hooks.dispose?.()
    }
  })

  it("uses the legacy SDK transport without global fetch or serverUrl access", async () => {
    const fixture = await createPluginFixture()
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch must not be called")
    })
    vi.stubGlobal("fetch", globalFetch)
    const legacyGet = vi.fn(async (request: LegacyHealthRequest) =>
      sdkHealthOutput(
        request,
        {
          data: {
            healthy: true,
            version: fixture.expectedOpenCodeRuntimeVersion,
          },
        },
        200
      )
    )
    const input = pluginInput(
      vi.fn(),
      fixture.expectedOpenCodeRuntimeVersion,
      { legacyGet }
    )
    const client = (input as unknown as {
      client: {
        _client: object
        global: { _client: object }
        session: { _client: object }
      }
    }).client
    expect(Object.hasOwn(client, "_client")).toBe(true)
    expect(Object.hasOwn(client.global, "_client")).toBe(true)
    expect(Object.hasOwn(client.session, "_client")).toBe(true)
    expect(Object.hasOwn(client._client, "get")).toBe(true)
    expect(client.global._client).toBe(client._client)
    expect(client.session._client).toBe(client._client)
    let serverUrlReads = 0
    Object.defineProperty(input as unknown as object, "serverUrl", {
      configurable: true,
      enumerable: true,
      get: () => {
        serverUrlReads += 1
        return new URL("http://127.0.0.1:4096")
      },
    })
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(input, pluginOptions(fixture))
      expect(legacyGet).toHaveBeenCalledOnce()
      expect(legacyGet).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/global/health",
          signal: expect.any(AbortSignal),
        })
      )
      expect(globalFetch).not.toHaveBeenCalled()
      expect(serverUrlReads).toBe(0)
      expect(await pathExists(fixture.mirrorRoot)).toBe(true)
      expect(await pathExists(fixture.sshLog)).toBe(true)
      expect(await pathExists(fixture.readyPath)).toBe(false)
    } finally {
      await hooks?.dispose?.()
    }
  })

  it("prefers a future public global.health over the legacy SDK transport", async () => {
    const fixture = await createPluginFixture()
    const legacyGet = vi.fn(async () => {
      throw new Error("legacy transport must not be called")
    })
    const globalHealth = vi.fn(async ({ signal }: { signal: AbortSignal }) =>
      sdkHealthOutput(
        { url: "/global/health", signal },
        {
          data: {
            healthy: true,
            version: fixture.expectedOpenCodeRuntimeVersion,
          },
        },
        200
      )
    )
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(
        pluginInput(vi.fn(), fixture.expectedOpenCodeRuntimeVersion, {
          legacyGet,
          globalHealth,
        }),
        pluginOptions(fixture)
      )
      expect(globalHealth).toHaveBeenCalledOnce()
      expect(globalHealth).toHaveBeenCalledWith({
        signal: expect.any(AbortSignal),
      })
      expect(legacyGet).not.toHaveBeenCalled()
    } finally {
      await hooks?.dispose?.()
    }
  })

  it.each([
    {
      name: "a version mismatch",
      result: (request: LegacyHealthRequest) =>
        sdkHealthOutput(
          request,
          { data: { healthy: true, version: "1.18.19" } },
          200
        ),
      error: /expected runtime version "1\.18\.18" but observed "1\.18\.19"/i,
    },
    {
      name: "a malformed payload",
      result: (request: LegacyHealthRequest) =>
        sdkHealthOutput(request, { data: { healthy: true } }, 200),
      error: /global health returned an invalid payload/i,
    },
    {
      name: "an SDK error",
      result: (request: LegacyHealthRequest) =>
        sdkHealthOutput(
          request,
          { error: { message: "runtime health unavailable" } },
          503
        ),
      error: /client\._client\.get returned an invalid result/i,
    },
  ])(
    "rejects $name from legacy health before mirror, SSH, or readiness side effects",
    async ({ result, error }) => {
      const fixture = await createPluginFixture()
      const legacyGet = vi.fn(async (request: LegacyHealthRequest) =>
        result(request)
      )

      await expect(
        RemoteCodePlugin.server(
          pluginInput(vi.fn(), fixture.expectedOpenCodeRuntimeVersion, {
            legacyGet,
          }),
          pluginOptions(fixture)
        )
      ).rejects.toThrow(error)
      expect(legacyGet).toHaveBeenCalledOnce()
      expect(legacyGet).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/global/health",
          signal: expect.any(AbortSignal),
        })
      )
      expect(await pathExists(fixture.readyPath)).toBe(false)
      expect(await pathExists(fixture.mirrorRoot)).toBe(false)
      expect(await pathExists(fixture.sshLog)).toBe(false)
      expect(await pathExists(fixture.sshInputLog)).toBe(false)

      const hooks = await RemoteCodePlugin.server(
        pluginInput(vi.fn()),
        pluginOptions(fixture)
      )
      await hooks.dispose?.()
    }
  )

  it("logs classified runtime-health initialization failure when enabled", async () => {
    const fixture = await createPluginFixture()
    const { logDirectory, startupID } = enablePluginLogging(fixture)
    const legacyGet = vi.fn(async (request: LegacyHealthRequest) =>
      sdkHealthOutput(request, { data: { healthy: true } }, 200)
    )

    await expect(
      RemoteCodePlugin.server(
        pluginInput(vi.fn(), fixture.expectedOpenCodeRuntimeVersion, {
          legacyGet,
        }),
        pluginOptions(fixture)
      )
    ).rejects.toThrow(/global health returned an invalid payload/i)

    const records = await waitForPluginLogEvents(logDirectory, [
      "plugin.production.activation",
      "plugin.runtime_health.started",
      "plugin.initialization.failed",
    ])
    const failure = requirePluginLogEvent(
      records,
      "plugin.initialization.failed"
    )
    expect(failure).toMatchObject({
      level: "error",
      fields: {
        component: "server-plugin",
        startupID,
        launchID: fixture.launchID,
        targetID: fixture.targetID,
        stage: "runtime-health",
        errorCategory: "runtime-health",
        errorName: "OpenCodeRuntimeObservationError",
        failureCode: "health-response-invalid",
        cleanupFailureCount: 0,
      },
    })
    expect(await pathExists(fixture.readyPath)).toBe(false)
    expect(await pathExists(fixture.mirrorRoot)).toBe(false)
    expect(await pathExists(fixture.sshLog)).toBe(false)
    expect(await pathExists(fixture.sshInputLog)).toBe(false)
  })

  it("logs successful config, ready publication, and disposal when enabled", async () => {
    const fixture = await createPluginFixture()
    const { logDirectory, startupID } = enablePluginLogging(fixture)
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(
        pluginInput(vi.fn()),
        pluginOptions(fixture)
      )
      await hooks.config?.({} as never)
      expect(await pathExists(fixture.readyPath)).toBe(true)
      await hooks.dispose?.()

      const expectedEvents = [
        "plugin.runtime_health.completed",
        "plugin.config_validation.started",
        "plugin.config_validation.completed",
        "plugin.ready_publication.started",
        "plugin.ready_publication.completed",
        "plugin.disposal.started",
        "plugin.disposal.completed",
      ]
      const records = await waitForPluginLogEvents(
        logDirectory,
        expectedEvents
      )
      expect(
        expectedEvents.every((event) =>
          records.some((record) => record.event === event)
        )
      ).toBe(true)
      expect(
        records.every((record) =>
          Object.entries({
            component: "server-plugin",
            startupID,
            launchID: fixture.launchID,
            targetID: fixture.targetID,
          }).every(([key, value]) => record.fields?.[key] === value)
        )
      ).toBe(true)
      expect(
        requirePluginLogEvent(records, "plugin.runtime_health.completed")
          .fields
      ).toMatchObject({
        runtimeVersion: fixture.expectedOpenCodeRuntimeVersion,
        runtimeVersionSource: "client._client.get",
      })
      expect(
        requirePluginLogEvent(records, "plugin.config_validation.completed")
          .fields
      ).toMatchObject({ requestCount: 1 })
      expect(await pathExists(fixture.readyPath)).toBe(false)
    } finally {
      await hooks?.dispose?.()
    }
  })

  it("does not enable executable fallback during production initialization", async () => {
    const fixture = await createPluginFixture()
    const executable = path.join(path.dirname(fixture.readyPath), "runtime-version")
    const invocationMarker = `${executable}.invoked`
    await writeFile(executable, '#!/bin/sh\n: > "$0.invoked"\nexit 73\n', {
      mode: 0o700,
    })
    const descriptor = Object.getOwnPropertyDescriptor(process, "execPath")!
    Object.defineProperty(process, "execPath", {
      ...descriptor,
      value: executable,
    })
    try {
      await expect(
        RemoteCodePlugin.server(
          {
            client: {
              global: {},
              session: { get: vi.fn() },
            },
          } as never,
          pluginOptions(fixture)
        )
      ).rejects.toThrow(/runtime health is unavailable in this loader process/i)
    } finally {
      Object.defineProperty(process, "execPath", descriptor)
    }

    expect(await pathExists(invocationMarker)).toBe(false)
    expect(await pathExists(fixture.readyPath)).toBe(false)
    expect(await pathExists(fixture.mirrorRoot)).toBe(false)
    expect(await pathExists(fixture.sshLog)).toBe(false)
    expect(await pathExists(fixture.sshInputLog)).toBe(false)

    const hooks = await RemoteCodePlugin.server(
      pluginInput(vi.fn()),
      pluginOptions(fixture)
    )
    await hooks.dispose?.()
  })

  it("accepts a matching unqualified runtime while keeping Task resume disabled", async () => {
    const fixture = await createPluginFixture("1.18.19")
    process.env[REMOTE_ENV.taskResumeCapability] = TASK_RESUME_PROTOCOL
    const hooks = await RemoteCodePlugin.server(
      pluginInput(vi.fn(), "1.18.19"),
      pluginOptions(fixture, { taskResumeCapability: TASK_RESUME_PROTOCOL })
    )

    try {
      await hooks.config?.({} as never)
      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "root", model: {} as never },
        output
      )
      expect(output.system.at(-1)).toContain("Task resume is disabled")
    } finally {
      await hooks.dispose?.()
    }
  })

  it("registers, resumes, revokes preflight, locks missing completion, and clears deleted children when enabled", async () => {
    const fixture = await createPluginFixture()
    process.env[REMOTE_ENV.taskResumeCapability] = TASK_RESUME_PROTOCOL
    const sessions = new Map<string, Record<string, unknown>>([
      ["root", { id: "root", permission: [] }],
      [
        "child",
        {
          id: "child",
          parentID: "root",
          agent: "general",
          permission: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "read", pattern: "*", action: "allow" },
          ],
        },
      ],
    ])
    const sessionGet = vi.fn(async (request: { path: { id: string } }) => {
      const data = sessions.get(request.path.id)
      return data === undefined
        ? { error: { message: "session not found" } }
        : { data }
    })
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(pluginInput(sessionGet), {
        ...pluginOptions(fixture),
        taskResumeCapability: TASK_RESUME_PROTOCOL,
      })
      delete process.env.FAKE_SSH_FAIL_UNMATCHED
      await hooks.config?.({
        subagent_depth: 1,
        permission: { remote_status: "allow", bash: "allow" },
      } as never)

      const tools = hooks.tool!
      const ask = vi.fn<ToolContext["ask"]>(async () => undefined)
      await completePluginPreflight(tools, ask, "root", "build")
      await completePluginPreflight(tools, ask, "child", "general")

      const freshArgs = {
        description: "Create child",
        prompt: "Perform remote work",
        subagent_type: "general",
      }
      await hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "fresh-call" },
        { args: freshArgs }
      )
      await hooks["tool.execute.after"]!(
        {
          tool: "task",
          sessionID: "root",
          callID: "fresh-call",
          args: freshArgs,
        },
        taskResult("root", "child")
      )

      const resumeArgs = { ...freshArgs, task_id: "child" }
      await hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "resume-call" },
        { args: resumeArgs }
      )
      await expect(
        tools.read.execute(
          { filePath: `${fixture.remoteWorkdir}/file.txt` },
          toolContext(ask, "child", "general")
        )
      ).rejects.toThrow(/preflight/i)

      await completePluginPreflight(tools, ask, "child", "general")
      await hooks["tool.execute.after"]!(
        {
          tool: "task",
          sessionID: "root",
          callID: "resume-call",
          args: resumeArgs,
        },
        taskResult("root", "child")
      )

      await hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "missing-after" },
        { args: resumeArgs }
      )
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "root", callID: "blocked-resume" },
          { args: resumeArgs }
        )
      ).rejects.toThrow(/reserved|uncertain/i)

      await hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { info: { id: "child" } },
        } as never,
      })
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "root", callID: "deleted-resume" },
          { args: resumeArgs }
        )
      ).rejects.toThrow(/not registered for this launch/i)

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "root", model: {} as never },
        output
      )
      expect(output.system.at(-1)).toContain(
        "exact task_id of a successfully completed foreground direct child"
      )
      expect(output.system.at(-1)).toContain(
        "repeat package remote_status and the exact identity Bash preflight"
      )
    } finally {
      await hooks?.dispose?.()
    }
  })

  it("observes SDK permission events and invalidates deletion security", async () => {
    const fixture = await createPluginFixture()
    let lookupBarrier:
      | { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
      | undefined
    const sessionGet = vi.fn(async () => {
      const barrier = lookupBarrier
      if (barrier) {
        barrier.started.resolve()
        await barrier.release.promise
      }
      return { data: { id: "root", permission: [] } }
    })
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(
        pluginInput(sessionGet),
        pluginOptions(fixture)
      )
      delete process.env.FAKE_SSH_FAIL_UNMATCHED
      await hooks.config?.({
        permission: { remote_status: "allow", bash: "allow" },
      } as never)
      await completePluginPreflight(
        hooks.tool!,
        vi.fn(async () => undefined),
        "root",
        "build"
      )

      const events = [
        {
          callID: "permission-updated-task",
          event: {
            type: "permission.updated",
            properties: {
              id: "permission-1",
              type: "bash",
              sessionID: "root",
              messageID: "message-1",
              title: "Bash permission",
              metadata: {},
              time: { created: 1 },
            },
          },
        },
        {
          callID: "permission-replied-task",
          event: {
            type: "permission.replied",
            properties: {
              sessionID: "root",
              permissionID: "permission-2",
              response: "once",
            },
          },
        },
        {
          callID: "session-deleted-task",
          event: {
            type: "session.deleted",
            properties: { info: { id: "root" } },
          },
        },
      ] as const

      for (const entry of events) {
        lookupBarrier = { started: deferred(), release: deferred() }
        const before = hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "root", callID: entry.callID },
          {
            args: {
              description: "Observe security event",
              prompt: "Perform remote work",
              subagent_type: "general",
            },
          }
        )
        const result = expect(before).rejects.toThrow(/security evidence changed/i)
        await lookupBarrier.started.promise
        await hooks.event?.({ event: entry.event as never })
        lookupBarrier.release.resolve()
        await result
        lookupBarrier = undefined
      }
    } finally {
      lookupBarrier?.release.resolve()
      await hooks?.dispose?.()
    }
  })

  it("normalizes v2 permission events without detached rejection", async () => {
    const fixture = await createPluginFixture()
    process.env[REMOTE_ENV.taskResumeCapability] = TASK_RESUME_PROTOCOL
    const sessions = new Map<string, Record<string, unknown>>([
      ["root", { id: "root", permission: [] }],
      [
        "child",
        {
          id: "child",
          parentID: "root",
          agent: "general",
          permission: [],
        },
      ],
    ])
    let lookupBarrier:
      | {
          sessionID: string
          started: ReturnType<typeof deferred>
          release: ReturnType<typeof deferred>
        }
      | undefined
    const sessionGet = vi.fn(async (request: { path: { id: string } }) => {
      const barrier = lookupBarrier
      if (barrier?.sessionID === request.path.id) {
        barrier.started.resolve()
        await barrier.release.promise
      }
      const data = sessions.get(request.path.id)
      return data === undefined
        ? { error: { message: "session not found" } }
        : { data }
    })
    let hooks: Hooks | undefined
    let activeOperation: Promise<void> | undefined

    try {
      hooks = await RemoteCodePlugin.server(
        pluginInput(sessionGet),
        pluginOptions(fixture, { taskResumeCapability: TASK_RESUME_PROTOCOL })
      )
      delete process.env.FAKE_SSH_FAIL_UNMATCHED
      await hooks.config?.({
        permission: { remote_status: "allow", bash: "allow" },
      } as never)
      await completePluginPreflight(
        hooks.tool!,
        vi.fn(async () => undefined),
        "root",
        "build"
      )
      const args = {
        description: "Create security-observed child",
        prompt: "Perform remote work",
        subagent_type: "general",
      }

      const expectOwnerInvalidation = async (
        callID: string,
        event: unknown
      ): Promise<void> => {
        lookupBarrier = {
          sessionID: "root",
          started: deferred(),
          release: deferred(),
        }
        activeOperation = hooks!["tool.execute.before"]!(
          { tool: "task", sessionID: "root", callID },
          { args }
        )
        const result = expect(activeOperation).rejects.toThrow(
          /security evidence changed/i
        )
        await lookupBarrier.started.promise
        const delivery = hooks!.event!({ event: event as never })
        lookupBarrier.release.resolve()
        await result
        await expect(delivery).resolves.toBeUndefined()
        activeOperation = undefined
        lookupBarrier = undefined
      }

      await expectOwnerInvalidation("v2-asked-owner", {
        type: "permission.asked",
        properties: {
          id: "request-v2-owner",
          sessionID: "root",
          permission: "bash",
          patterns: ["*"],
        },
      })
      await expectOwnerInvalidation("v2-malformed-reply-owner", {
        type: "permission.replied",
        properties: {
          sessionID: "root",
          requestID: 42,
          reply: "once",
        },
      })

      await hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "v2-child-fresh" },
        { args }
      )
      lookupBarrier = {
        sessionID: "child",
        started: deferred(),
        release: deferred(),
      }
      activeOperation = hooks["tool.execute.after"]!(
        {
          tool: "task",
          sessionID: "root",
          callID: "v2-child-fresh",
          args,
        },
        taskResult("root", "child")
      )
      const childResult = expect(activeOperation).rejects.toThrow(
        /security evidence changed/i
      )
      await lookupBarrier.started.promise
      const childDelivery = hooks.event!({
        event: {
          type: "permission.replied",
          properties: {
            sessionID: "child",
            requestID: "unknown-v2-child-request",
            reply: "once",
          },
        } as never,
      })
      lookupBarrier.release.resolve()
      await childResult
      await expect(childDelivery).resolves.toBeUndefined()
      activeOperation = undefined
      lookupBarrier = undefined
    } finally {
      lookupBarrier?.release.resolve()
      await activeOperation?.catch(() => undefined)
      await hooks?.dispose?.()
    }
  })

  it("rejects a fresh Task before hook whose session lookup outlives disposal", async () => {
    const fixture = await createPluginFixture()
    const lookupStarted = deferred()
    const releaseLookup = deferred()
    let blockLookup = false
    const sessionGet = vi.fn(async () => {
      if (blockLookup) {
        lookupStarted.resolve()
        await releaseLookup.promise
      }
      return { data: { id: "root", permission: [] } }
    })
    let hooks: Hooks | undefined
    let beforePromise: Promise<void> | undefined

    try {
      hooks = await RemoteCodePlugin.server(pluginInput(sessionGet), {
        ...pluginOptions(fixture),
      })
      delete process.env.FAKE_SSH_FAIL_UNMATCHED
      await hooks.config?.({
        permission: { remote_status: "allow", bash: "allow" },
      } as never)
      await completePluginPreflight(
        hooks.tool!,
        vi.fn(async () => undefined),
        "root",
        "build"
      )

      blockLookup = true
      beforePromise = hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "delayed-fresh-task" },
        {
          args: {
            description: "Delayed fresh child",
            prompt: "Perform remote work",
            subagent_type: "general",
          },
        }
      )
      const beforeResult = expect(beforePromise).rejects.toThrow(
        /plugin lifecycle.*disposed/i
      )
      await lookupStarted.promise

      await hooks.dispose?.()
      releaseLookup.resolve()
      await beforeResult
    } finally {
      releaseLookup.resolve()
      await beforePromise?.catch(() => undefined)
      await hooks?.dispose?.()
    }
  })

  it("rejects a late Task completion after terminal disposal", async () => {
    const fixture = await createPluginFixture()
    process.env[REMOTE_ENV.taskResumeCapability] = TASK_RESUME_PROTOCOL
    const lookupStarted = deferred()
    const releaseLookup = deferred()
    const sessions = new Map<string, Record<string, unknown>>([
      ["root", { id: "root", permission: [] }],
      [
        "child",
        {
          id: "child",
          parentID: "root",
          agent: "general",
          permission: [],
        },
      ],
    ])
    let blockChildLookup = false
    const sessionGet = vi.fn(async (request: { path: { id: string } }) => {
      if (blockChildLookup && request.path.id === "child") {
        lookupStarted.resolve()
        await releaseLookup.promise
      }
      const data = sessions.get(request.path.id)
      return data === undefined
        ? { error: { message: "session not found" } }
        : { data }
    })
    let hooks: Hooks | undefined
    let replacement: Hooks | undefined
    let afterPromise: Promise<void> | undefined

    try {
      hooks = await RemoteCodePlugin.server(pluginInput(sessionGet), {
        ...pluginOptions(fixture),
        taskResumeCapability: TASK_RESUME_PROTOCOL,
      })
      delete process.env.FAKE_SSH_FAIL_UNMATCHED
      await hooks.config?.({
        subagent_depth: 1,
        permission: { remote_status: "allow", bash: "allow" },
      } as never)

      const ask = vi.fn<ToolContext["ask"]>(async () => undefined)
      await completePluginPreflight(hooks.tool!, ask, "root", "build")
      const args = {
        description: "Create child",
        prompt: "Perform remote work",
        subagent_type: "general",
      }
      await hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "root", callID: "late-fresh-call" },
        { args }
      )

      blockChildLookup = true
      afterPromise = hooks["tool.execute.after"]!(
        {
          tool: "task",
          sessionID: "root",
          callID: "late-fresh-call",
          args,
        },
        taskResult("root", "child")
      )
      const lateResult = expect(afterPromise).rejects.toThrow(/registry is disposed/i)
      await lookupStarted.promise

      await hooks.dispose?.()
      expect(await pathExists(fixture.readyPath)).toBe(false)
      replacement = await RemoteCodePlugin.server(pluginInput(vi.fn()), {
        ...pluginOptions(fixture),
        taskResumeCapability: TASK_RESUME_PROTOCOL,
      })

      releaseLookup.resolve()
      await lateResult
    } finally {
      releaseLookup.resolve()
      await afterPromise?.catch(() => undefined)
      await replacement?.dispose?.()
      await hooks?.dispose?.()
    }
  })

  it("validates but terminally rejects a queued valid config after concurrent invalid config", async () => {
    const fixture = await createPluginFixture()
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(pluginInput(vi.fn()), {
        ...pluginOptions(fixture),
      })
      const queuedValidConfig = {
        subagent_depth: 4,
        experimental: { primary_tools: ["read"] },
      }

      const invalidResult = expect(
        hooks.config?.({ experimental: { primary_tools: "task" } } as never)
      ).rejects.toThrow(/incompatible resolved OpenCode config/i)
      const queuedValidResult = expect(
        hooks.config?.(queuedValidConfig as never)
      ).rejects.toThrow(/plugin lifecycle.*disposed/i)
      await invalidResult
      await queuedValidResult

      expect(queuedValidConfig).toEqual({
        subagent_depth: 1,
        permission: { remote_status: "ask" },
        experimental: { primary_tools: ["read", "task"] },
      })
      expect(await pathExists(fixture.readyPath)).toBe(false)
      await expect(hooks.config?.({} as never)).rejects.toThrow(
        /plugin lifecycle.*disposed/i
      )
      await expect(hooks.dispose?.()).resolves.toBeUndefined()
    } finally {
      await hooks?.dispose?.()
    }
  })

  it("rejects a valid-first config batch when the synchronous second config is invalid", async () => {
    const fixture = await createPluginFixture()
    const sessionGet = vi.fn()
    let hooks: Hooks | undefined
    let replacement: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(pluginInput(sessionGet), {
        ...pluginOptions(fixture),
      })
      const validConfig = {
        subagent_depth: 4,
        permission: { bash: "allow" },
        experimental: { primary_tools: ["read"] },
      }
      const invalidConfig = { experimental: { primary_tools: "task" } }

      const validResult = expect(
        hooks.config!(validConfig as never)
      ).rejects.toThrow(/plugin lifecycle.*same concurrent batch.*failed validation/i)
      const invalidResult = expect(
        hooks.config!(invalidConfig as never)
      ).rejects.toThrow(/incompatible resolved OpenCode config/i)
      await validResult
      await invalidResult

      expect(validConfig).toEqual({
        subagent_depth: 1,
        permission: { bash: "allow", remote_status: "ask" },
        experimental: { primary_tools: ["read", "task"] },
      })
      expect(invalidConfig).toEqual({
        experimental: { primary_tools: "task" },
      })
      expect(await pathExists(fixture.readyPath)).toBe(false)

      const laterConfig = { subagent_depth: 3 }
      await expect(hooks.config!(laterConfig as never)).rejects.toThrow(
        /plugin lifecycle.*disposed/i
      )
      expect(laterConfig).toEqual({ subagent_depth: 3 })

      const output = { system: [] as string[] }
      await expect(
        hooks["experimental.chat.system.transform"]!(
          { sessionID: "session", model: {} as never },
          output
        )
      ).rejects.toThrow(/plugin lifecycle.*disposed/i)
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "task", sessionID: "session", callID: "terminal-task" },
          { args: {} }
        )
      ).rejects.toThrow(/plugin lifecycle.*disposed/i)
      expect(output.system).toEqual([])
      expect(sessionGet).not.toHaveBeenCalled()

      replacement = await RemoteCodePlugin.server(pluginInput(vi.fn()), {
        ...pluginOptions(fixture),
      })
      expect(await pathExists(fixture.readyPath)).toBe(false)
    } finally {
      await replacement?.dispose?.()
      await hooks?.dispose?.()
    }
  })

  it("rejects stability when invalid config removes readiness one microtask later", async () => {
    const fixture = await createPluginFixture()
    let hooks: Hooks | undefined
    let stability: Promise<unknown> | undefined

    try {
      hooks = await RemoteCodePlugin.server(pluginInput(vi.fn()), {
        ...pluginOptions(fixture),
      })
      await hooks.config?.({} as never)
      const identity: ReadyHandshakeIdentity = {
        launchID: fixture.launchID,
        nonce: fixture.nonce,
        alias: fixture.alias,
        canonicalWorkdir: fixture.remoteWorkdir,
        targetID: fixture.targetID,
      }

      vi.useFakeTimers()
      try {
        stability = confirmReadyHandshakeStability(fixture.readyPath, identity)
        const stabilityResult = expect(stability).rejects.toThrow(
          /disappeared during the startup stability interval/i
        )

        await Promise.resolve()
        await expect(
          hooks.config?.({ experimental: { primary_tools: "task" } } as never)
        ).rejects.toThrow(/incompatible resolved OpenCode config/i)
        expect(await pathExists(fixture.readyPath)).toBe(false)

        await vi.advanceTimersByTimeAsync(READY_STABILITY_INTERVAL_MS)
        await stabilityResult
      } finally {
        await vi.runOnlyPendingTimersAsync()
        vi.useRealTimers()
        await stability?.catch(() => undefined)
      }
    } finally {
      vi.useRealTimers()
      await hooks?.dispose?.()
    }
  })

  it("rejects an enabled mcp.remote collision and removes prior readiness", async () => {
    const fixture = await createPluginFixture()
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(
        pluginInput(vi.fn()),
        pluginOptions(fixture)
      )
      await hooks.config?.({} as never)
      expect(await pathExists(fixture.readyPath)).toBe(true)

      await expect(
        hooks.config?.({
          mcp: {
            remote: {
              type: "remote",
              url: "https://mcp.invalid",
              enabled: true,
            },
          },
        } as never)
      ).rejects.toThrow(/enabled mcp\.remote.*remote_status/i)
      expect(await pathExists(fixture.readyPath)).toBe(false)
    } finally {
      await hooks?.dispose?.()
    }
  })

  it("settles a racing ready publication before disposal removes it", async () => {
    const fixture = await createPluginFixture()
    let hooks: Hooks | undefined

    try {
      hooks = await RemoteCodePlugin.server(pluginInput(vi.fn()), {
        ...pluginOptions(fixture),
      })
      const resolvedConfig: Record<string, unknown> = {}
      const configPromise = hooks.config!(resolvedConfig as never)
      const configResult = expect(configPromise).rejects.toThrow(
        /plugin lifecycle.*disposing|plugin lifecycle.*disposed/i
      )

      await Promise.resolve()
      await Promise.resolve()
      expect(resolvedConfig).toMatchObject({ subagent_depth: 1 })
      await hooks.dispose?.()
      await configResult
      expect(await pathExists(fixture.readyPath)).toBe(false)
    } finally {
      await hooks?.dispose?.()
    }
  })

  it("rejects non-event hook activity and ignores events after disposal", async () => {
    const fixture = await createPluginFixture()
    const sessionGet = vi.fn()
    const hooks = await RemoteCodePlugin.server(
      pluginInput(sessionGet),
      pluginOptions(fixture)
    )

    await hooks.dispose?.()
    await hooks.dispose?.()
    expect(await pathExists(fixture.readyPath)).toBe(false)

    await expect(hooks.config?.({} as never)).rejects.toThrow(
      /plugin lifecycle.*disposed/i
    )
    await expect(
      hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { info: { id: "session" } },
        } as never,
      })
    ).resolves.toBeUndefined()
    await expect(
      hooks.event?.({
        event: {
          type: "permission.asked",
          properties: {
            id: "disposed-permission",
            sessionID: "session",
            permission: "bash",
            patterns: ["*"],
          },
        } as never,
      })
    ).resolves.toBeUndefined()

    const output = { system: [] as string[] }
    await expect(
      hooks["experimental.chat.system.transform"]?.(
        { sessionID: "session", model: {} as never },
        output
      )
    ).rejects.toThrow(/plugin lifecycle.*disposed/i)
    expect(output.system).toEqual([])

    await expect(
      hooks["tool.execute.before"]!(
        { tool: "task", sessionID: "session", callID: "disposed-task" },
        { args: {} }
      )
    ).rejects.toThrow(/plugin lifecycle.*disposed/i)
    await expect(
      hooks.tool!.read.execute(
        { filePath: `${fixture.remoteWorkdir}/file.txt` },
        toolContext(vi.fn(async () => undefined))
      )
    ).rejects.toThrow(/plugin lifecycle.*disposed/i)
    expect(sessionGet).not.toHaveBeenCalled()
  })

  it("owns one active factory per launch and releases only its own completed disposal", async () => {
    const fixture = await createPluginFixture()
    let first: Hooks | undefined
    let replacement: Hooks | undefined
    let final: Hooks | undefined

    try {
      first = await RemoteCodePlugin.server(
        pluginInput(vi.fn()),
        pluginOptions(fixture)
      )
      const sentinel = path.join(fixture.mirrorRoot, "ownership-sentinel")
      await writeFile(sentinel, "preserve while owned\n", "utf8")
      const callsBeforeDuplicate = parseJsonLines<string[]>(
        await readFile(fixture.sshLog, "utf8")
      )

      await expect(
        RemoteCodePlugin.server(pluginInput(vi.fn()), pluginOptions(fixture))
      ).rejects.toThrow(/launch.*already.*active/i)
      expect(await readFile(sentinel, "utf8")).toBe("preserve while owned\n")
      expect(parseJsonLines<string[]>(await readFile(fixture.sshLog, "utf8"))).toEqual(
        callsBeforeDuplicate
      )

      await first.dispose?.()
      replacement = await RemoteCodePlugin.server(
        pluginInput(vi.fn()),
        pluginOptions(fixture)
      )
      expect(await pathExists(sentinel)).toBe(false)

      await first.dispose?.()
      await expect(
        RemoteCodePlugin.server(pluginInput(vi.fn()), pluginOptions(fixture))
      ).rejects.toThrow(/launch.*already.*active/i)

      await replacement.dispose?.()
      final = await RemoteCodePlugin.server(
        pluginInput(vi.fn()),
        pluginOptions(fixture)
      )
    } finally {
      await final?.dispose?.()
      await replacement?.dispose?.()
      await first?.dispose?.()
    }
  })

  it("releases launch ownership after initialization failure", async () => {
    const fixture = await createPluginFixture()
    const responses = JSON.parse(process.env.FAKE_SSH_RESPONSES!) as Array<{
      input: string
      stdout?: string
      exitCode?: number
    }>
    responses[0].exitCode = 17
    process.env.FAKE_SSH_RESPONSES = JSON.stringify(responses)

    await expect(
      RemoteCodePlugin.server(pluginInput(vi.fn()), pluginOptions(fixture))
    ).rejects.toThrow(/Remote uname failed/i)

    responses[0].exitCode = 0
    process.env.FAKE_SSH_RESPONSES = JSON.stringify(responses)
    const hooks = await RemoteCodePlugin.server(
      pluginInput(vi.fn()),
      pluginOptions(fixture)
    )
    await hooks.dispose?.()
  })

  it("does not claim production ownership in the compatibility-probe branch", async () => {
    const fixture = await createPluginFixture()
    const token = "b".repeat(64)
    const resultPath = path.join(path.dirname(fixture.readyPath), "probe-result.json")
    process.env[PROBE_ENV.token] = token
    process.env[PROBE_ENV.resultPath] = resultPath

    const probeHooks = await RemoteCodePlugin.server(
      pluginInput(vi.fn()),
      { launchID: fixture.launchID, compatibilityProbe: token }
    )
    await probeHooks.config?.({} as never)

    const productionHooks = await RemoteCodePlugin.server(
      pluginInput(vi.fn()),
      pluginOptions(fixture)
    )
    try {
      expect(await pathExists(resultPath)).toBe(true)
    } finally {
      await productionHooks.dispose?.()
    }
  })

  it("stays dormant without launcher context or for a mismatched plugin tuple", async () => {
    await expect(
      RemoteCodePlugin.server({} as never, { launchID: "inactive-launch" })
    ).resolves.toEqual({})

    const fixture = await createPluginFixture()
    await expect(
      RemoteCodePlugin.server({} as never, { launchID: "different-launch" })
    ).resolves.toEqual({})
    expect(await pathExists(fixture.readyPath)).toBe(false)
    expect(await pathExists(fixture.mirrorRoot)).toBe(false)
    expect(await pathExists(fixture.sshLog)).toBe(false)
  })
})

interface PluginFixture {
  alias: string
  expectedOpenCodeRuntimeVersion: string
  launchID: string
  mirrorRoot: string
  nonce: string
  readyPath: string
  remoteWorkdir: string
  socketPath: string
  sshLog: string
  sshInputLog: string
  targetID: string
}

async function createPluginFixture(
  expectedOpenCodeRuntimeVersion: string =
    TASK_RESUME_QUALIFIED_OPENCODE_VERSION
): Promise<PluginFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocssh-plugin-"))
  temporaryRoots.push(root)
  const alias = "fixture-host"
  const remoteWorkdir = "/srv/plugin workspace"
  const launchID = "plugin-registration-launch"
  const nonce = "fixture-ready-nonce-0123456789abcdef0123456789abcdef"
  const targetID = computeTargetID(alias, remoteWorkdir)
  const runtimeDir = path.join(root, "runtime")
  const stateDir = path.join(root, "state")
  const socketPath = path.join(runtimeDir, `${launchID}.sock`)
  const readyPath = path.join(stateDir, "ready.json")
  const mirrorRoot = path.join(root, "cache", "mirror")
  const sshLog = path.join(root, "ssh.jsonl")
  const sshInputLog = path.join(root, "ssh-input.jsonl")
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  await mkdir(stateDir, { recursive: true, mode: 0o700 })

  Object.assign(process.env, {
    [REMOTE_ENV.alias]: alias,
    [REMOTE_ENV.workdir]: remoteWorkdir,
    [REMOTE_ENV.socket]: socketPath,
    [REMOTE_ENV.targetID]: targetID,
    [REMOTE_ENV.launchID]: launchID,
    [REMOTE_ENV.readyPath]: readyPath,
    [REMOTE_ENV.readyNonce]: nonce,
    [REMOTE_ENV.runtimeDir]: runtimeDir,
    [REMOTE_ENV.mirrorRoot]: mirrorRoot,
    [REMOTE_ENV.expectedOpenCodeRuntimeVersion]:
      expectedOpenCodeRuntimeVersion,
    [REMOTE_ENV.sshBinary]: fakeSsh,
    [REMOTE_ENV.sftpBinary]: fakeSftp,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_INPUT_LOG: sshInputLog,
    FAKE_SSH_STDOUT: "Linux\n",
    FAKE_SSH_EXIT_CODE: "0",
    FAKE_SSH_FAIL_UNMATCHED: "1",
    FAKE_SSH_RESPONSES: JSON.stringify([
      { input: "uname -s", stdout: "Linux\n" },
      {
        input: `git -C '${remoteWorkdir}' rev-parse --is-inside-work-tree 2>/dev/null`,
        stdout: "true\n",
      },
      {
        input: `realpath -e -- '${remoteWorkdir}'`,
        stdout: `${remoteWorkdir}\n`,
      },
      {
        input: `cd '${remoteWorkdir}' || exit $?\nhostname; whoami; pwd -P`,
        stdout: `fixture-hostname\nfixture-user\n${remoteWorkdir}\n`,
      },
    ]),
  })

  return {
    alias,
    expectedOpenCodeRuntimeVersion,
    launchID,
    mirrorRoot,
    nonce,
    readyPath,
    remoteWorkdir,
    socketPath,
    sshInputLog,
    sshLog,
    targetID,
  }
}

function parseJsonLines<T>(contents: string): T[] {
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function toolContext(
  ask: ToolContext["ask"],
  sessionID = "session",
  agent = "build"
): ToolContext {
  return {
    sessionID,
    messageID: "message",
    agent,
    directory: "/workspace",
    worktree: "/workspace",
    abort: new AbortController().signal,
    metadata: () => {},
    ask,
  }
}

function pluginInput(
  sessionGet: unknown,
  runtimeVersion: string = TASK_RESUME_QUALIFIED_OPENCODE_VERSION,
  overrides: {
    legacyGet?: (request: LegacyHealthRequest) => unknown
    globalHealth?: (request: { signal: AbortSignal }) => unknown
  } = {}
): never {
  const legacyGet =
    overrides.legacyGet ??
    (async (request: LegacyHealthRequest) =>
      sdkHealthOutput(
        request,
        { data: { healthy: true, version: runtimeVersion } },
        200
      ))
  const transport = { get: legacyGet }
  const globalClient =
    overrides.globalHealth === undefined
      ? { _client: transport }
      : { _client: transport, health: overrides.globalHealth }
  return {
    client: {
      _client: transport,
      global: globalClient,
      session: { _client: transport, get: sessionGet },
    },
    serverUrl: new URL("http://127.0.0.1:4096"),
  } as never
}

interface LegacyHealthRequest {
  url: string
  signal: AbortSignal
}

interface SdkHealthOutput {
  data?: unknown
  error?: unknown
  request: Request
  response: Response
}

function sdkHealthOutput(
  request: LegacyHealthRequest,
  result: { data: unknown } | { error: unknown },
  status: number
): SdkHealthOutput {
  const body = "data" in result ? result.data : result.error
  return {
    ...result,
    request: new Request(
      new URL(request.url, "http://127.0.0.1:4096"),
      { signal: request.signal }
    ),
    response: new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  }
}

interface PluginLogRecord {
  timestamp: string
  level: "debug" | "info" | "warn" | "error"
  event: string
  pid: number
  fields?: Record<string, unknown>
}

function enablePluginLogging(fixture: PluginFixture): {
  logDirectory: string
  startupID: string
} {
  const logDirectory = path.join(path.dirname(fixture.readyPath), "plugin-logs")
  const startupID = "plugin-registration-startup"
  process.env[LOGGER_CHILD_ENV.directory] = logDirectory
  process.env[LOGGER_CHILD_ENV.startupID] = startupID
  return { logDirectory, startupID }
}

async function waitForPluginLogEvents(
  logDirectory: string,
  expectedEvents: readonly string[],
  timeoutMs = 2_000
): Promise<PluginLogRecord[]> {
  const logPath = resolveDailyLogFilePath({ logDirectory })
  const deadline = Date.now() + timeoutMs
  let records: PluginLogRecord[] = []
  while (Date.now() <= deadline) {
    let contents = ""
    try {
      contents = await readFile(logPath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    records = parseJsonLines<PluginLogRecord>(contents)
    if (
      expectedEvents.every((event) =>
        records.some((record) => record.event === event)
      )
    ) {
      return records
    }
    await delay(20)
  }
  throw new Error(
    `Timed out waiting for plugin log events ${JSON.stringify(expectedEvents)}; observed ${JSON.stringify(records.map((record) => record.event))}`
  )
}

function requirePluginLogEvent(
  records: readonly PluginLogRecord[],
  event: string
): PluginLogRecord {
  const record = records.find((candidate) => candidate.event === event)
  if (!record) throw new Error(`Missing plugin log event ${event}`)
  return record
}

function pluginOptions(
  fixture: PluginFixture,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    launchID: fixture.launchID,
    expectedOpenCodeRuntimeVersion:
      fixture.expectedOpenCodeRuntimeVersion,
    ...overrides,
  }
}

async function completePluginPreflight(
  tools: NonNullable<Hooks["tool"]>,
  ask: ToolContext["ask"],
  sessionID: string,
  agent: string
): Promise<void> {
  await tools.remote_status.execute({}, toolContext(ask, sessionID, agent))
  await tools.bash.execute(
    {
      command: "hostname; whoami; pwd -P",
      description: "Verify remote identity",
    },
    toolContext(ask, sessionID, agent)
  )
}

function taskResult(parentSessionId: string, sessionId: string) {
  return {
    title: "Task complete",
    output: "complete",
    metadata: {
      parentSessionId,
      sessionId,
      model: { providerID: "fixture", modelID: "fixture" },
    },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false
  )
}
