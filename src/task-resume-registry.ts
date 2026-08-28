export interface TaskResumeRegistration {
  ownerRootID: string
  childID: string
  subagentType: string
  observedAgent: string
  ownerPermissionFingerprint: string
  permissionFingerprint: string
}

export interface FreshTaskAdmission {
  ownerRootID: string
  callID: string
  subagentType: string
  ownerPermissionFingerprint: string
  inheritedDenyProjection: readonly string[]
  ownerSecurityEpoch: bigint
}

export interface ReadyTaskResume extends TaskResumeRegistration {
  state: "ready"
  generation: number
  activeCallID?: undefined
}

export interface ReservedTaskResume extends TaskResumeRegistration {
  state: "reserved"
  generation: number
  activeCallID: string
}

export type TaskResumeSnapshot = ReadyTaskResume | ReservedTaskResume

interface TaskResumeRecord extends TaskResumeRegistration {
  state: "ready" | "reserved"
  generation: number
  activeCallID?: string
}

interface FreshTaskAdmissionRecord extends FreshTaskAdmission {
  inheritedDenyProjection: readonly string[]
}

/** Pure launch-local ownership and single-resumer state. */
export class TaskResumeRegistry {
  private readonly records = new Map<string, TaskResumeRecord>()
  private readonly freshAdmissions = new Map<string, FreshTaskAdmissionRecord>()
  private readonly clearedSessions = new Set<string>()
  private readonly usedCalls = new Set<string>()
  private nextGeneration = 1
  private disposed = false

  admitFresh(input: FreshTaskAdmission): FreshTaskAdmission {
    this.requireActive()
    const admission = validateFreshAdmission(input)
    if (this.clearedSessions.has(admission.ownerRootID)) {
      throw new Error(
        `OpenCode SSH cannot admit fresh Task for deleted root session ${JSON.stringify(
          admission.ownerRootID
        )}`
      )
    }
    const callKey = callKeyFor(admission.ownerRootID, admission.callID)
    if (this.usedCalls.has(callKey) || this.freshAdmissions.has(callKey)) {
      throw new Error(
        `OpenCode SSH fresh Task call ID ${JSON.stringify(
          admission.callID
        )} was already used in this launch`
      )
    }

    this.usedCalls.add(callKey)
    this.freshAdmissions.set(callKey, admission)
    return freshAdmissionSnapshot(admission)
  }

  consumeFresh(ownerRootID: string, callID: string): FreshTaskAdmission | undefined {
    this.requireActive()
    const owner = requireNonEmpty(ownerRootID, "owner root ID")
    const call = requireNonEmpty(callID, "Task call ID")
    const callKey = callKeyFor(owner, call)
    const admission = this.freshAdmissions.get(callKey)
    if (!admission) return undefined
    this.freshAdmissions.delete(callKey)
    return freshAdmissionSnapshot(admission)
  }

  register(input: TaskResumeRegistration): ReadyTaskResume {
    this.requireActive()
    const registration = validateRegistration(input)
    if (registration.ownerRootID === registration.childID) {
      throw new Error("OpenCode SSH cannot register a root session as its own Task child")
    }
    if (
      this.clearedSessions.has(registration.ownerRootID) ||
      this.clearedSessions.has(registration.childID)
    ) {
      throw new Error(
        `OpenCode SSH cannot register deleted Task session ${JSON.stringify(
          registration.childID
        )}`
      )
    }
    if (this.records.has(registration.childID)) {
      throw new Error(
        `OpenCode SSH Task child ${JSON.stringify(
          registration.childID
        )} is already registered for this launch`
      )
    }

    const record: TaskResumeRecord = {
      ...registration,
      state: "ready",
      generation: this.allocateGeneration(),
    }
    this.records.set(record.childID, record)
    return readySnapshot(record)
  }

  requireReady(input: {
    ownerRootID: string
    childID: string
    subagentType: string
  }): ReadyTaskResume {
    this.requireActive()
    const ownerRootID = requireNonEmpty(input.ownerRootID, "owner root ID")
    const childID = requireNonEmpty(input.childID, "Task child ID")
    const subagentType = requireNonEmpty(input.subagentType, "Task subagent type")
    const record = this.requireOwned(ownerRootID, childID)

    if (record.subagentType !== subagentType) {
      throw new Error(
        `OpenCode SSH Task resume denied because subagent_type must exactly match the registered value ${JSON.stringify(
          record.subagentType
        )}`
      )
    }
    if (record.state !== "ready") {
      throw new Error(
        `OpenCode SSH Task resume denied because task_id ${JSON.stringify(
          childID
        )} is already reserved or uncertain for this launch`
      )
    }
    return readySnapshot(record)
  }

  reserve(input: {
    ownerRootID: string
    childID: string
    subagentType: string
    expectedGeneration: number
    callID: string
    ownerPermissionFingerprint: string
  }): ReservedTaskResume {
    const ready = this.requireReady(input)
    const callID = requireNonEmpty(input.callID, "Task call ID")
    const ownerPermissionFingerprint = requireNonEmpty(
      input.ownerPermissionFingerprint,
      "owner session permission fingerprint"
    )
    const callKey = callKeyFor(ready.ownerRootID, callID)

    if (ready.ownerPermissionFingerprint !== ownerPermissionFingerprint) {
      throw new Error(
        "OpenCode SSH Task resume denied because the caller root session permissions changed"
      )
    }
    if (ready.generation !== input.expectedGeneration) {
      throw new Error(
        `OpenCode SSH Task resume denied because task_id ${JSON.stringify(
          ready.childID
        )} changed during validation`
      )
    }
    if (this.usedCalls.has(callKey)) {
      throw new Error(
        `OpenCode SSH Task resume denied because call ID ${JSON.stringify(
          callID
        )} was already used in this launch`
      )
    }

    const record = this.records.get(ready.childID)!
    record.state = "reserved"
    record.generation = this.allocateGeneration()
    record.activeCallID = callID
    this.usedCalls.add(callKey)
    return reservedSnapshot(record)
  }

  findReservation(
    ownerRootID: string,
    callID: string
  ): ReservedTaskResume | undefined {
    this.requireActive()
    const owner = requireNonEmpty(ownerRootID, "owner root ID")
    const call = requireNonEmpty(callID, "Task call ID")
    for (const record of this.records.values()) {
      if (
        record.state === "reserved" &&
        record.ownerRootID === owner &&
        record.activeCallID === call
      ) {
        return reservedSnapshot(record)
      }
    }
    return undefined
  }

  requireReservation(input: {
    ownerRootID: string
    childID: string
    callID: string
  }): ReservedTaskResume {
    this.requireActive()
    const ownerRootID = requireNonEmpty(input.ownerRootID, "owner root ID")
    const childID = requireNonEmpty(input.childID, "Task child ID")
    const callID = requireNonEmpty(input.callID, "Task call ID")
    const record = this.requireOwned(ownerRootID, childID)

    if (record.state !== "reserved") {
      this.poison(record, callID)
      throw new Error(
        `OpenCode SSH Task completion for task_id ${JSON.stringify(
          childID
        )} was stale; resume is locked for this launch`
      )
    }
    if (record.activeCallID !== callID) {
      throw new Error(
        `OpenCode SSH Task completion call ID did not match the active reservation for ${JSON.stringify(
          childID
        )}`
      )
    }
    return reservedSnapshot(record)
  }

  release(input: {
    ownerRootID: string
    childID: string
    callID: string
    generation: number
    ownerPermissionFingerprint: string
  }): ReadyTaskResume {
    const reservation = this.requireReservation(input)
    const record = this.records.get(reservation.childID)!
    const ownerPermissionFingerprint = requireNonEmpty(
      input.ownerPermissionFingerprint,
      "owner session permission fingerprint"
    )
    if (reservation.ownerPermissionFingerprint !== ownerPermissionFingerprint) {
      throw new Error(
        "OpenCode SSH Task completion denied because the caller root session permissions changed"
      )
    }
    if (reservation.generation !== input.generation) {
      throw new Error(
        `OpenCode SSH Task completion generation did not match the active reservation for ${JSON.stringify(
          reservation.childID
        )}`
      )
    }

    record.state = "ready"
    record.generation = this.allocateGeneration()
    delete record.activeCallID
    return readySnapshot(record)
  }

  clearSession(sessionID: string): void {
    this.requireActive()
    const id = requireNonEmpty(sessionID, "session ID")
    this.clearedSessions.add(id)
    this.records.delete(id)
    for (const [childID, record] of this.records) {
      if (record.ownerRootID === id) this.records.delete(childID)
    }
    for (const [callKey, admission] of this.freshAdmissions) {
      if (admission.ownerRootID === id) this.freshAdmissions.delete(callKey)
    }
  }

  inspect(childID: string): TaskResumeSnapshot | undefined {
    if (this.disposed) return undefined
    const record = this.records.get(requireNonEmpty(childID, "Task child ID"))
    return record ? snapshot(record) : undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.records.clear()
    this.freshAdmissions.clear()
    this.clearedSessions.clear()
    this.usedCalls.clear()
  }

  private requireOwned(ownerRootID: string, childID: string): TaskResumeRecord {
    const record = this.records.get(childID)
    if (!record) {
      throw new Error(
        `OpenCode SSH Task resume denied because task_id ${JSON.stringify(
          childID
        )} is not registered for this launch`
      )
    }
    if (record.ownerRootID !== ownerRootID) {
      throw new Error(
        `OpenCode SSH Task resume denied because task_id ${JSON.stringify(
          childID
        )} is not registered to the caller root`
      )
    }
    return record
  }

  private poison(record: TaskResumeRecord, callID: string): void {
    record.state = "reserved"
    record.generation = this.allocateGeneration()
    record.activeCallID = callID
    this.usedCalls.add(callKeyFor(record.ownerRootID, callID))
  }

  private allocateGeneration(): number {
    return this.nextGeneration++
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new Error("OpenCode SSH Task resume registry is disposed")
    }
  }
}

function validateRegistration(input: TaskResumeRegistration): TaskResumeRegistration {
  const subagentType = requireNonEmpty(input.subagentType, "Task subagent type")
  const observedAgent = requireNonEmpty(input.observedAgent, "observed Task agent")
  if (observedAgent !== subagentType) {
    throw new Error(
      "OpenCode SSH observed Task agent must exactly match the registered subagent type"
    )
  }
  return {
    ownerRootID: requireNonEmpty(input.ownerRootID, "owner root ID"),
    childID: requireNonEmpty(input.childID, "Task child ID"),
    subagentType,
    observedAgent,
    ownerPermissionFingerprint: requireNonEmpty(
      input.ownerPermissionFingerprint,
      "owner session permission fingerprint"
    ),
    permissionFingerprint: requireNonEmpty(
      input.permissionFingerprint,
      "session permission fingerprint"
    ),
  }
}

function validateFreshAdmission(input: FreshTaskAdmission): FreshTaskAdmissionRecord {
  if (typeof input.ownerSecurityEpoch !== "bigint" || input.ownerSecurityEpoch < 0n) {
    throw new Error("OpenCode SSH requires a valid owner session security epoch")
  }
  if (!Array.isArray(input.inheritedDenyProjection)) {
    throw new Error("OpenCode SSH requires an inherited Task deny projection")
  }
  const inheritedDenyProjection = input.inheritedDenyProjection.map((value) =>
    requireNonEmpty(value, "inherited Task deny evidence")
  )
  return {
    ownerRootID: requireNonEmpty(input.ownerRootID, "owner root ID"),
    callID: requireNonEmpty(input.callID, "Task call ID"),
    subagentType: requireNonEmpty(input.subagentType, "Task subagent type"),
    ownerPermissionFingerprint: requireNonEmpty(
      input.ownerPermissionFingerprint,
      "owner session permission fingerprint"
    ),
    inheritedDenyProjection: Object.freeze(inheritedDenyProjection),
    ownerSecurityEpoch: input.ownerSecurityEpoch,
  }
}

function freshAdmissionSnapshot(
  admission: FreshTaskAdmissionRecord
): FreshTaskAdmission {
  return {
    ownerRootID: admission.ownerRootID,
    callID: admission.callID,
    subagentType: admission.subagentType,
    ownerPermissionFingerprint: admission.ownerPermissionFingerprint,
    inheritedDenyProjection: Object.freeze([
      ...admission.inheritedDenyProjection,
    ]),
    ownerSecurityEpoch: admission.ownerSecurityEpoch,
  }
}

function readySnapshot(record: TaskResumeRecord): ReadyTaskResume {
  if (record.state !== "ready") {
    throw new Error("OpenCode SSH internal Task resume state was not ready")
  }
  return {
    ...registrationSnapshot(record),
    state: "ready",
    generation: record.generation,
  }
}

function reservedSnapshot(record: TaskResumeRecord): ReservedTaskResume {
  if (record.state !== "reserved" || record.activeCallID === undefined) {
    throw new Error("OpenCode SSH internal Task resume state was not reserved")
  }
  return {
    ...registrationSnapshot(record),
    state: "reserved",
    generation: record.generation,
    activeCallID: record.activeCallID,
  }
}

function snapshot(record: TaskResumeRecord): TaskResumeSnapshot {
  return record.state === "ready" ? readySnapshot(record) : reservedSnapshot(record)
}

function registrationSnapshot(record: TaskResumeRecord): TaskResumeRegistration {
  return {
    ownerRootID: record.ownerRootID,
    childID: record.childID,
    subagentType: record.subagentType,
    observedAgent: record.observedAgent,
    ownerPermissionFingerprint: record.ownerPermissionFingerprint,
    permissionFingerprint: record.permissionFingerprint,
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OpenCode SSH requires a non-empty ${field}`)
  }
  return value
}

function callKeyFor(ownerRootID: string, callID: string): string {
  return `${ownerRootID}\u0000${callID}`
}
