import type { PluginInput, ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { describe, expect, it, vi } from "vitest"
import {
  SessionSafety,
  createTaskGuard,
  createTaskHooks,
  guardProjectTool,
} from "../../src/session-safety.js"
import type { RemoteCommandResult } from "../../src/ssh/client.js"
import { TaskResumeRegistry } from "../../src/task-resume-registry.js"

const REMOTE_WORKDIR = "/srv/project"

describe("session preflight safety", () => {
  it("requires one validated remote_status result before project work", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)

    expect(() => safety.requirePreflight("root")).toThrow(/preflight/i)
    expect(() =>
      safety.beforeBash(toolContext({ sessionID: "root" }), "printf blocked")
    ).toThrow(/remote_status/i)

    recordStatus(safety, "root")
    expect(() => safety.requirePreflight("root")).not.toThrow()
    expect(
      safety.beforeBash(toolContext({ sessionID: "root" }), "printf ready")
    ).toMatchObject({ kind: "project" })

    expect(() => safety.requirePreflight("child")).toThrow(/preflight/i)
  })

  it.each([
    ["empty hostname", identityResult({ stdout: `\nremote-user\n${REMOTE_WORKDIR}\n` })],
    ["empty user", identityResult({ stdout: `remote-host\n \n${REMOTE_WORKDIR}\n` })],
    ["wrong workdir", identityResult({ stdout: "remote-host\nremote-user\n/srv/other\n" })],
    ["extra output", identityResult({ stdout: `noise\nremote-host\nremote-user\n${REMOTE_WORKDIR}\n` })],
    ["truncated stdout", identityResult({ stdoutTruncated: true })],
    ["truncated stderr", identityResult({ stderrTruncated: true })],
  ])("leaves preflight incomplete after %s", (_name, result) => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    const attempt = safety.beginStatusCheck("root")

    expect(() => safety.recordStatusResult("root", attempt, result)).toThrow(
      /remote_status preflight failed/i
    )
    expect(() => safety.requirePreflight("root")).toThrow(/preflight/i)
  })

  it("clears deleted session state without affecting another session", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "first")
    completePreflight(safety, "second")

    safety.clearSession("first")

    expect(() => safety.requirePreflight("first")).toThrow(/preflight/i)
    expect(() => safety.requirePreflight("second")).not.toThrow()
  })

  it("revokes preflight after an observed unhealthy status result", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")

    const attempt = safety.beginStatusCheck("root")
    safety.recordStatusResult("root", attempt, identityResult({ exitCode: 1 }))

    expect(() => safety.requirePreflight("root")).toThrow(/preflight/i)
    expect(() =>
      safety.beforeBash(toolContext({ sessionID: "root" }), "printf blocked")
    ).toThrow(/remote_status/i)
  })

  it("begins every status check by revoking prior preflight", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")

    safety.beginStatusCheck("root")

    expect(() => safety.requirePreflight("root")).toThrow(/preflight/i)
    expect(() =>
      safety.beforeBash(toolContext({ sessionID: "root" }), "printf blocked")
    ).toThrow(/remote_status/i)
  })

  it("rejects a status completion after clearSession and permits only a newer epoch", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    const staleAttempt = safety.beginStatusCheck("root")

    safety.clearSession("root")

    expect(() =>
      safety.recordStatusResult("root", staleAttempt, identityResult())
    ).toThrow(/stale|superseded/i)
    expect(() => safety.requirePreflight("root")).toThrow(/preflight/i)

    completePreflight(safety, "root")
    expect(() => safety.requirePreflight("root")).not.toThrow()
  })

  it("does not let an older status completion override a newer status attempt", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    const staleAttempt = safety.beginStatusCheck("root")
    const currentAttempt = safety.beginStatusCheck("root")
    safety.recordStatusResult("root", currentAttempt, identityResult())

    expect(() =>
      safety.recordStatusResult(
        "root",
        staleAttempt,
        identityResult({ exitCode: 1 })
      )
    ).toThrow(/stale|superseded/i)
    expect(() => safety.requirePreflight("root")).not.toThrow()
  })

  it("an invalid newer status cannot retain a previous completed preflight", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")

    const currentStatusAttempt = safety.beginStatusCheck("root")
    expect(() =>
      safety.recordStatusResult(
        "root",
        currentStatusAttempt,
        identityResult({ stdout: "remote-host\nremote-user\n/srv/wrong\n" })
      )
    ).toThrow(/remote_status preflight failed/i)
    expect(() => safety.requirePreflight("root")).toThrow(/preflight/i)

    recordStatus(safety, "root")
    expect(() => safety.requirePreflight("root")).not.toThrow()
  })

  it("permits custom Bash workdirs after completed preflight", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const root = toolContext({ sessionID: "root" })

    expect(safety.beforeBash(root, "pwd -P", "/srv/other")).toMatchObject({
      kind: "project",
    })
  })

  it("denies explore Bash after preflight while retaining project reads", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    recordStatus(safety, "explore-session")
    const explore = toolContext({ sessionID: "explore-session", agent: "explore" })

    expect(() => safety.beforeBash(explore, "printf mutation")).toThrow(
      /explore.*Bash/i
    )

    const execute = vi.fn(async () => ({ output: "read ok" }))
    const guarded = guardProjectTool(definition(execute), safety)
    await expect(guarded.execute({}, explore)).resolves.toMatchObject({
      output: "read ok",
    })
  })

  it("binds project admission to the completed preflight generation", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const admission = safety.admitProject("root")

    safety.beginStatusCheck("root")

    expect(() => safety.revalidateProject("root", admission)).toThrow(
      /project admission.*stale/i
    )
  })

  it("releases project leases idempotently and detaches them from later revocation", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const admission = safety.admitProject("root")
    const signal = safety.projectSignal("root", admission)

    safety.releaseProject("root", admission)
    safety.releaseProject("root", admission)
    safety.beginStatusCheck("root")

    expect(signal.aborted).toBe(false)
    expect(() => safety.revalidateProject("root", admission)).toThrow(
      /project admission.*stale/i
    )
  })

  it("clearSession aborts every active project lease", () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const first = safety.admitProject("root")
    const second = safety.admitProject("root")
    const firstSignal = safety.projectSignal("root", first)
    const secondSignal = safety.projectSignal("root", second)

    safety.clearSession("root")

    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal.aborted).toBe(true)
    expect(firstSignal.reason).toMatchObject({ name: "AbortError" })
    expect(secondSignal.reason).toBe(firstSignal.reason)
    expect(() => safety.releaseProject("root", first)).not.toThrow()
    expect(() => safety.releaseProject("root", second)).not.toThrow()
  })
})

describe("ordinary project tool guard", () => {
  it.each(["read", "write", "edit", "glob", "grep", "apply_patch"])(
    "rejects %s before its implementation can prepare permissions or remote access",
    async (_toolName) => {
      const safety = new SessionSafety(REMOTE_WORKDIR)
      const execute = vi.fn(async () => ({ output: "unexpected" }))
      const guarded = guardProjectTool(definition(execute), safety)

      await expect(guarded.execute({}, toolContext())).rejects.toThrow(/preflight/i)
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it("preserves schemas, descriptions, arguments, context, results, and this", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const args = { path: "file.txt" }
    const ctx = toolContext()
    const receiver = { marker: "receiver" }
    const original = {
      description: "original description",
      args: { path: { schema: true } },
      async execute(this: unknown, receivedArgs: unknown, receivedContext: unknown) {
        expect(this).toBe(receiver)
        expect(receivedArgs).toBe(args)
        expect(receivedContext).not.toBe(ctx)
        expect(receivedContext).toMatchObject({
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          agent: ctx.agent,
          metadata: ctx.metadata,
        })
        const guardedContext = receivedContext as ToolContext
        expect(guardedContext.abort).not.toBe(ctx.abort)
        expect(guardedContext.abort.aborted).toBe(false)
        await guardedContext.ask({
          permission: "edit",
          patterns: ["file.txt"],
          always: [],
          metadata: {},
        })
        return { title: "title", output: "output", metadata: { retained: true } }
      },
    } as unknown as ToolDefinition

    const guarded = guardProjectTool(original, safety)

    expect(guarded.description).toBe(original.description)
    expect(guarded.args).toBe(original.args)
    await expect(guarded.execute.call(receiver, args, ctx)).resolves.toEqual({
      title: "title",
      output: "output",
      metadata: { retained: true },
    })
    expect(ctx.ask).toHaveBeenCalledOnce()
  })

  it("stops guarded mutation after delayed approval crosses a newer status epoch", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const askStarted = deferred()
    const releaseAsk = deferred()
    const mutation = vi.fn()
    const ctx = toolContext()
    ctx.ask = vi.fn(async () => {
      askStarted.resolve()
      await releaseAsk.promise
    })
    const guarded = guardProjectTool(
      definition(async (_args, guardedContext) => {
        await guardedContext.ask({
          permission: "edit",
          patterns: ["file.txt"],
          always: [],
          metadata: {},
        })
        mutation()
        return { output: "mutated" }
      }),
      safety
    )

    const execution = guarded.execute({}, ctx)
    await askStarted.promise
    safety.beginStatusCheck("root")
    releaseAsk.resolve()

    await expect(execution).rejects.toThrow(/project admission.*stale/i)
    expect(mutation).not.toHaveBeenCalled()
  })

  it("aborts a guarded mutation lease when revocation follows approval", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const afterApproval = deferred()
    const releaseCommit = deferred()
    const mutation = vi.fn()
    let operationSignal: AbortSignal | undefined
    const guarded = guardProjectTool(
      definition(async (_args, guardedContext) => {
        await guardedContext.ask({
          permission: "edit",
          patterns: ["file.txt"],
          always: [],
          metadata: {},
        })
        operationSignal = guardedContext.abort
        afterApproval.resolve()
        await releaseCommit.promise
        guardedContext.abort.throwIfAborted()
        mutation()
        return { output: "mutated" }
      }),
      safety
    )

    const execution = guarded.execute({}, toolContext())
    await afterApproval.promise
    safety.beginStatusCheck("root")
    expect(operationSignal?.aborted).toBe(true)
    expect(operationSignal?.reason).toMatchObject({ name: "AbortError" })
    releaseCommit.resolve()

    await expect(execution).rejects.toMatchObject({ name: "AbortError" })
    expect(mutation).not.toHaveBeenCalled()

    completePreflight(safety, "root")
    const laterMutation = vi.fn()
    const later = guardProjectTool(
      definition(async (_args, guardedContext) => {
        await guardedContext.ask({
          permission: "edit",
          patterns: ["later.txt"],
          always: [],
          metadata: {},
        })
        guardedContext.abort.throwIfAborted()
        laterMutation()
        return { output: "mutated later" }
      }),
      safety
    )
    await expect(later.execute({}, toolContext())).resolves.toMatchObject({
      output: "mutated later",
    })
    expect(laterMutation).toHaveBeenCalledOnce()
  })
})

describe("direct Task runtime guard", () => {
  it("allows a fully preflighted root with no session ask rules", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const get = sessionLookup({ id: "root", permission: [] })
    const guard = createTaskGuard(client(get), safety)

    await expect(runTaskGuard(guard, "root", {})).resolves.toBeUndefined()
    expect(get).toHaveBeenCalledWith({ path: { id: "root" } })
  })

  it("fails closed when the caller lookup throws", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const lookupFailure = new Error("session service unavailable")
    const get = vi.fn(async () => {
      throw lookupFailure
    })

    await expect(
      runTaskGuard(createTaskGuard(client(get), safety), "root", {})
    ).rejects.toThrow(/session lookup failed/i)
  })

  it.each([
    ["missing response", undefined],
    ["missing data", {}],
    ["reported error", { error: { message: "not found" } }],
    ["mismatched ID", { data: { id: "other" } }],
    ["invalid parent", { data: { id: "root", parentID: null } }],
    ["null permissions", { data: { id: "root", permission: null } }],
    ["invalid permissions", { data: { id: "root", permission: "ask" } }],
    [
      "invalid permission rule",
      {
        data: {
          id: "root",
          permission: [{ permission: "bash", pattern: "*", action: "sometimes" }],
        },
      },
    ],
  ])("fails closed for structurally invalid lookup result: %s", async (_name, response) => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const get = vi.fn(async () => response)

    await expect(
      runTaskGuard(createTaskGuard(client(get), safety), "root", {})
    ).rejects.toThrow(/invalid session lookup response/i)
  })

  it("rejects a caller session with a parent even after child preflight", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "child")
    const guard = createTaskGuard(
      client(sessionLookup({ id: "child", parentID: "root", permission: [] })),
      safety
    )

    await expect(runTaskGuard(guard, "child", {})).rejects.toThrow(
      /direct child.*Task|Task.*root session/i
    )
  })

  it("rejects Task before root preflight", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    const guard = createTaskGuard(
      client(sessionLookup({ id: "root", permission: [] })),
      safety
    )

    await expect(runTaskGuard(guard, "root", {})).rejects.toThrow(/preflight/i)
  })

  it("normalizes an omitted caller root permission array", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const guard = createTaskGuard(client(sessionLookup({ id: "root" })), safety)

    await expect(runTaskGuard(guard, "root", {})).resolves.toBeUndefined()
  })

  it("reports an omitted root permission once without affecting admission", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const onRootPermissionNormalized = vi.fn(() => {
      throw new Error("diagnostic unavailable")
    })
    const hooks = createTaskHooks(
      client(sessionLookup({ id: "root" })),
      safety,
      false,
      undefined,
      {
        onRootPermissionNormalized,
      }
    )

    await expect(
      runTaskBefore(hooks, "root", { subagent_type: "general" }, "first")
    ).resolves.toBeUndefined()
    await expect(
      runTaskBefore(hooks, "root", { subagent_type: "explore" }, "second")
    ).resolves.toBeUndefined()
    expect(onRootPermissionNormalized).toHaveBeenCalledOnce()
  })

  it("reports task_id resume as unavailable without launcher capability", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const guard = createTaskGuard(
      client(sessionLookup({ id: "root", permission: [] })),
      safety
    )

    await expect(runTaskGuard(guard, "root", { task_id: "" })).rejects.toThrow(
      /resume capability.*not established.*launch/i
    )
  })

  it("rejects background Task", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const guard = createTaskGuard(
      client(sessionLookup({ id: "root", permission: [] })),
      safety
    )

    await expect(runTaskGuard(guard, "root", { background: true })).rejects.toThrow(
      /background.*unsupported/i
    )
  })

  it.each([
    "remote_status",
    "bash",
    "read",
    "edit",
    "glob",
    "grep",
    "external_directory",
    "*",
    "remote_*",
  ])("rejects a parent session ask matching project permission %s", async (permission) => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const guard = createTaskGuard(
      client(
        sessionLookup({
          id: "root",
          permission: [{ permission, pattern: "*", action: "ask" }],
        })
      ),
      safety
    )

    await expect(runTaskGuard(guard, "root", {})).rejects.toThrow(
      /OpenCode 1\.18\.18.*global or agent-level/i
    )
  })

  it("does not weaken or reject explicit inherited denies", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const guard = createTaskGuard(
      client(
        sessionLookup({
          id: "root",
          permission: [
            { permission: "remote_status", pattern: "*", action: "deny" },
            { permission: "bash", pattern: "*", action: "allow" },
          ],
        })
      ),
      safety
    )

    await expect(runTaskGuard(guard, "root", {})).resolves.toBeUndefined()
  })

  it("ignores non-Task tools without looking up a session", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    const get = sessionLookup({ id: "root" })
    const guard = createTaskGuard(client(get), safety)

    await expect(
      guard(
        { tool: "read", sessionID: "root", callID: "call" },
        { args: {} }
      )
    ).resolves.toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  })
})

describe("safe same-launch Task resume", () => {
  it("reports classified resume failures without exposing error details to diagnostics", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const onTaskResumeFailure = vi.fn(() => {
      throw new Error("diagnostic unavailable")
    })
    const hooks = createTaskHooks(
      client(sessionLookup({ id: "root", permission: [] })),
      safety,
      true,
      new TaskResumeRegistry(),
      { onTaskResumeFailure }
    )

    await expect(
      runTaskBefore(
        hooks,
        "root",
        resumeArgs({ task_id: "session lookup failed permission changed" }),
        "resume-failure"
      )
    ).rejects.toThrow(/not registered for this launch/i)
    expect(onTaskResumeFailure).toHaveBeenCalledExactlyOnceWith({
      stage: "admission",
      reason: "not-registered",
    })
  })

  it("registers a completed direct child, revokes its preflight, and releases successful sequential resumes", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    completePreflight(safety, "child")
    const sessions = taskSessions()
    const get = mutableSessionLookup(sessions)
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(client(get), safety, true, registry)

    await registerFreshTask(hooks, "root", "child")
    await runTaskBefore(hooks, "root", resumeArgs(), "resume-1")

    expect(() => safety.requirePreflight("child")).toThrow(/preflight/i)
    expect(registry.inspect("child")).toMatchObject({
      state: "reserved",
      activeCallID: "resume-1",
    })

    completePreflight(safety, "child")
    await runTaskAfter(
      hooks,
      "root",
      resumeArgs(),
      successfulTaskResult("root", "child"),
      "resume-1"
    )
    expect(registry.inspect("child")?.state).toBe("ready")

    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "resume-2")
    ).resolves.toBeUndefined()
    expect(registry.inspect("child")).toMatchObject({
      state: "reserved",
      activeCallID: "resume-2",
    })
  })

  it("keeps resume locked until the child completes a new preflight", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(sessions)),
      safety,
      true,
      registry
    )
    await registerFreshTask(hooks, "root", "child")
    await runTaskBefore(hooks, "root", resumeArgs(), "missing-child-preflight")

    await expect(
      runTaskAfter(
        hooks,
        "root",
        resumeArgs(),
        successfulTaskResult("root", "child"),
        "missing-child-preflight"
      )
    ).rejects.toThrow(/preflight/i)
    expect(registry.inspect("child")?.state).toBe("reserved")
  })

  it("rejects empty, unknown, foreign-root, requested-agent, observed-agent, parent, and permission mismatches before Task execution", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    completePreflight(safety, "other-root")
    const sessions = taskSessions()
    sessions.set("other-root", { id: "other-root", permission: [] })
    const get = mutableSessionLookup(sessions)
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(client(get), safety, true, registry)
    await registerFreshTask(hooks, "root", "child")

    await expect(
      runTaskBefore(hooks, "root", resumeArgs({ task_id: "" }), "empty")
    ).rejects.toThrow(/non-empty task_id/i)
    await expect(
      runTaskBefore(
        hooks,
        "root",
        resumeArgs({ task_id: "unknown" }),
        "unknown"
      )
    ).rejects.toThrow(/not registered for this launch/i)
    await expect(
      runTaskBefore(hooks, "other-root", resumeArgs(), "foreign")
    ).rejects.toThrow(/caller root/i)
    await expect(
      runTaskBefore(
        hooks,
        "root",
        resumeArgs({ subagent_type: "explore" }),
        "wrong-requested-agent"
      )
    ).rejects.toThrow(/subagent_type.*exactly match/i)

    sessions.set("child", childSession({ agent: "explore" }))
    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "wrong-observed-agent")
    ).rejects.toThrow(/session agent.*subagent_type/i)

    sessions.set("child", childSession({ agent: undefined }))
    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "missing-observed-agent")
    ).rejects.toThrow(/session agent.*explicit.*subagent_type/i)

    sessions.set("child", childSession({ permission: undefined }))
    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "missing-target-permission")
    ).rejects.toThrow(/resume target.*explicit permission array/i)

    sessions.set("child", childSession({ parentID: "other-root" }))
    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "wrong-parent")
    ).rejects.toThrow(/not the registered direct child/i)

    sessions.set(
      "child",
      childSession({
        permission: [
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "allow" },
        ],
      })
    )
    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "changed-permissions")
    ).rejects.toThrow(/permissions changed/i)
    expect(registry.inspect("child")?.state).toBe("ready")
  })

  it("makes the READY to RESERVED transition atomic after overlapping target validation", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    let overlap = false
    let childLookups = 0
    let releaseLookups: (() => void) | undefined
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookups = resolve
    })
    const get = mutableSessionLookup(sessions, async (sessionID) => {
      if (!overlap || sessionID !== "child") return
      childLookups++
      if (childLookups === 2) releaseLookups!()
      await lookupGate
    })
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(client(get), safety, true, registry)
    await registerFreshTask(hooks, "root", "child")
    overlap = true

    const results = await Promise.allSettled([
      runTaskBefore(hooks, "root", resumeArgs(), "concurrent-1"),
      runTaskBefore(hooks, "root", resumeArgs(), "concurrent-2"),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const failure = results.find((result) => result.status === "rejected")
    expect(failure).toBeDefined()
    expect(String((failure as PromiseRejectedResult).reason)).toMatch(
      /reserved|uncertain/i
    )
    expect(registry.inspect("child")?.state).toBe("reserved")
  })

  it("rejects child permission changes while the owner lookup is delayed", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    const ownerLookupStarted = deferred()
    const releaseOwnerLookup = deferred()
    let delayOwnerLookup = false
    let ownerLookups = 0
    const get = mutableSessionLookup(sessions, async (sessionID) => {
      if (!delayOwnerLookup || sessionID !== "root") return
      ownerLookups++
      if (ownerLookups !== 2) return
      ownerLookupStarted.resolve()
      await releaseOwnerLookup.promise
    })
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(client(get), safety, true, registry)
    await registerFreshTask(hooks, "root", "child")
    hooks.observePermissionRequest({
      sessionID: "child",
      permissionID: "child-read-change",
      permission: "read",
    })
    delayOwnerLookup = true

    const admission = runTaskBefore(
      hooks,
      "root",
      resumeArgs(),
      "child-change-during-owner-lookup"
    )
    await ownerLookupStarted.promise
    sessions.set(
      "child",
      childSession({
        permission: [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "read", pattern: "*", action: "deny" },
        ],
      })
    )
    hooks.observePermissionReply({
      sessionID: "child",
      permissionID: "child-read-change",
    })
    releaseOwnerLookup.resolve()

    await expect(admission).rejects.toThrow(/security evidence changed/i)
    expect(registry.inspect("child")?.state).toBe("ready")
  })

  it.each([
    [
      "permissions",
      {
        id: "root",
        permission: [{ permission: "read", pattern: "*", action: "allow" }],
      },
      /root session permissions changed/i,
    ],
    [
      "topology",
      { id: "root", parentID: "other-root", permission: [] },
      /limited to root sessions/i,
    ],
    [
      "incompatible ask rules",
      {
        id: "root",
        permission: [{ permission: "bash", pattern: "*", action: "ask" }],
      },
      /does not inherit session ask rules/i,
    ],
  ] as const)(
    "revalidates root %s after a delayed target lookup before reservation",
    async (_name, changedRoot, expectedError) => {
      const safety = new SessionSafety(REMOTE_WORKDIR)
      completePreflight(safety, "root")
      const sessions = taskSessions()
      const lookupStarted = deferred()
      const releaseLookup = deferred()
      let delayChildLookup = false
      const get = mutableSessionLookup(sessions, async (sessionID) => {
        if (!delayChildLookup || sessionID !== "child") return
        lookupStarted.resolve()
        await releaseLookup.promise
      })
      const registry = new TaskResumeRegistry()
      const hooks = createTaskHooks(client(get), safety, true, registry)
      await registerFreshTask(hooks, "root", "child")
      delayChildLookup = true

      const admission = runTaskBefore(
        hooks,
        "root",
        resumeArgs(),
        `changed-root-${_name}`
      )
      await lookupStarted.promise
      sessions.set("root", { ...changedRoot })
      releaseLookup.resolve()

      await expect(admission).rejects.toThrow(expectedError)
      expect(registry.inspect("child")?.state).toBe("ready")
    }
  )

  it.each([
    [
      "permissions",
      {
        id: "root",
        permission: [{ permission: "read", pattern: "*", action: "allow" }],
      },
      /root session permissions changed/i,
    ],
    [
      "topology",
      { id: "root", parentID: "other-root", permission: [] },
      /limited to root sessions/i,
    ],
    [
      "incompatible ask rules",
      {
        id: "root",
        permission: [{ permission: "bash", pattern: "*", action: "ask" }],
      },
      /does not inherit session ask rules/i,
    ],
  ] as const)(
    "keeps the child locked when root %s changes during delayed release validation",
    async (_name, changedRoot, expectedError) => {
      const safety = new SessionSafety(REMOTE_WORKDIR)
      completePreflight(safety, "root")
      const sessions = taskSessions()
      const lookupStarted = deferred()
      const releaseLookup = deferred()
      let delayChildLookup = false
      const get = mutableSessionLookup(sessions, async (sessionID) => {
        if (!delayChildLookup || sessionID !== "child") return
        lookupStarted.resolve()
        await releaseLookup.promise
      })
      const registry = new TaskResumeRegistry()
      const hooks = createTaskHooks(client(get), safety, true, registry)
      await registerFreshTask(hooks, "root", "child")
      await runTaskBefore(hooks, "root", resumeArgs(), `release-${_name}`)
      delayChildLookup = true

      const completion = runTaskAfter(
        hooks,
        "root",
        resumeArgs(),
        successfulTaskResult("root", "child"),
        `release-${_name}`
      )
      await lookupStarted.promise
      sessions.set("root", { ...changedRoot })
      releaseLookup.resolve()

      await expect(completion).rejects.toThrow(expectedError)
      expect(registry.inspect("child")?.state).toBe("reserved")
      sessions.set("root", { id: "root", permission: [] })
      await expect(
        runTaskBefore(hooks, "root", resumeArgs(), `retry-${_name}`)
      ).rejects.toThrow(/reserved|uncertain/i)
    }
  )

  it("leaves a reservation locked when the after-hook is missing or upstream reports no successful result", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(sessions)),
      safety,
      true,
      registry
    )
    await registerFreshTask(hooks, "root", "child")

    await runTaskBefore(hooks, "root", resumeArgs(), "missing-after")
    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "blocked-after-missing")
    ).rejects.toThrow(/reserved|uncertain/i)

    const secondSafety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(secondSafety, "root")
    const secondRegistry = new TaskResumeRegistry()
    const onTaskResumeFailure = vi.fn()
    const secondHooks = createTaskHooks(
      client(mutableSessionLookup(sessions)),
      secondSafety,
      true,
      secondRegistry,
      { onTaskResumeFailure }
    )
    await registerFreshTask(secondHooks, "root", "child")
    await runTaskBefore(secondHooks, "root", resumeArgs(), "failed-upstream")
    await runTaskAfter(
      secondHooks,
      "root",
      resumeArgs(),
      undefined,
      "failed-upstream"
    )
    expect(secondRegistry.inspect("child")?.state).toBe("reserved")
    expect(onTaskResumeFailure).toHaveBeenCalledExactlyOnceWith({
      stage: "completion",
      reason: "missing-output",
    })
  })

  it("keeps the child locked after malformed metadata or failed post-resume validation", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(sessions)),
      safety,
      true,
      registry
    )
    await registerFreshTask(hooks, "root", "child")
    await runTaskBefore(hooks, "root", resumeArgs(), "malformed-resume")

    await expect(
      runTaskAfter(
        hooks,
        "root",
        resumeArgs(),
        { title: "Task", output: "complete", metadata: { sessionId: "child" } },
        "malformed-resume"
      )
    ).rejects.toThrow(/malformed.*parentSessionId.*sessionId/i)
    expect(registry.inspect("child")?.state).toBe("reserved")

    const secondSafety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(secondSafety, "root")
    const secondSessions = taskSessions()
    const secondRegistry = new TaskResumeRegistry()
    const secondHooks = createTaskHooks(
      client(mutableSessionLookup(secondSessions)),
      secondSafety,
      true,
      secondRegistry
    )
    await registerFreshTask(secondHooks, "root", "child")
    await runTaskBefore(secondHooks, "root", resumeArgs(), "changed-after")
    secondSessions.set("child", childSession({ permission: [] }))
    await expect(
      runTaskAfter(
        secondHooks,
        "root",
        resumeArgs(),
        successfulTaskResult("root", "child"),
        "changed-after"
      )
    ).rejects.toThrow(/permissions changed/i)
    expect(secondRegistry.inspect("child")?.state).toBe("reserved")
  })

  it.each([
    ["agent", { agent: undefined }, /session agent.*explicit.*subagent_type/i],
    [
      "permission",
      { permission: undefined },
      /resume target.*explicit permission array/i,
    ],
  ] as const)(
    "keeps the child locked when post-resume target %s is missing",
    async (_name, targetOverride, expectedError) => {
      const safety = new SessionSafety(REMOTE_WORKDIR)
      completePreflight(safety, "root")
      const sessions = taskSessions()
      const registry = new TaskResumeRegistry()
      const hooks = createTaskHooks(
        client(mutableSessionLookup(sessions)),
        safety,
        true,
        registry
      )
      await registerFreshTask(hooks, "root", "child")
      await runTaskBefore(hooks, "root", resumeArgs(), `missing-${_name}`)
      sessions.set("child", childSession({ ...targetOverride }))

      await expect(
        runTaskAfter(
          hooks,
          "root",
          resumeArgs(),
          successfulTaskResult("root", "child"),
          `missing-${_name}`
        )
      ).rejects.toThrow(expectedError)
      expect(registry.inspect("child")?.state).toBe("reserved")
    }
  )

  it("fails explicitly for malformed fresh Task metadata without registering a child", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(sessions)),
      safety,
      true,
      registry
    )
    const args = { subagent_type: "general" }
    await runTaskBefore(hooks, "root", args, "fresh-malformed")

    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        { title: "Task", output: "complete", metadata: { parentSessionId: "root" } },
        "fresh-malformed"
      )
    ).rejects.toThrow(/malformed.*parentSessionId.*sessionId/i)
    expect(registry.inspect("child")).toBeUndefined()
    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-malformed"
      )
    ).rejects.toThrow(/no active admission|replay/i)
  })

  it("consumes a fresh admission when upstream reports no result", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(taskSessions())),
      safety,
      true,
      registry
    )
    const args = { subagent_type: "general" }
    await runTaskBefore(hooks, "root", args, "fresh-missing-result")
    await runTaskAfter(hooks, "root", args, undefined, "fresh-missing-result")

    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-missing-result"
      )
    ).rejects.toThrow(/no active admission|replay/i)
    expect(registry.inspect("child")).toBeUndefined()
  })

  it("does not treat the built-in Task permission as SSH-project evidence", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(taskSessions())),
      safety,
      true,
      registry
    )
    const args = { subagent_type: "general" }
    await runTaskBefore(hooks, "root", args, "fresh-task-permission")
    hooks.observePermissionRequest({
      sessionID: "root",
      permissionID: "task-permission",
      permission: "task",
    })
    hooks.observePermissionReply({
      sessionID: "root",
      permissionID: "task-permission",
    })

    await runTaskAfter(
      hooks,
      "root",
      args,
      successfulTaskResult("root", "child"),
      "fresh-task-permission"
    )
    expect(registry.inspect("child")?.state).toBe("ready")
  })

  it("rejects fresh registration when a root read deny is added during child creation", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(sessions)),
      safety,
      true,
      registry
    )
    const args = { subagent_type: "general" }
    await runTaskBefore(hooks, "root", args, "fresh-root-deny-change")
    sessions.set("root", {
      id: "root",
      permission: [{ permission: "read", pattern: "*", action: "deny" }],
    })
    hooks.observePermissionRequest({
      sessionID: "root",
      permissionID: "root-read-change",
      permission: "read",
    })

    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-root-deny-change"
      )
    ).rejects.toThrow(/root security permissions changed|security evidence changed/i)
    expect(registry.inspect("child")).toBeUndefined()
    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "unavailable-after-root-change")
    ).rejects.toThrow(/not registered for this launch/i)
    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-root-deny-change"
      )
    ).rejects.toThrow(/no active admission|replay/i)
  })

  it("requires exact inherited root denies while retaining stricter child policy", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    sessions.set("root", {
      id: "root",
      permission: [{ permission: "read", pattern: "*", action: "deny" }],
    })
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(sessions)),
      safety,
      true,
      registry
    )
    const args = { subagent_type: "general" }
    await runTaskBefore(hooks, "root", args, "fresh-missing-inherited-deny")
    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-missing-inherited-deny"
      )
    ).rejects.toThrow(/exact inherited root deny/i)
    expect(registry.inspect("child")).toBeUndefined()

    sessions.set(
      "child",
      childSession({
        permission: [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "read", pattern: "*", action: "deny" },
          { permission: "glob", pattern: "secret/**", action: "deny" },
        ],
      })
    )
    await runTaskBefore(hooks, "root", args, "fresh-preserved-inherited-deny")
    await runTaskAfter(
      hooks,
      "root",
      args,
      successfulTaskResult("root", "child"),
      "fresh-preserved-inherited-deny"
    )
    expect(registry.inspect("child")?.state).toBe("ready")
  })

  it.each([
    [
      "topology",
      { id: "root", parentID: "other-root", permission: [] },
      /limited to root sessions/i,
    ],
    [
      "permissions",
      {
        id: "root",
        permission: [{ permission: "read", pattern: "*", action: "deny" }],
      },
      /security permissions changed/i,
    ],
    [
      "incompatible ask rules",
      {
        id: "root",
        permission: [{ permission: "bash", pattern: "*", action: "ask" }],
      },
      /does not inherit session ask rules/i,
    ],
  ] as const)(
    "revalidates fresh Task root %s after delayed target lookup",
    async (_name, changedRoot, expectedError) => {
      const safety = new SessionSafety(REMOTE_WORKDIR)
      completePreflight(safety, "root")
      const sessions = taskSessions()
      const lookupStarted = deferred()
      const releaseLookup = deferred()
      let delayChildLookup = false
      const get = mutableSessionLookup(sessions, async (sessionID) => {
        if (!delayChildLookup || sessionID !== "child") return
        lookupStarted.resolve()
        await releaseLookup.promise
      })
      const registry = new TaskResumeRegistry()
      const hooks = createTaskHooks(client(get), safety, true, registry)
      const args = { subagent_type: "general" }
      await runTaskBefore(hooks, "root", args, `fresh-root-${_name}`)
      delayChildLookup = true

      const registration = runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        `fresh-root-${_name}`
      )
      await lookupStarted.promise
      sessions.set("root", { ...changedRoot })
      releaseLookup.resolve()

      await expect(registration).rejects.toThrow(expectedError)
      expect(registry.inspect("child")).toBeUndefined()
    }
  )

  it("registers only a fresh child with exact direct ownership and observed agent", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const sessions = taskSessions()
    sessions.set("child", childSession({ parentID: "other-root" }))
    const registry = new TaskResumeRegistry()
    const hooks = createTaskHooks(
      client(mutableSessionLookup(sessions)),
      safety,
      true,
      registry
    )
    const args = { subagent_type: "general" }
    await runTaskBefore(hooks, "root", args, "fresh-wrong-parent")
    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-wrong-parent"
      )
    ).rejects.toThrow(/not directly owned by the caller root/i)
    expect(registry.inspect("child")).toBeUndefined()

    sessions.set("child", childSession({ agent: "explore" }))
    await runTaskBefore(hooks, "root", args, "fresh-wrong-agent")
    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-wrong-agent"
      )
    ).rejects.toThrow(/observed child agent.*subagent_type/i)
    expect(registry.inspect("child")).toBeUndefined()

    sessions.set("child", childSession({ agent: undefined }))
    await runTaskBefore(hooks, "root", args, "fresh-missing-agent")
    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-missing-agent"
      )
    ).rejects.toThrow(/observed child agent.*explicit.*subagent_type/i)
    expect(registry.inspect("child")).toBeUndefined()

    sessions.set("child", childSession({ permission: undefined }))
    await runTaskBefore(hooks, "root", args, "fresh-missing-permission")
    await expect(
      runTaskAfter(
        hooks,
        "root",
        args,
        successfulTaskResult("root", "child"),
        "fresh-missing-permission"
      )
    ).rejects.toThrow(/fresh Task child.*explicit permission array/i)
    expect(registry.inspect("child")).toBeUndefined()
  })

  it("keeps fresh Task enabled but clearly denies every task_id when resume capability is disabled", async () => {
    const safety = new SessionSafety(REMOTE_WORKDIR)
    completePreflight(safety, "root")
    const get = mutableSessionLookup(taskSessions())
    const hooks = createTaskHooks(client(get), safety, false)

    await expect(
      runTaskBefore(hooks, "root", { subagent_type: "general" }, "fresh")
    ).resolves.toBeUndefined()
    await expect(
      runTaskBefore(hooks, "root", resumeArgs(), "disabled-resume")
    ).rejects.toThrow(/resume capability.*not established.*launch/i)
    await expect(
      runTaskAfter(
        hooks,
        "root",
        { subagent_type: "general" },
        { title: "malformed", output: "ignored", metadata: {} },
        "fresh"
      )
    ).resolves.toBeUndefined()
  })
})

type TaskGuard = ReturnType<typeof createTaskGuard>
type TaskHooksFixture = ReturnType<typeof createTaskHooks>

function completePreflight(safety: SessionSafety, sessionID: string): void {
  recordStatus(safety, sessionID)
}

function recordStatus(safety: SessionSafety, sessionID: string): void {
  const attempt = safety.beginStatusCheck(sessionID)
  safety.recordStatusResult(sessionID, attempt, identityResult())
}

function identityResult(
  overrides: Partial<RemoteCommandResult> = {}
): RemoteCommandResult {
  return {
    stdout: `remote-host\nremote-user\n${REMOTE_WORKDIR}\n`,
    stderr: "",
    exitCode: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  }
}

function toolContext(
  overrides: Partial<Pick<ToolContext, "sessionID" | "agent">> = {}
): ToolContext {
  return {
    sessionID: overrides.sessionID ?? "root",
    messageID: "message",
    agent: overrides.agent ?? "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: vi.fn(async () => undefined),
  }
}

function definition(
  execute: ToolDefinition["execute"]
): ToolDefinition {
  return {
    description: "fixture tool",
    args: {},
    execute,
  }
}

function sessionLookup(data: unknown) {
  return vi.fn(async () => ({ data }))
}

function client(get: unknown): PluginInput["client"] {
  return { session: { get } } as unknown as PluginInput["client"]
}

function runTaskGuard(
  guard: TaskGuard,
  sessionID: string,
  args: Record<string, unknown>
): Promise<void> {
  return guard(
    { tool: "task", sessionID, callID: "call" },
    { args }
  )
}

function taskSessions(): Map<string, Record<string, unknown>> {
  return new Map([
    ["root", { id: "root", permission: [] }],
    ["child", childSession()],
  ])
}

function childSession(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "child",
    parentID: "root",
    agent: "general",
    permission: [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*", action: "allow" },
    ],
    ...overrides,
  }
}

function mutableSessionLookup(
  sessions: Map<string, Record<string, unknown>>,
  beforeReturn?: (sessionID: string) => Promise<void>
) {
  return vi.fn(async (request: { path: { id: string } }) => {
    await beforeReturn?.(request.path.id)
    const data = sessions.get(request.path.id)
    return data === undefined
      ? { error: { message: "session not found" } }
      : { data }
  })
}

async function registerFreshTask(
  hooks: TaskHooksFixture,
  rootID: string,
  childID: string
): Promise<void> {
  const args = { subagent_type: "general" }
  await runTaskBefore(hooks, rootID, args, `fresh-${childID}`)
  await runTaskAfter(
    hooks,
    rootID,
    args,
    successfulTaskResult(rootID, childID),
    `fresh-${childID}`
  )
}

function resumeArgs(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    task_id: "child",
    subagent_type: "general",
    ...overrides,
  }
}

function successfulTaskResult(parentSessionID: string, sessionID: string) {
  return {
    title: "Task complete",
    output: "complete",
    metadata: {
      parentSessionId: parentSessionID,
      sessionId: sessionID,
      model: { providerID: "fixture", modelID: "fixture" },
    },
  }
}

function runTaskBefore(
  hooks: TaskHooksFixture,
  sessionID: string,
  args: Record<string, unknown>,
  callID: string
): Promise<void> {
  return hooks.before({ tool: "task", sessionID, callID }, { args })
}

function runTaskAfter(
  hooks: TaskHooksFixture,
  sessionID: string,
  args: Record<string, unknown>,
  output: unknown,
  callID: string
): Promise<void> {
  return hooks.after(
    { tool: "task", sessionID, callID, args },
    output as Parameters<TaskHooksFixture["after"]>[1]
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
