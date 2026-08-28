import { describe, expect, it } from "vitest"
import { TaskResumeRegistry } from "../../src/task-resume-registry.js"

describe("Task resume registry", () => {
  it("admits and consumes each fresh Task call exactly once", () => {
    const registry = new TaskResumeRegistry()
    const projection = ['["read","*","deny"]']
    const admitted = registry.admitFresh({
      ownerRootID: "root",
      callID: "fresh-call",
      subagentType: "general",
      ownerPermissionFingerprint: "owner-permissions-v1",
      inheritedDenyProjection: projection,
      ownerSecurityEpoch: 7n,
    })
    projection.push('["bash","*","deny"]')

    expect(admitted).toEqual({
      ownerRootID: "root",
      callID: "fresh-call",
      subagentType: "general",
      ownerPermissionFingerprint: "owner-permissions-v1",
      inheritedDenyProjection: ['["read","*","deny"]'],
      ownerSecurityEpoch: 7n,
    })
    expect(registry.consumeFresh("root", "fresh-call")).toEqual(admitted)
    expect(registry.consumeFresh("root", "fresh-call")).toBeUndefined()
    expect(() => registry.admitFresh(admitted)).toThrow(/already used/i)
  })

  it("registers, reserves atomically, releases, and permits sequential resumes", () => {
    const registry = new TaskResumeRegistry()
    const registered = registry.register(registration())

    expect(registered).toMatchObject({
      ownerRootID: "root",
      childID: "child",
      subagentType: "general",
      observedAgent: "general",
      ownerPermissionFingerprint: "owner-permissions-v1",
      permissionFingerprint: "permissions-v1",
      state: "ready",
    })
    expect(registered.activeCallID).toBeUndefined()

    const first = registry.reserve({
      ownerRootID: "root",
      childID: "child",
      subagentType: "general",
      expectedGeneration: registered.generation,
      callID: "call-1",
      ownerPermissionFingerprint: "owner-permissions-v1",
    })
    expect(first).toMatchObject({ state: "reserved", activeCallID: "call-1" })
    expect(first.generation).toBeGreaterThan(registered.generation)

    expect(() =>
      registry.reserve({
        ownerRootID: "root",
        childID: "child",
        subagentType: "general",
        expectedGeneration: registered.generation,
        callID: "call-concurrent",
        ownerPermissionFingerprint: "owner-permissions-v1",
      })
    ).toThrow(/reserved|uncertain/i)

    const released = registry.release({
      ownerRootID: "root",
      childID: "child",
      callID: "call-1",
      generation: first.generation,
      ownerPermissionFingerprint: "owner-permissions-v1",
    })
    expect(released.state).toBe("ready")
    expect(released.generation).toBeGreaterThan(first.generation)

    const second = registry.reserve({
      ownerRootID: "root",
      childID: "child",
      subagentType: "general",
      expectedGeneration: released.generation,
      callID: "call-2",
      ownerPermissionFingerprint: "owner-permissions-v1",
    })
    expect(second).toMatchObject({ state: "reserved", activeCallID: "call-2" })
  })

  it("rejects unknown, foreign-root, agent-mismatched, and stale validations", () => {
    const registry = new TaskResumeRegistry()
    const registered = registry.register(registration())

    expect(() =>
      registry.requireReady({
        ownerRootID: "root",
        childID: "unknown",
        subagentType: "general",
      })
    ).toThrow(/not registered for this launch/i)
    expect(() =>
      registry.requireReady({
        ownerRootID: "other-root",
        childID: "child",
        subagentType: "general",
      })
    ).toThrow(/caller root/i)
    expect(() =>
      registry.requireReady({
        ownerRootID: "root",
        childID: "child",
        subagentType: "explore",
      })
    ).toThrow(/subagent_type.*exactly match/i)
    expect(() =>
      registry.reserve({
        ownerRootID: "root",
        childID: "child",
        subagentType: "general",
        expectedGeneration: registered.generation + 1,
        callID: "call-stale-validation",
        ownerPermissionFingerprint: "owner-permissions-v1",
      })
    ).toThrow(/changed during validation/i)
    expect(registry.inspect("child")?.state).toBe("ready")
  })

  it("requires an observed agent and owner permission continuity", () => {
    const registry = new TaskResumeRegistry()
    expect(() =>
      registry.register({
        ...registration(),
        observedAgent: undefined,
      } as unknown as Parameters<TaskResumeRegistry["register"]>[0])
    ).toThrow(/non-empty observed Task agent/i)
    expect(() =>
      registry.register(registration({ observedAgent: "explore" }))
    ).toThrow(/observed Task agent.*exactly match/i)

    const registered = registry.register(registration())
    expect(() =>
      registry.reserve({
        ownerRootID: "root",
        childID: "child",
        subagentType: "general",
        expectedGeneration: registered.generation,
        callID: "changed-before-reserve",
        ownerPermissionFingerprint: "owner-permissions-v2",
      })
    ).toThrow(/root session permissions changed/i)
    expect(registry.inspect("child")?.state).toBe("ready")

    const active = registry.reserve({
      ownerRootID: "root",
      childID: "child",
      subagentType: "general",
      expectedGeneration: registered.generation,
      callID: "active",
      ownerPermissionFingerprint: "owner-permissions-v1",
    })
    expect(() =>
      registry.release({
        ownerRootID: "root",
        childID: "child",
        callID: "active",
        generation: active.generation,
        ownerPermissionFingerprint: "owner-permissions-v2",
      })
    ).toThrow(/root session permissions changed/i)
    expect(registry.inspect("child")?.state).toBe("reserved")
  })

  it("keeps mismatched and stale completions fail-closed", () => {
    const registry = new TaskResumeRegistry()
    const registered = registry.register(registration())
    const active = registry.reserve({
      ownerRootID: "root",
      childID: "child",
      subagentType: "general",
      expectedGeneration: registered.generation,
      callID: "call-active",
      ownerPermissionFingerprint: "owner-permissions-v1",
    })

    expect(() =>
      registry.release({
        ownerRootID: "root",
        childID: "child",
        callID: "call-other",
        generation: active.generation,
        ownerPermissionFingerprint: "owner-permissions-v1",
      })
    ).toThrow(/call ID.*active reservation/i)
    expect(registry.inspect("child")).toMatchObject({
      state: "reserved",
      activeCallID: "call-active",
    })

    registry.release({
      ownerRootID: "root",
      childID: "child",
      callID: "call-active",
      generation: active.generation,
      ownerPermissionFingerprint: "owner-permissions-v1",
    })
    expect(() =>
      registry.release({
        ownerRootID: "root",
        childID: "child",
        callID: "call-active",
        generation: active.generation,
        ownerPermissionFingerprint: "owner-permissions-v1",
      })
    ).toThrow(/stale.*locked/i)
    expect(registry.inspect("child")).toMatchObject({
      state: "reserved",
      activeCallID: "call-active",
    })
  })

  it("does not release a matching call with a stale generation", () => {
    const registry = new TaskResumeRegistry()
    const registered = registry.register(registration())
    const active = registry.reserve({
      ownerRootID: "root",
      childID: "child",
      subagentType: "general",
      expectedGeneration: registered.generation,
      callID: "call-active",
      ownerPermissionFingerprint: "owner-permissions-v1",
    })

    expect(() =>
      registry.release({
        ownerRootID: "root",
        childID: "child",
        callID: "call-active",
        generation: active.generation - 1,
        ownerPermissionFingerprint: "owner-permissions-v1",
      })
    ).toThrow(/generation.*active reservation/i)
    expect(registry.inspect("child")?.state).toBe("reserved")
  })

  it("clears a child alone and clears every child owned by a root", () => {
    const registry = new TaskResumeRegistry()
    registry.admitFresh({
      ownerRootID: "root",
      callID: "pending-fresh",
      subagentType: "general",
      ownerPermissionFingerprint: "owner-permissions-v1",
      inheritedDenyProjection: [],
      ownerSecurityEpoch: 0n,
    })
    registry.register(registration())
    registry.register(
      registration({
        childID: "second-child",
        subagentType: "explore",
        observedAgent: "explore",
      })
    )
    registry.register(
      registration({
        ownerRootID: "other-root",
        childID: "other-child",
      })
    )

    registry.clearSession("child")
    expect(registry.inspect("child")).toBeUndefined()
    expect(registry.inspect("second-child")).toBeDefined()

    registry.clearSession("root")
    expect(registry.inspect("second-child")).toBeUndefined()
    expect(registry.inspect("other-child")).toBeDefined()
    expect(registry.consumeFresh("root", "pending-fresh")).toBeUndefined()
    expect(() => registry.register(registration())).toThrow(/deleted Task session/i)
  })

  it("terminally clears state and rejects late registration or release", () => {
    const registry = new TaskResumeRegistry()
    const registered = registry.register(registration())
    const reserved = registry.reserve({
      ownerRootID: "root",
      childID: "child",
      subagentType: "general",
      expectedGeneration: registered.generation,
      callID: "late-call",
      ownerPermissionFingerprint: "owner-permissions-v1",
    })

    registry.dispose()
    registry.dispose()

    expect(registry.inspect("child")).toBeUndefined()
    expect(() => registry.register(registration())).toThrow(/registry is disposed/i)
    expect(() =>
      registry.release({
        ownerRootID: "root",
        childID: "child",
        callID: "late-call",
        generation: reserved.generation,
        ownerPermissionFingerprint: "owner-permissions-v1",
      })
    ).toThrow(/registry is disposed/i)
    expect(() => registry.findReservation("root", "late-call")).toThrow(
      /registry is disposed/i
    )
    expect(() => registry.clearSession("root")).toThrow(/registry is disposed/i)
  })
})

function registration(
  overrides: Partial<Parameters<TaskResumeRegistry["register"]>[0]> = {}
) {
  return {
    ownerRootID: "root",
    childID: "child",
    subagentType: "general",
    observedAgent: "general",
    ownerPermissionFingerprint: "owner-permissions-v1",
    permissionFingerprint: "permissions-v1",
    ...overrides,
  }
}
