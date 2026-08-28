import type { ToolContext } from "@opencode-ai/plugin"
import { describe, expect, it, vi } from "vitest"
import type { RemoteConfig } from "../../src/config.js"
import type { SSHPool } from "../../src/ssh-pool.js"
import type { RemoteCommandResult } from "../../src/ssh/client.js"
import {
  IDENTITY_COMMAND,
  SessionSafety,
  type StatusAttemptToken,
} from "../../src/session-safety.js"
import type { SubagentPolicy } from "../../src/subagent-policy.js"
import { createStatusTool } from "../../src/tools/status.js"

const STATUS_ATTEMPT = {} as StatusAttemptToken

describe("remote status tool", () => {
  it("asks for remote_status permission with target metadata before SSH", async () => {
    const order: string[] = []
    const fixture = config()
    const exec = vi.fn(async () => {
      order.push("ssh")
      return result()
    })
    const ask = vi.fn<ToolContext["ask"]>(async () => {
      order.push("ask")
      expect(exec).not.toHaveBeenCalled()
    })

    const beginStatusCheck = vi.fn(() => {
      order.push("begin")
      return STATUS_ATTEMPT
    })
    const recordStatusResult = vi.fn(() => {
      order.push("record")
      return identity()
    })
    await createStatusTool(
      fixture,
      pool(exec),
      () => {
        order.push("policy")
        return policy()
      },
      beginStatusCheck,
      recordStatusResult
    ).execute(
      {},
      context(ask)
    )

    expect(order).toEqual(["begin", "policy", "ask", "ssh", "record"])
    expect(ask).toHaveBeenCalledWith({
      permission: "remote_status",
      patterns: [fixture.targetID],
      always: [],
      metadata: {
        executor: "ssh",
        targetAlias: fixture.alias,
        remoteWorkdir: fixture.remoteWorkdir,
        connectionId: fixture.targetID,
      },
    })
    expect(exec).toHaveBeenCalledWith(IDENTITY_COMMAND, {
      cwd: fixture.remoteWorkdir,
      timeout: 5_000,
      signal: expect.any(AbortSignal),
    })
    expect(recordStatusResult).toHaveBeenCalledWith(
      "session",
      STATUS_ATTEMPT,
      result()
    )
    expect(beginStatusCheck).toHaveBeenCalledWith("session")
  })

  it("does not open SSH when permission is rejected", async () => {
    const rejection = new Error("remote_status denied")
    const exec = vi.fn(async () => result())
    const safety = new SessionSafety(config().remoteWorkdir)
    const ask = vi.fn<ToolContext["ask"]>(async () => {
      throw rejection
    })
    const recordStatusResult = vi.fn(
      (
        sessionID: string,
        attempt: StatusAttemptToken,
        observed: RemoteCommandResult
      ) => safety.recordStatusResult(sessionID, attempt, observed)
    )
    const beginStatusCheck = vi.fn((sessionID: string) =>
      safety.beginStatusCheck(sessionID)
    )
    const definition = createStatusTool(
      config(),
      pool(exec),
      () => policy(),
      beginStatusCheck,
      recordStatusResult
    )

    await expect(definition.execute({}, context(ask))).rejects.toBe(rejection)
    expect(exec).not.toHaveBeenCalled()
    expect(beginStatusCheck).toHaveBeenCalledWith("session")
    expect(recordStatusResult).not.toHaveBeenCalled()
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("reports every completed unhealthy result to the state transition", async () => {
    const recordStatusResult = vi.fn(() => null)
    const unhealthy = result({ exitCode: 1 })
    const response = await createStatusTool(
      config(),
      pool(vi.fn(async () => unhealthy)),
      () => policy(),
      vi.fn(() => STATUS_ATTEMPT),
      recordStatusResult
    ).execute({}, context(vi.fn(async () => undefined)))

    expect(response).toMatchObject({
      metadata: { controlMaster: "unhealthy" },
    })
    expect(recordStatusResult).toHaveBeenCalledWith(
      "session",
      STATUS_ATTEMPT,
      unhealthy
    )
  })

  it("an unhealthy result revokes an earlier completed preflight", async () => {
    const safety = completedSafety()
    const unhealthy = result({ exitCode: 1 })

    await createStatusTool(
      config(),
      pool(vi.fn(async () => unhealthy)),
      () => policy(),
      (sessionID) => safety.beginStatusCheck(sessionID),
      (sessionID, attempt, observed) =>
        safety.recordStatusResult(sessionID, attempt, observed)
    ).execute({}, context(vi.fn(async () => undefined)))

    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("permission denial leaves earlier state revoked by the new status epoch", async () => {
    const safety = completedSafety()
    const rejection = new Error("remote_status denied")

    await expect(
      createStatusTool(
        config(),
        pool(vi.fn(async () => result())),
        () => policy(),
        (sessionID) => safety.beginStatusCheck(sessionID),
        (sessionID, attempt, observed) =>
          safety.recordStatusResult(sessionID, attempt, observed)
      ).execute(
        {},
        context(
          vi.fn(async () => {
            throw rejection
          })
        )
      )
    ).rejects.toBe(rejection)
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("a thrown transport leaves earlier state revoked by the new status epoch", async () => {
    const safety = completedSafety()
    const rejection = new Error("transport failed before a result")

    await expect(
      createStatusTool(
        config(),
        pool(
          vi.fn(async () => {
            throw rejection
          })
        ),
        () => policy(),
        (sessionID) => safety.beginStatusCheck(sessionID),
        (sessionID, attempt, observed) =>
          safety.recordStatusResult(sessionID, attempt, observed)
      ).execute({}, context(vi.fn(async () => undefined)))
    ).rejects.toBe(rejection)
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("a thrown initial transport creates no completed state", async () => {
    const safety = new SessionSafety(config().remoteWorkdir)
    const rejection = new Error("initial transport failed")

    await expect(
      createStatusTool(
        config(),
        pool(
          vi.fn(async () => {
            throw rejection
          })
        ),
        () => policy(),
        (sessionID) => safety.beginStatusCheck(sessionID),
        (sessionID, attempt, observed) =>
          safety.recordStatusResult(sessionID, attempt, observed)
      ).execute({}, context(vi.fn(async () => undefined)))
    ).rejects.toBe(rejection)
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("transport cancellation leaves earlier state revoked by the new status epoch", async () => {
    const safety = completedSafety()
    const cancellation = new Error("status cancelled")
    cancellation.name = "AbortError"

    await expect(
      createStatusTool(
        config(),
        pool(
          vi.fn(async () => {
            throw cancellation
          })
        ),
        () => policy(),
        (sessionID) => safety.beginStatusCheck(sessionID),
        (sessionID, attempt, observed) =>
          safety.recordStatusResult(sessionID, attempt, observed)
      ).execute({}, context(vi.fn(async () => undefined)))
    ).rejects.toBe(cancellation)
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("does not commit healthy status when the executor aborts before returning", async () => {
    const safety = new SessionSafety(config().remoteWorkdir)
    const controller = new AbortController()
    const recordStatusResult = vi.fn(
      (
        sessionID: string,
        attempt: StatusAttemptToken,
        observed: RemoteCommandResult
      ) => safety.recordStatusResult(sessionID, attempt, observed)
    )
    const definition = createStatusTool(
      config(),
      pool(
        vi.fn(async () => {
          controller.abort()
          return result()
        })
      ),
      () => policy(),
      (sessionID) => safety.beginStatusCheck(sessionID),
      recordStatusResult
    )

    await expect(
      definition.execute(
        {},
        context(vi.fn(async () => undefined), controller.signal)
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(recordStatusResult).not.toHaveBeenCalled()
    expect(() =>
      safety.beforeBash(
        { sessionID: "session", agent: "build" },
        "printf blocked"
      )
    ).toThrow(/remote_status/i)
  })

  it("cannot restore status when a delayed SSH result completes after clearSession", async () => {
    const safety = new SessionSafety(config().remoteWorkdir)
    const started = deferred()
    const release = deferred()
    const execution = createStatusTool(
      config(),
      pool(
        vi.fn(async () => {
          started.resolve()
          await release.promise
          return result()
        })
      ),
      () => policy(),
      (sessionID) => safety.beginStatusCheck(sessionID),
      (sessionID, attempt, observed) =>
        safety.recordStatusResult(sessionID, attempt, observed)
    ).execute({}, context(vi.fn(async () => undefined)))

    await started.promise
    safety.clearSession("session")
    release.resolve()

    await expect(execution).rejects.toThrow(/stale|superseded/i)
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("policy lookup failure occurs after state revocation and before permission or SSH", async () => {
    const safety = completedSafety()
    const rejection = new Error("policy unavailable")
    const ask = vi.fn(async () => undefined)
    const exec = vi.fn(async () => result())

    await expect(
      createStatusTool(
        config(),
        pool(exec),
        () => {
          throw rejection
        },
        (sessionID) => safety.beginStatusCheck(sessionID),
        (sessionID, attempt, observed) =>
          safety.recordStatusResult(sessionID, attempt, observed)
      ).execute({}, context(ask))
    ).rejects.toBe(rejection)
    expect(ask).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(() => safety.requirePreflight("session")).toThrow(/preflight/i)
  })

  it("preserves target fields and reports the effective subagent policy", async () => {
    const fixture = config()
    const subagentPolicy = policy()
    const exec = vi.fn(async () => result())
    const response = await createStatusTool(
      fixture,
      pool(exec),
      () => subagentPolicy,
      vi.fn(() => STATUS_ATTEMPT),
      vi.fn(() => identity())
    ).execute({}, context(vi.fn(async () => undefined)))

    const expectedStatus = {
      executor: "ssh",
      targetAlias: fixture.alias,
      remoteWorkdir: fixture.remoteWorkdir,
      connectionId: fixture.targetID,
      controlMaster: "healthy",
      identity: identity(),
      subagentPolicy,
    }
    expect(response).toEqual({
      title: `${fixture.alias}:${fixture.remoteWorkdir}`,
      output: JSON.stringify(expectedStatus, null, 2),
      metadata: expectedStatus,
    })
    expect(Object.isFrozen(subagentPolicy)).toBe(true)
  })
})

function config(): RemoteConfig {
  return {
    alias: "fixture-host",
    remoteWorkdir: "/srv/fixture project",
    controlSocket: "/tmp/opencode-ssh/socket",
    targetID: "a".repeat(64),
    launchID: "fixture-launch",
    readyPath: "/tmp/opencode-ssh/ready.json",
    readyNonce: "fixture-ready-nonce-0123456789abcdef",
    runtimeDir: "/tmp/opencode-ssh",
    mirrorRoot: "/tmp/opencode-ssh/mirror",
    sshBinary: "ssh",
    sftpBinary: "sftp",
    active: true,
  }
}

function policy(): SubagentPolicy {
  return Object.freeze({
    requestedDepth: 4,
    effectiveDepth: 1,
    depthWasNarrowed: true,
    taskPrimaryOnly: true,
  })
}

function context(
  ask: ToolContext["ask"],
  abort: AbortSignal = new AbortController().signal
): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort,
    metadata: () => {},
    ask,
  }
}

function pool(exec: SSHPool["exec"]): SSHPool {
  return { exec } as SSHPool
}

function result(overrides: Partial<RemoteCommandResult> = {}): RemoteCommandResult {
  return {
    stdout: `remote-host\nremote-user\n${config().remoteWorkdir}\n`,
    stderr: "",
    exitCode: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  }
}

function completedSafety(): SessionSafety {
  const safety = new SessionSafety(config().remoteWorkdir)
  const statusAttempt = safety.beginStatusCheck("session")
  safety.recordStatusResult("session", statusAttempt, result())
  return safety
}

function identity() {
  return Object.freeze({
    hostname: "remote-host",
    user: "remote-user",
    workdir: config().remoteWorkdir,
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
