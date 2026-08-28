import type { ToolContext } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { ProcessResult } from "../../src/process.js"
import type { RemotePathResolver } from "../../src/remote-path-resolver.js"
import {
  IDENTITY_COMMAND,
  SessionSafety,
  type ProjectAdmissionToken,
} from "../../src/session-safety.js"
import type { SSHPool } from "../../src/ssh-pool.js"
import {
  SshClientError,
  type ExecOptions,
  type RemoteCommandResult,
} from "../../src/ssh/client.js"
import { createBashTool, type BashSafety } from "../../src/tools/bash.js"

describe("remote bash tool", () => {
  it("publishes split UTF-8 output before completion and preserves model output", async () => {
    const gate = deferred()
    const updates: MetadataUpdate[] = []
    const stdout = Buffer.from("A€B")
    const pool = {
      async exec(_command: string, options?: ExecOptions): Promise<RemoteCommandResult> {
        options?.onStdout?.(stdout.subarray(0, 2))
        options?.onStderr?.(Buffer.from("warning"))
        options?.onStdout?.(stdout.subarray(2))
        await gate.promise
        return result({ stdout: "A€B", stderr: "warning" })
      },
    } as SSHPool
    let settled = false
    const execution = createBashTool(
      pool,
      "/srv/project",
      resolver(),
      unrestrictedSafety()
    ).execute(
      { command: "run", description: "Streaming command" },
      context(updates)
    )
    void execution.finally(() => {
      settled = true
    })

    await vi.waitFor(() => {
      expect(updates.some((update) => metadata(update).output !== "")).toBe(true)
    })
    expect(settled).toBe(false)

    gate.resolve()
    const response = await execution
    expect(metadata(response).output).toBe("Awarning€B")
    expect(toolOutput(response)).toBe("A€B\n\nstderr:\nwarning")
  })

  it("coalesces rapid output without overlapping metadata publications", async () => {
    const gate = deferred()
    const chunks = Array.from({ length: 20 }, (_, index) => `[${index}]`)
    const terminalOutput = chunks.join("")
    const updates: MetadataUpdate[] = []
    let activePublications = 0
    let maximumActivePublications = 0
    const ctx = context([])
    ctx.metadata = vi.fn((update) =>
      Effect.promise(async () => {
        activePublications += 1
        maximumActivePublications = Math.max(
          maximumActivePublications,
          activePublications
        )
        updates.push(update)
        try {
          await sleep(25)
        } finally {
          activePublications -= 1
        }
      })
    )
    const pool = {
      async exec(_command: string, options?: ExecOptions): Promise<RemoteCommandResult> {
        for (const chunk of chunks) options?.onStdout?.(Buffer.from(chunk))
        await gate.promise
        return result({ stdout: terminalOutput })
      },
    } as SSHPool

    const execution = createBashTool(
      pool,
      "/srv/project",
      resolver(),
      unrestrictedSafety()
    ).execute(
      { command: "burst", description: "Burst command" },
      ctx
    )
    await vi.waitFor(() => {
      expect(
        updates.some((update) => metadata(update).output === terminalOutput)
      ).toBe(true)
    })
    expect(updates.length).toBeLessThan(chunks.length)
    expect(maximumActivePublications).toBe(1)

    gate.resolve()
    const response = await execution
    expect(metadata(response).output).toBe(terminalOutput)
    expect(metadata(updates.at(-1)!).output).toBe(terminalOutput)
    expect(updates.length).toBeLessThan(chunks.length)
    expect(maximumActivePublications).toBe(1)
  })

  it("publishes the terminal snapshot when settlement races worker cleanup", async () => {
    const commandMaySettle = deferred()
    const updates: MetadataUpdate[] = []
    const ctx = context(updates, (update) => {
      updates.push(update)
      const published = metadata(update)
      if (published.output === "live" && !("exit" in published)) {
        queueMicrotask(() => {
          queueMicrotask(commandMaySettle.resolve)
        })
      }
    })
    const pool = poolFor(async (options) => {
      options?.onStdout?.(Buffer.from("live"))
      await commandMaySettle.promise
      return result({
        stdout: "live",
        stderr: "terminal warning",
        stderrTruncated: true,
      })
    })

    const response = await execute(pool, ctx)

    expect(metadata(updates.at(-1)!)).toEqual(metadata(response))
    expect(metadata(updates.at(-1)!)).toEqual({
      output: "live",
      exit: 0,
      description: "Streaming command",
      stderr: "terminal warning",
      executor: "ssh",
      workdir: "/srv/project",
      truncated: true,
      remoteOutputTruncated: true,
    })
  })

  it("retains the bounded tail and marks preview overflow", async () => {
    const output = "prefix" + "x".repeat(30_000)
    const updates: MetadataUpdate[] = []
    const pool = poolFor(async (options) => {
      options?.onStdout?.(Buffer.from(output))
      return result({ stdout: output })
    })

    const response = await execute(pool, context(updates))

    expect(metadata(response)).toMatchObject({
      output: "...\n\n" + "x".repeat(30_000),
      truncated: true,
      remoteOutputTruncated: true,
      exit: 0,
    })
    expect(toolOutput(response)).toBe(output)
    expect(metadata(updates.at(-1)!).truncated).toBe(true)
    expect(metadata(updates.at(-1)!).remoteOutputTruncated).toBe(true)
  })

  it("preserves remote truncation when the host overwrites truncated", async () => {
    const output = "prefix" + "x".repeat(30_000)
    const pool = poolFor(async (options) => {
      options?.onStdout?.(Buffer.from(output))
      return result({ stdout: output })
    })

    const response = await execute(pool, context([]))
    const hostMetadata: Record<string, unknown> = {
      ...metadata(response),
      truncated: false,
    }

    expect(hostMetadata.remoteOutputTruncated).toBe(true)
  })

  it("publishes the exact initial shape and settles empty output", async () => {
    const updates: MetadataUpdate[] = []
    const pool = poolFor(async () => {
      expect(updates).toEqual([
        {
          title: "bash",
          metadata: {
            output: "",
            description: "",
            executor: "ssh",
            workdir: "/srv/project",
            truncated: false,
            remoteOutputTruncated: false,
          },
        },
      ])
      return result()
    })

    const response = await execute(pool, context(updates), {
      command: "quiet",
      description: "",
    })

    expect(response).toEqual({
      title: "bash",
      output: "(no output)",
      metadata: {
        output: "(no output)",
        exit: 0,
        description: "",
        stderr: undefined,
        executor: "ssh",
        workdir: "/srv/project",
        truncated: false,
        remoteOutputTruncated: false,
      },
    })
    expect(metadata(updates.at(-1)!).output).toBe("(no output)")
  })

  it("disables live publication after metadata failure without failing the command", async () => {
    const publicationFailed = deferred()
    const attempts: MetadataUpdate[] = []
    const publicationError = new Error("metadata unavailable")
    const ctx = context(attempts, (update) => {
      attempts.push(update)
      if (attempts.length === 2) {
        publicationFailed.resolve()
        throw publicationError
      }
    })
    const pool = poolFor(async (options) => {
      options?.onStdout?.(Buffer.from("first"))
      await publicationFailed.promise
      options?.onStdout?.(Buffer.from("last"))
      await sleep(150)
      return result({ stdout: "firstlast" })
    })

    const response = await execute(pool, ctx)

    expect(toolOutput(response)).toBe("firstlast")
    expect(metadata(response).output).toBe("firstlast")
    expect(attempts).toHaveLength(2)
  })

  it("flushes exit and truncation metadata before throwing for non-zero exit", async () => {
    const updates: MetadataUpdate[] = []
    const pool = poolFor(async (options) => {
      options?.onStdout?.(Buffer.from("partial"))
      options?.onStderr?.(Buffer.from("warning"))
      return result({
        stdout: "partial",
        stderr: "warning",
        exitCode: 7,
        stderrTruncated: true,
      })
    })

    const error = await execute(pool, context(updates)).catch(
      (value: unknown) => value
    )
    await sleep(150)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      "Command failed with exit code 7:\nrun\n\npartial\n\nstderr:\nwarning"
    )
    expect(metadata(updates.at(-1)!)).toEqual({
      output: "partialwarning",
      exit: 7,
      description: "Streaming command",
      stderr: "warning",
      executor: "ssh",
      workdir: "/srv/project",
      truncated: true,
      remoteOutputTruncated: true,
    })
  })

  it("flushes timeout preview and rethrows the same SshClientError", async () => {
    const updates: MetadataUpdate[] = []
    const transportResult = processResult({
      stdout: "waiting �",
      stderr: "late warning",
      exitCode: null,
      stdoutTruncated: true,
      termination: "timeout",
      timedOut: true,
    })
    const failure = new SshClientError(
      "SSH command timed out for \"remote\"",
      "remote",
      transportResult
    )
    failure.name = "TimeoutError"
    const pool = poolFor(async (options) => {
      options?.onStdout?.(Buffer.from("waiting "))
      options?.onStdout?.(Buffer.from([0xe2]))
      options?.onStderr?.(Buffer.from("late warning"))
      throw failure
    })

    const caught = await execute(pool, context(updates)).catch(
      (value: unknown) => value
    )
    await sleep(150)

    expect(caught).toBe(failure)
    expect(caught).toMatchObject({
      name: "TimeoutError",
      message: "SSH command timed out for \"remote\"",
      result: transportResult,
    })
    const finalMetadata = metadata(updates.at(-1)!)
    expect(finalMetadata).toMatchObject({
      output: "waiting late warning�",
      stderr: "late warning",
      truncated: true,
      remoteOutputTruncated: true,
    })
    expect(finalMetadata).not.toHaveProperty("exit")
  })

  it("flushes a non-null abort exit and rethrows the same SshClientError", async () => {
    const updates: MetadataUpdate[] = []
    const transportResult = processResult({
      stdout: "stopping",
      exitCode: 130,
      stderrTruncated: true,
      termination: "abort",
      aborted: true,
    })
    const failure = new SshClientError(
      "SSH command was aborted for \"remote\"",
      "remote",
      transportResult
    )
    failure.name = "AbortError"
    const pool = poolFor(async (options) => {
      options?.onStdout?.(Buffer.from("stopping"))
      throw failure
    })

    const caught = await execute(pool, context(updates)).catch(
      (value: unknown) => value
    )
    await sleep(150)

    expect(caught).toBe(failure)
    expect(caught).toMatchObject({
      name: "AbortError",
      message: "SSH command was aborted for \"remote\"",
      result: transportResult,
    })
    expect(metadata(updates.at(-1)!)).toMatchObject({
      output: "stopping",
      exit: 130,
      truncated: true,
      remoteOutputTruncated: true,
    })
  })

  it("does not publish from a late callback after settlement", async () => {
    const updates: MetadataUpdate[] = []
    let lateStdout: ExecOptions["onStdout"]
    const pool = poolFor(async (options) => {
      lateStdout = options?.onStdout
      options?.onStdout?.(Buffer.from("complete"))
      return result({ stdout: "complete" })
    })

    await execute(pool, context(updates))
    const settledUpdateCount = updates.length
    lateStdout?.(Buffer.from("too late"))
    await sleep(150)

    expect(updates).toHaveLength(settledUpdateCount)
    expect(metadata(updates.at(-1)!).output).toBe("complete")
  })

  it("runs the session safety check before path resolution, permission, or SSH", async () => {
    const rejection = new Error("preflight required")
    const beforeBash = vi.fn(() => {
      throw rejection
    })
    const resolveExisting = vi.fn(async () => "/srv/project")
    const ask = vi.fn(async () => undefined)
    const exec = vi.fn(async () => result())
    const ctx = context([])
    ctx.ask = ask

    await expect(
      createBashTool(
        { exec } as unknown as SSHPool,
        "/srv/project",
        { resolveExisting } as unknown as RemotePathResolver,
        {
          beforeBash,
          completeIdentity: vi.fn(),
          revalidateProject: vi.fn(),
          projectSignal: vi.fn(() => new AbortController().signal),
          releaseProject: vi.fn(),
        }
      ).execute({ command: "pwd", description: "pwd" }, ctx)
    ).rejects.toBe(rejection)

    expect(resolveExisting).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(beforeBash).toHaveBeenCalledWith(ctx, "pwd", undefined)
  })

  it("rejects an explicit identity workdir before path, permission, or SSH work", async () => {
    const safety = new SessionSafety("/srv/project")
    const statusAttempt = safety.beginStatusCheck("session")
    safety.recordStatusResult("session", statusAttempt, result())
    const resolveExisting = vi.fn(async () => "/srv/project")
    const ask = vi.fn(async () => undefined)
    const exec = vi.fn(async () => result())
    const ctx = context([])
    ctx.ask = ask

    await expect(
      createBashTool(
        { exec } as unknown as SSHPool,
        "/srv/project",
        { resolveExisting } as unknown as RemotePathResolver,
        safety
      ).execute(
        {
          command: IDENTITY_COMMAND,
          description: "Identity with explicit root",
          workdir: "/srv/project",
        },
        ctx
      )
    ).rejects.toThrow(/identity preflight.*explicit workdir/i)

    expect(resolveExisting).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(() =>
      safety.beforeBash(
        { sessionID: "session", agent: "build" },
        IDENTITY_COMMAND
      )
    ).toThrow(/remote_status/i)
  })

  it("retains explicit custom workdir behavior after preflight", async () => {
    const safety = new SessionSafety("/srv/project")
    const statusAttempt = safety.beginStatusCheck("session")
    safety.recordStatusResult("session", statusAttempt, result())
    const admission = safety.beforeBash(
      { sessionID: "session", agent: "build" },
      IDENTITY_COMMAND
    )
    expect(admission.kind).toBe("identity")
    if (admission.kind !== "identity") throw new Error("Expected identity admission")
    safety.completeIdentity(
      "session",
      admission.attempt,
      result({ stdout: "remote-host\nremote-user\n/srv/project\n" })
    )
    const resolveExisting = vi.fn(
      async (_path: string, _context: ToolContext) => "/srv/custom"
    )
    const ask = vi.fn(async () => undefined)
    const exec = vi.fn(async () => result({ stdout: "/srv/custom\n" }))
    const ctx = context([])
    ctx.ask = ask

    await createBashTool(
      { exec } as unknown as SSHPool,
      "/srv/project",
      { resolveExisting } as unknown as RemotePathResolver,
      safety
    ).execute(
      {
        command: "pwd -P",
        description: "Custom workdir",
        workdir: "/srv/custom",
      },
      ctx
    )

    expect(resolveExisting).toHaveBeenCalledWith(
      "/srv/custom",
      expect.objectContaining({
        sessionID: ctx.sessionID,
        metadata: ctx.metadata,
      })
    )
    const resolverContext = resolveExisting.mock.calls[0]?.[1]
    expect(resolverContext).not.toBe(ctx)
    expect(resolverContext?.abort).not.toBe(ctx.abort)
    expect(resolverContext?.abort.aborted).toBe(false)
    expect(ask).toHaveBeenCalledOnce()
    expect(exec).toHaveBeenCalledOnce()
  })

  it("does not start project SSH when delayed approval crosses a newer status epoch", async () => {
    const safety = new SessionSafety("/srv/project")
    const statusAttempt = safety.beginStatusCheck("session")
    safety.recordStatusResult("session", statusAttempt, result())
    const identityAdmission = safety.beforeBash(
      { sessionID: "session", agent: "build" },
      IDENTITY_COMMAND
    )
    if (identityAdmission.kind !== "identity") {
      throw new Error("Expected identity admission")
    }
    safety.completeIdentity(
      "session",
      identityAdmission.attempt,
      result({ stdout: "remote-host\nremote-user\n/srv/project\n" })
    )
    const askStarted = deferred()
    const releaseAsk = deferred()
    const exec = vi.fn(async () => result())
    const ctx = context([])
    ctx.ask = vi.fn(async () => {
      askStarted.resolve()
      await releaseAsk.promise
    })
    const execution = createBashTool(
      { exec } as unknown as SSHPool,
      "/srv/project",
      resolver(),
      safety
    ).execute({ command: "pwd -P", description: "Project command" }, ctx)

    await askStarted.promise
    safety.beginStatusCheck("session")
    releaseAsk.resolve()

    await expect(execution).rejects.toThrow(/project admission.*stale/i)
    expect(exec).not.toHaveBeenCalled()
  })

  it("aborts the project lease when revocation occurs during metadata publication", async () => {
    const safety = new SessionSafety("/srv/project")
    completeSessionPreflight(safety)
    const metadataStarted = deferred()
    const releaseMetadata = deferred()
    const exec = vi.fn(async () => result())
    let operationSignal: AbortSignal | undefined
    const resolveExisting = vi.fn(
      async (_path: string, resolverContext: ToolContext) => {
        operationSignal = resolverContext.abort
        return "/srv/project"
      }
    )
    const ctx = context([])
    ctx.metadata = vi.fn(() =>
      Effect.promise(async () => {
        metadataStarted.resolve()
        await releaseMetadata.promise
      })
    )
    const execution = createBashTool(
      { exec } as unknown as SSHPool,
      "/srv/project",
      { resolveExisting } as unknown as RemotePathResolver,
      safety
    ).execute({ command: "pwd -P", description: "Project command" }, ctx)

    await metadataStarted.promise
    safety.beginStatusCheck("session")
    expect(operationSignal?.aborted).toBe(true)
    expect(operationSignal?.reason).toMatchObject({ name: "AbortError" })
    releaseMetadata.resolve()

    await expect(execution).rejects.toThrow(/project admission.*stale/i)
    expect(exec).not.toHaveBeenCalled()

    completeSessionPreflight(safety)
    const laterExec = vi.fn(async () => result({ stdout: "/srv/project\n" }))
    await createBashTool(
      { exec: laterExec } as unknown as SSHPool,
      "/srv/project",
      resolver(),
      safety
    ).execute(
      { command: "pwd -P", description: "Later project command" },
      context([])
    )
    expect(laterExec).toHaveBeenCalledOnce()
  })

  it("requires fresh status when identity permission is denied after admission", async () => {
    const safety = new SessionSafety("/srv/project")
    const statusAttempt = safety.beginStatusCheck("session")
    safety.recordStatusResult("session", statusAttempt, result())
    const rejection = new Error("identity Bash denied")
    const ctx = context([])
    ctx.ask = vi.fn(async () => {
      throw rejection
    })

    await expect(
      createBashTool(
        { exec: vi.fn(async () => result()) } as unknown as SSHPool,
        "/srv/project",
        resolver(),
        safety
      ).execute(
        { command: IDENTITY_COMMAND, description: "Identity" },
        ctx
      )
    ).rejects.toBe(rejection)

    expect(() =>
      safety.beforeBash(
        { sessionID: "session", agent: "build" },
        IDENTITY_COMMAND
      )
    ).toThrow(/remote_status/i)
  })

  it("rejects a delayed identity completion after clearSession", async () => {
    const safety = new SessionSafety("/srv/project")
    const statusAttempt = safety.beginStatusCheck("session")
    safety.recordStatusResult("session", statusAttempt, result())
    const started = deferred()
    const release = deferred()
    const execution = createBashTool(
      poolFor(async () => {
        started.resolve()
        await release.promise
        return result({ stdout: "remote-host\nremote-user\n/srv/project\n" })
      }),
      "/srv/project",
      resolver(),
      safety
    ).execute(
      { command: IDENTITY_COMMAND, description: "Identity" },
      context([])
    )

    await started.promise
    safety.clearSession("session")
    release.resolve()

    await expect(execution).rejects.toThrow(/stale|superseded/i)
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("does not commit identity when abort occurs during metadata settlement", async () => {
    const safety = new SessionSafety("/srv/project")
    const statusAttempt = safety.beginStatusCheck("session")
    safety.recordStatusResult("session", statusAttempt, result())
    const controller = new AbortController()
    const settlementStarted = deferred()
    const releaseSettlement = deferred()
    let publication = 0
    const ctx = context([])
    ctx.abort = controller.signal
    ctx.metadata = vi.fn(() => {
      publication++
      if (publication === 2) {
        return Effect.promise(async () => {
          settlementStarted.resolve()
          await releaseSettlement.promise
        })
      }
      return Effect.void
    })
    const execution = createBashTool(
      poolFor(async () =>
        result({ stdout: "remote-host\nremote-user\n/srv/project\n" })
      ),
      "/srv/project",
      resolver(),
      safety
    ).execute(
      { command: IDENTITY_COMMAND, description: "Identity" },
      ctx
    )

    await settlementStarted.promise
    controller.abort()
    releaseSettlement.resolve()

    await expect(execution).rejects.toMatchObject({ name: "AbortError" })
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
    expect(() =>
      safety.beforeBash(
        { sessionID: "session", agent: "build" },
        IDENTITY_COMMAND
      )
    ).toThrow(/remote_status/i)
  })
})

type MetadataUpdate = Parameters<ToolContext["metadata"]>[0]

function context(
  updates: MetadataUpdate[],
  onPublish: (update: MetadataUpdate) => void = (update) => updates.push(update)
): ToolContext {
  const metadataCallback: ToolContext["metadata"] = vi.fn((update) =>
    Effect.sync(() => {
      onPublish(update)
    })
  )
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: new AbortController().signal,
    metadata: metadataCallback,
    ask: vi.fn(async () => undefined),
  }
}

function resolver(): RemotePathResolver {
  return {
    resolveExisting: vi.fn(async () => "/srv/project"),
  } as unknown as RemotePathResolver
}

function poolFor(
  exec: (options: ExecOptions | undefined) => Promise<RemoteCommandResult>
): SSHPool {
  return {
    exec: (_command: string, options?: ExecOptions) => exec(options),
  } as SSHPool
}

function execute(
  pool: SSHPool,
  ctx: ToolContext,
  args: { command: string; description: string } = {
    command: "run",
    description: "Streaming command",
  }
) {
  return createBashTool(
    pool,
    "/srv/project",
    resolver(),
    unrestrictedSafety()
  ).execute(args, ctx)
}

function unrestrictedSafety(): BashSafety {
  return {
    beforeBash: () => ({
      kind: "project",
      admission: {} as ProjectAdmissionToken,
    }),
    completeIdentity: () => {},
    revalidateProject: () => {},
    projectSignal: () => new AbortController().signal,
    releaseProject: () => {},
  }
}

function completeSessionPreflight(safety: SessionSafety): void {
  const statusAttempt = safety.beginStatusCheck("session")
  safety.recordStatusResult("session", statusAttempt, result())
  const admission = safety.beforeBash(
    { sessionID: "session", agent: "build" },
    IDENTITY_COMMAND
  )
  if (admission.kind !== "identity") {
    throw new Error("Expected identity admission")
  }
  safety.completeIdentity(
    "session",
    admission.attempt,
    result({ stdout: "remote-host\nremote-user\n/srv/project\n" })
  )
}

function result(overrides: Partial<RemoteCommandResult> = {}): RemoteCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  }
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: "ssh",
    args: [],
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    signal: null,
    termination: null,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    ...overrides,
  }
}

function metadata(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    !("metadata" in value) ||
    value.metadata === null ||
    typeof value.metadata !== "object" ||
    Array.isArray(value.metadata)
  ) {
    throw new TypeError("Expected a structured tool result with object metadata")
  }
  return value.metadata as Record<string, unknown>
}

function toolOutput(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    !("output" in value) ||
    typeof value.output !== "string"
  ) {
    throw new TypeError("Expected a structured tool result with string output")
  }
  return value.output
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
