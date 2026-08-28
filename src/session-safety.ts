import type {
  Hooks,
  PluginInput,
  ToolContext,
  ToolDefinition,
} from "@opencode-ai/plugin"
import type { RemoteCommandResult } from "./ssh/client.js"
import {
  TaskResumeRegistry,
  type FreshTaskAdmission,
  type TaskResumeRegistration,
  type TaskResumeSnapshot,
} from "./task-resume-registry.js"

export const IDENTITY_COMMAND = "hostname; whoami; pwd -P"

const SSH_PROJECT_PERMISSIONS = [
  "remote_status",
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "external_directory",
] as const

declare const statusAttemptTokenBrand: unique symbol
declare const projectAdmissionTokenBrand: unique symbol

export interface StatusAttemptToken {
  readonly [statusAttemptTokenBrand]: true
}

export interface ProjectAdmissionToken {
  readonly [projectAdmissionTokenBrand]: true
}

export interface BashExecutionAdmission {
  readonly kind: "project"
  readonly admission: ProjectAdmissionToken
}

export interface RemoteIdentity {
  readonly hostname: string
  readonly user: string
  readonly workdir: string
}

interface SessionState {
  generation: bigint
  phase: "blocked" | "status-pending" | "complete"
  attempt?: StatusAttemptToken
}

interface ProjectAdmissionEvidence {
  sessionID: string
  generation: bigint
  controller: AbortController
  active: boolean
}

interface SessionPermissionRule {
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
}

interface RootSecurityEvidence {
  permissionFingerprint: string
  inheritedDenyProjection: readonly string[]
}

interface OpenCodeSession {
  id: string
  parentID?: string
  agent?: string
  permission?: SessionPermissionRule[]
}

/** Launch-private preflight state. A session ID never inherits another ID's state. */
export class SessionSafety {
  private readonly sessions = new Map<string, SessionState>()
  private readonly projectAdmissions = new WeakMap<
    ProjectAdmissionToken,
    ProjectAdmissionEvidence
  >()
  private readonly activeProjectAdmissions = new Map<
    string,
    Set<ProjectAdmissionEvidence>
  >()

  constructor(private readonly canonicalWorkdir: string) {}

  /** Revoke any completed preflight before a new status attempt does other work. */
  beginStatusCheck(sessionID: string): StatusAttemptToken {
    const id = requireSessionID(sessionID)
    const attempt = Object.freeze({}) as StatusAttemptToken
    this.sessions.set(id, {
      generation: this.nextSessionGeneration(id),
      phase: "status-pending",
      attempt,
    })
    this.revokeProjectAdmissions(id)
    return attempt
  }

  /** A completed, validated status result completes this session's preflight. */
  recordStatusResult(
    sessionID: string,
    attempt: StatusAttemptToken,
    result: RemoteCommandResult
  ): RemoteIdentity | null {
    const id = requireSessionID(sessionID)
    const state = this.sessions.get(id)
    if (state?.phase !== "status-pending" || state.attempt !== attempt) {
      throw new Error(
        "OpenCode SSH remote_status completion was stale or superseded"
      )
    }
    if (result.exitCode !== 0) {
      this.sessions.set(id, {
        generation: state.generation,
        phase: "blocked",
      })
      return null
    }

    this.sessions.set(id, {
      generation: state.generation,
      phase: "blocked",
    })
    const identity = validateRemoteIdentity(result, this.canonicalWorkdir)
    this.sessions.set(id, {
      generation: state.generation,
      phase: "complete",
    })
    return identity
  }

  beforeBash(
    context: Pick<ToolContext, "sessionID" | "agent">,
    _command: string,
    _workdir?: string
  ): BashExecutionAdmission {
    const sessionID = requireSessionID(context.sessionID)
    if (this.sessions.get(sessionID)?.phase !== "complete") {
      throw new Error(
        "OpenCode SSH preflight requires a successful package remote_status call before Bash"
      )
    }
    if (context.agent === "explore") {
      throw new Error(
        "OpenCode SSH explore sessions cannot use package Bash after remote_status preflight"
      )
    }
    return {
      kind: "project",
      admission: this.admitProject(sessionID),
    }
  }

  requirePreflight(sessionID: string): void {
    const state = this.sessions.get(requireSessionID(sessionID))
    if (state?.phase !== "complete") {
      throw new Error(
        "OpenCode SSH session preflight is incomplete; call package remote_status"
      )
    }
  }

  admitProject(sessionID: string): ProjectAdmissionToken {
    const id = requireSessionID(sessionID)
    const state = this.sessions.get(id)
    if (state?.phase !== "complete") {
      throw new Error(
        "OpenCode SSH session preflight is incomplete; call package remote_status"
      )
    }
    const admission = Object.freeze({}) as ProjectAdmissionToken
    const evidence: ProjectAdmissionEvidence = {
      sessionID: id,
      generation: state.generation,
      controller: new AbortController(),
      active: true,
    }
    this.projectAdmissions.set(admission, evidence)
    const active = this.activeProjectAdmissions.get(id) ?? new Set()
    active.add(evidence)
    this.activeProjectAdmissions.set(id, active)
    return admission
  }

  projectSignal(
    sessionID: string,
    admission: ProjectAdmissionToken
  ): AbortSignal {
    return this.requireProjectAdmission(sessionID, admission).controller.signal
  }

  revalidateProject(
    sessionID: string,
    admission: ProjectAdmissionToken
  ): void {
    const id = requireSessionID(sessionID)
    const evidence = this.projectAdmissions.get(admission)
    const state = this.sessions.get(id)
    if (
      evidence?.sessionID !== id ||
      !evidence.active ||
      evidence.controller.signal.aborted ||
      state?.phase !== "complete" ||
      state.generation !== evidence.generation
    ) {
      throw new Error(
        "OpenCode SSH project admission became stale while awaiting permission"
      )
    }
  }

  releaseProject(
    sessionID: string,
    admission: ProjectAdmissionToken
  ): void {
    const evidence = this.requireProjectAdmission(sessionID, admission)
    if (!evidence.active) return
    evidence.active = false
    const active = this.activeProjectAdmissions.get(evidence.sessionID)
    active?.delete(evidence)
    if (active?.size === 0) this.activeProjectAdmissions.delete(evidence.sessionID)
  }

  clearSession(sessionID: string): void {
    const id = requireSessionID(sessionID)
    this.sessions.set(id, {
      generation: this.nextSessionGeneration(id),
      phase: "blocked",
    })
    this.revokeProjectAdmissions(id)
  }

  private nextSessionGeneration(sessionID: string): bigint {
    return (this.sessions.get(sessionID)?.generation ?? 0n) + 1n
  }

  private requireProjectAdmission(
    sessionID: string,
    admission: ProjectAdmissionToken
  ): ProjectAdmissionEvidence {
    const id = requireSessionID(sessionID)
    const evidence = this.projectAdmissions.get(admission)
    if (evidence?.sessionID !== id) {
      throw new Error("OpenCode SSH project admission token was invalid")
    }
    return evidence
  }

  private revokeProjectAdmissions(sessionID: string): void {
    const active = this.activeProjectAdmissions.get(sessionID)
    if (!active) return
    this.activeProjectAdmissions.delete(sessionID)
    const reason = new Error(
      "OpenCode SSH project admission was revoked by a newer session safety generation"
    )
    reason.name = "AbortError"
    for (const evidence of active) {
      evidence.active = false
      evidence.controller.abort(reason)
    }
  }
}

/** Gate an ordinary package project tool before its implementation does any preparation. */
export function guardProjectTool(
  definition: ToolDefinition,
  safety: SessionSafety
): ToolDefinition {
  const execute = definition.execute
  return {
    ...definition,
    async execute(this: unknown, args, context) {
      const sessionID = context.sessionID
      const admission = safety.admitProject(sessionID)
      try {
        const abort = combineAbortSignals(
          context.abort,
          safety.projectSignal(sessionID, admission)
        )
        const ask: ToolContext["ask"] = async (input) => {
          await context.ask.call(context, input)
          safety.revalidateProject(sessionID, admission)
        }
        const guardedContext = new Proxy(context, {
          get(target, property, receiver) {
            if (property === "ask") return ask
            if (property === "abort") return abort
            return Reflect.get(target, property, receiver)
          },
        })
        return await execute.call(this, args, guardedContext)
      } finally {
        safety.releaseProject(sessionID, admission)
      }
    },
  }
}

function combineAbortSignals(original: AbortSignal, lease: AbortSignal): AbortSignal {
  if (original === lease) return original
  return AbortSignal.any([original, lease])
}

export function createTaskGuard(
  client: PluginInput["client"],
  safety: SessionSafety
): NonNullable<Hooks["tool.execute.before"]> {
  return createTaskHooks(client, safety, false).before
}

export interface TaskHooks {
  before: NonNullable<Hooks["tool.execute.before"]>
  after: NonNullable<Hooks["tool.execute.after"]>
  invalidateSessionSecurity(sessionID: string): void
  observePermissionRequest(input: {
    sessionID: string
    permissionID: string
    permission: string
  }): void
  observePermissionReply(input: {
    sessionID: string
    permissionID: string
  }): void
}

export function createTaskHooks(
  client: PluginInput["client"],
  safety: SessionSafety,
  taskResumeEnabled: boolean,
  registry?: TaskResumeRegistry
): TaskHooks {
  if (taskResumeEnabled !== (registry !== undefined)) {
    throw new Error("OpenCode SSH Task resume registry capability mismatch")
  }
  const securityEpochs = new SessionSecurityEpochs()

  const before: TaskHooks["before"] = async (input, output) => {
    if (input.tool !== "task") return

    const ownerSecurityEpoch = securityEpochs.current(input.sessionID)
    const session = await lookupSession(client, input.sessionID, "caller")
    validateRootTopology(session)
    securityEpochs.requireCurrent(
      session.id,
      ownerSecurityEpoch,
      "caller root session"
    )

    if (!isRecord(output.args)) {
      throw new Error("OpenCode SSH Task denied because Task arguments were invalid")
    }
    if (output.args.background === true) {
      throw new Error("OpenCode SSH background Task is unsupported")
    }

    safety.requirePreflight(session.id)
    const ownerSecurity = validateRootPermissions(session)

    if (!Object.hasOwn(output.args, "task_id")) {
      if (taskResumeEnabled) {
        const subagentType = requireTaskArgument(output.args, "subagent_type")
        registry!.admitFresh({
          ownerRootID: session.id,
          callID: input.callID,
          subagentType,
          ownerPermissionFingerprint: ownerSecurity.permissionFingerprint,
          inheritedDenyProjection: ownerSecurity.inheritedDenyProjection,
          ownerSecurityEpoch,
        })
      }
      return
    }
    if (!taskResumeEnabled) {
      throw new Error(
        "OpenCode SSH Task resume is disabled for the selected OpenCode version"
      )
    }

    const taskID = requireTaskArgument(output.args, "task_id")
    const subagentType = requireTaskArgument(output.args, "subagent_type")
    const ready = registry!.requireReady({
      ownerRootID: session.id,
      childID: taskID,
      subagentType,
    })
    validateOwnerPermissionFingerprint(
      ownerSecurity.permissionFingerprint,
      ready
    )
    const targetSecurityEpoch = securityEpochs.current(taskID)
    const target = await lookupSession(client, taskID, "resume target")
    validateResumeTarget(target, ready)
    const currentOwner = await lookupSession(client, session.id, "caller")
    const currentOwnerSecurity = validateResumeOwner(
      currentOwner,
      ready
    )
    securityEpochs.requireCurrent(
      taskID,
      targetSecurityEpoch,
      "Task resume target"
    )
    securityEpochs.requireCurrent(
      session.id,
      ownerSecurityEpoch,
      "caller root session"
    )

    // Recheck launch-local preflight after both asynchronous session lookups.
    safety.requirePreflight(session.id)
    registry!.reserve({
      ownerRootID: session.id,
      childID: taskID,
      subagentType,
      expectedGeneration: ready.generation,
      callID: input.callID,
      ownerPermissionFingerprint: currentOwnerSecurity.permissionFingerprint,
    })
    safety.clearSession(taskID)
  }

  const after: TaskHooks["after"] = async (input, output) => {
    if (input.tool !== "task" || !taskResumeEnabled) return

    const reservation = registry!.findReservation(input.sessionID, input.callID)
    if (reservation) {
      if (output === undefined || output === null) return
      const args = requireResumeArguments(input.args)
      if (
        args.taskID !== reservation.childID ||
        args.subagentType !== reservation.subagentType
      ) {
        throw new Error(
          "OpenCode SSH Task resume completion arguments did not match the active reservation"
        )
      }

      const metadata = parseSuccessfulTaskResult(output)
      validateTaskMetadata(metadata, reservation.ownerRootID, reservation.childID)
      const ownerSecurityEpoch = securityEpochs.current(reservation.ownerRootID)
      const targetSecurityEpoch = securityEpochs.current(reservation.childID)
      const target = await lookupSession(client, reservation.childID, "resume target")
      validateResumeTarget(target, reservation)
      const currentOwner = await lookupSession(
        client,
        reservation.ownerRootID,
        "caller"
      )
      const ownerSecurity = validateResumeOwner(
        currentOwner,
        reservation
      )
      securityEpochs.requireCurrent(
        reservation.childID,
        targetSecurityEpoch,
        "Task resume target"
      )
      securityEpochs.requireCurrent(
        reservation.ownerRootID,
        ownerSecurityEpoch,
        "caller root session"
      )
      safety.requirePreflight(reservation.childID)
      registry!.release({
        ownerRootID: reservation.ownerRootID,
        childID: reservation.childID,
        callID: input.callID,
        generation: reservation.generation,
        ownerPermissionFingerprint: ownerSecurity.permissionFingerprint,
      })
      return
    }

    const freshAdmission = registry!.consumeFresh(input.sessionID, input.callID)
    if (freshAdmission) {
      if (output === undefined || output === null) return
      if (!isRecord(input.args)) {
        throw new Error("OpenCode SSH Task result denied because Task arguments were invalid")
      }
      if (Object.hasOwn(input.args, "task_id")) {
        throw new Error(
          "OpenCode SSH fresh Task completion arguments did not match its admission"
        )
      }
      if (input.args.background === true) {
        throw new Error("OpenCode SSH cannot register a background Task for resume")
      }

      const subagentType = requireTaskArgument(input.args, "subagent_type")
      if (subagentType !== freshAdmission.subagentType) {
        throw new Error(
          "OpenCode SSH fresh Task completion subagent_type did not match its admission"
        )
      }
      const metadata = parseSuccessfulTaskResult(output)
      validateTaskMetadata(metadata, freshAdmission.ownerRootID)
      safety.requirePreflight(freshAdmission.ownerRootID)
      const childSecurityEpoch = securityEpochs.current(metadata.sessionID)
      const target = await lookupSession(
        client,
        metadata.sessionID,
        "fresh Task child"
      )
      const currentOwner = await lookupSession(
        client,
        freshAdmission.ownerRootID,
        "caller"
      )
      validateFreshOwner(currentOwner, freshAdmission, securityEpochs)
      securityEpochs.requireCurrent(
        metadata.sessionID,
        childSecurityEpoch,
        "fresh Task child"
      )
      const registration = createRegistration(
        freshAdmission.ownerRootID,
        metadata.sessionID,
        subagentType,
        target,
        freshAdmission.ownerPermissionFingerprint,
        freshAdmission.inheritedDenyProjection
      )
      safety.requirePreflight(freshAdmission.ownerRootID)
      registry!.register(registration)
      return
    }

    if (isRecord(input.args) && Object.hasOwn(input.args, "task_id")) {
      const taskID = requireTaskArgument(input.args, "task_id")
      registry!.requireReservation({
        ownerRootID: input.sessionID,
        childID: taskID,
        callID: input.callID,
      })
      throw new Error("OpenCode SSH internal Task resume completion state was invalid")
    }
    throw new Error(
      "OpenCode SSH fresh Task completion had no active admission; replay is denied"
    )
  }

  return {
    before,
    after,
    invalidateSessionSecurity(sessionID) {
      securityEpochs.invalidate(sessionID)
    },
    observePermissionRequest(input) {
      securityEpochs.observePermissionRequest(input)
    },
    observePermissionReply(input) {
      securityEpochs.observePermissionReply(input)
    },
  }
}

async function lookupSession(
  client: PluginInput["client"],
  sessionID: string,
  subject: string
): Promise<OpenCodeSession> {
  let response: unknown
  try {
    response = await client.session.get({ path: { id: sessionID } })
  } catch (cause) {
    throw new Error(
      `OpenCode SSH Task denied because ${subject} session lookup failed for ${JSON.stringify(
        sessionID
      )}`,
      { cause }
    )
  }
  return parseSession(response, sessionID)
}

function parseSession(response: unknown, expectedID: string): OpenCodeSession {
  if (
    !isRecord(response) ||
    (response.error !== undefined && response.error !== null) ||
    !isRecord(response.data) ||
    response.data.id !== expectedID
  ) {
    invalidSessionResponse(expectedID)
  }

  const data = response.data
  if (
    data.parentID !== undefined &&
    (typeof data.parentID !== "string" || data.parentID.length === 0)
  ) {
    invalidSessionResponse(expectedID)
  }
  if (data.permission !== undefined && !Array.isArray(data.permission)) {
    invalidSessionResponse(expectedID)
  }
  if (
    data.agent !== undefined &&
    (typeof data.agent !== "string" || data.agent.length === 0)
  ) {
    invalidSessionResponse(expectedID)
  }

  const permission =
    data.permission === undefined
      ? undefined
      : data.permission.map((value) => {
          const action = isRecord(value) ? value.action : undefined
          if (
            !isRecord(value) ||
            typeof value.permission !== "string" ||
            typeof value.pattern !== "string" ||
            !isPermissionAction(action)
          ) {
            invalidSessionResponse(expectedID)
          }
          return {
            permission: value.permission,
            pattern: value.pattern,
            action,
          }
        })

  return {
    id: expectedID,
    ...(data.parentID === undefined ? {} : { parentID: data.parentID }),
    ...(data.agent === undefined ? {} : { agent: data.agent }),
    ...(permission === undefined ? {} : { permission }),
  }
}

interface TaskResultMetadata {
  parentSessionID: string
  sessionID: string
}

function parseSuccessfulTaskResult(output: unknown): TaskResultMetadata {
  if (
    !isRecord(output) ||
    typeof output.title !== "string" ||
    typeof output.output !== "string" ||
    !isRecord(output.metadata)
  ) {
    invalidTaskResult()
  }
  if (output.metadata.background === true) {
    throw new Error("OpenCode SSH cannot authorize a background Task result for resume")
  }
  const parentSessionID = output.metadata.parentSessionId
  const sessionID = output.metadata.sessionId
  if (
    typeof parentSessionID !== "string" ||
    parentSessionID.length === 0 ||
    typeof sessionID !== "string" ||
    sessionID.length === 0
  ) {
    invalidTaskResult()
  }
  return { parentSessionID, sessionID }
}

function validateTaskMetadata(
  metadata: TaskResultMetadata,
  expectedParentID: string,
  expectedChildID?: string
): void {
  if (
    metadata.parentSessionID !== expectedParentID ||
    metadata.sessionID === expectedParentID ||
    (expectedChildID !== undefined && metadata.sessionID !== expectedChildID)
  ) {
    throw new Error(
      "OpenCode SSH Task result metadata did not identify the expected direct child"
    )
  }
}

function createRegistration(
  ownerRootID: string,
  childID: string,
  subagentType: string,
  target: OpenCodeSession,
  ownerPermissionFingerprint: string,
  inheritedDenyProjection: readonly string[]
): TaskResumeRegistration {
  if (target.parentID !== ownerRootID) {
    throw new Error(
      "OpenCode SSH cannot register Task result because the child is not directly owned by the caller root"
    )
  }
  if (target.agent !== subagentType) {
    throw new Error(
      "OpenCode SSH cannot register Task result because the observed child agent must be explicit and match subagent_type"
    )
  }
  const permission = requireSessionPermissions(target, "fresh Task child")
  requireInheritedProjectDenies(permission, inheritedDenyProjection)
  return {
    ownerRootID,
    childID,
    subagentType,
    observedAgent: target.agent,
    ownerPermissionFingerprint,
    permissionFingerprint: permissionFingerprint(permission),
  }
}

function validateResumeTarget(
  target: OpenCodeSession,
  expected: TaskResumeSnapshot
): void {
  if (target.parentID !== expected.ownerRootID) {
    throw new Error(
      "OpenCode SSH Task resume denied because the target is not the registered direct child"
    )
  }
  if (target.agent !== expected.subagentType) {
    throw new Error(
      "OpenCode SSH Task resume denied because the target session agent must be explicit and match subagent_type"
    )
  }
  if (target.agent !== expected.observedAgent) {
    throw new Error(
      "OpenCode SSH Task resume denied because the observed target agent changed"
    )
  }
  const permission = requireSessionPermissions(target, "Task resume target")
  if (permissionFingerprint(permission) !== expected.permissionFingerprint) {
    throw new Error(
      "OpenCode SSH Task resume denied because the target session permissions changed"
    )
  }
}

function validateRootTopology(session: OpenCodeSession): void {
  if (session.parentID !== undefined) {
    throw new Error(
      "OpenCode SSH Task is limited to root sessions; a direct child cannot launch another Task"
    )
  }
}

function validateRootPermissions(session: OpenCodeSession): RootSecurityEvidence {
  const permission = requireSessionPermissions(session, "caller root session")
  const incompatibleAsk = permission.find(
    (rule) =>
      rule.action === "ask" &&
      SSH_PROJECT_PERMISSIONS.some((projectPermission) =>
        wildcardMatch(projectPermission, rule.permission)
      )
  )
  if (incompatibleAsk) {
    throw new Error(
      `OpenCode SSH cannot delegate Task because caller session permission ${JSON.stringify(
        incompatibleAsk.permission
      )} has action ask. OpenCode 1.18.18 does not inherit session ask rules into Task children; configure a global or agent-level policy instead.`
    )
  }
  return {
    permissionFingerprint: permissionFingerprint(permission),
    inheritedDenyProjection: inheritedProjectDenyProjection(permission),
  }
}

function validateResumeOwner(
  owner: OpenCodeSession,
  expected: TaskResumeSnapshot
): RootSecurityEvidence {
  validateRootTopology(owner)
  const evidence = validateRootPermissions(owner)
  validateOwnerPermissionFingerprint(evidence.permissionFingerprint, expected)
  return evidence
}

function validateFreshOwner(
  owner: OpenCodeSession,
  admission: FreshTaskAdmission,
  securityEpochs: SessionSecurityEpochs
): RootSecurityEvidence {
  validateRootTopology(owner)
  const evidence = validateRootPermissions(owner)
  if (
    evidence.permissionFingerprint !== admission.ownerPermissionFingerprint ||
    !sameProjection(
      evidence.inheritedDenyProjection,
      admission.inheritedDenyProjection
    )
  ) {
    throw new Error(
      "OpenCode SSH cannot register fresh Task because caller root security permissions changed during child creation"
    )
  }
  securityEpochs.requireCurrent(
    owner.id,
    admission.ownerSecurityEpoch,
    "caller root session"
  )
  return evidence
}

function validateOwnerPermissionFingerprint(
  fingerprint: string,
  expected: TaskResumeSnapshot
): void {
  if (fingerprint !== expected.ownerPermissionFingerprint) {
    throw new Error(
      "OpenCode SSH Task resume denied because the caller root session permissions changed"
    )
  }
}

function requireSessionPermissions(
  session: OpenCodeSession,
  subject: string
): SessionPermissionRule[] {
  if (session.permission === undefined) {
    throw new Error(
      `OpenCode SSH Task denied because ${subject} did not expose an explicit permission array`
    )
  }
  return session.permission
}

function permissionFingerprint(permission: SessionPermissionRule[]): string {
  return JSON.stringify(
    permission.map((rule) => [rule.permission, rule.pattern, rule.action])
  )
}

function inheritedProjectDenyProjection(
  permission: SessionPermissionRule[]
): readonly string[] {
  return Object.freeze(
    permission
      .filter(
        (rule) =>
          rule.action === "deny" &&
          SSH_PROJECT_PERMISSIONS.some((projectPermission) =>
            wildcardMatch(projectPermission, rule.permission)
          )
      )
      .map(permissionRuleEvidence)
      .sort()
  )
}

function requireInheritedProjectDenies(
  childPermission: SessionPermissionRule[],
  expectedProjection: readonly string[]
): void {
  const available = childPermission
    .filter((rule) => rule.action === "deny")
    .map(permissionRuleEvidence)
  for (const expected of expectedProjection) {
    const index = available.indexOf(expected)
    if (index === -1) {
      throw new Error(
        "OpenCode SSH cannot register fresh Task because child permissions did not preserve an exact inherited root deny for SSH project tools"
      )
    }
    available.splice(index, 1)
  }
}

function permissionRuleEvidence(rule: SessionPermissionRule): string {
  return JSON.stringify([rule.permission, rule.pattern, rule.action])
}

function sameProjection(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

class SessionSecurityEpochs {
  private readonly epochs = new Map<string, bigint>()
  private readonly permissionRequests = new Map<string, boolean>()

  current(sessionID: string): bigint {
    return this.epochs.get(requireSessionID(sessionID)) ?? 0n
  }

  invalidate(sessionID: string): void {
    const id = requireSessionID(sessionID)
    this.epochs.set(id, this.current(id) + 1n)
  }

  observePermissionRequest(input: {
    sessionID: string
    permissionID: string
    permission: string
  }): void {
    const sessionID = requireSessionID(input.sessionID)
    const permissionID = requireNonEmpty(input.permissionID, "permission ID")
    const permission = requireNonEmpty(input.permission, "permission")
    const relevant = SSH_PROJECT_PERMISSIONS.some((projectPermission) =>
      wildcardMatch(projectPermission, permission)
    )
    this.permissionRequests.set(
      permissionRequestKey(sessionID, permissionID),
      relevant
    )
    if (relevant) this.invalidate(sessionID)
  }

  observePermissionReply(input: {
    sessionID: string
    permissionID: string
  }): void {
    const sessionID = requireSessionID(input.sessionID)
    const permissionID = requireNonEmpty(input.permissionID, "permission ID")
    const key = permissionRequestKey(sessionID, permissionID)
    const relevant = this.permissionRequests.get(key)
    this.permissionRequests.delete(key)
    if (relevant !== false) this.invalidate(sessionID)
  }

  requireCurrent(sessionID: string, expected: bigint, subject: string): void {
    if (this.current(sessionID) !== expected) {
      throw new Error(
        `OpenCode SSH Task denied because ${subject} security evidence changed during validation`
      )
    }
  }
}

function permissionRequestKey(sessionID: string, permissionID: string): string {
  return `${sessionID}\u0000${permissionID}`
}

function requireResumeArguments(args: unknown): {
  taskID: string
  subagentType: string
} {
  if (!isRecord(args) || !Object.hasOwn(args, "task_id")) {
    throw new Error("OpenCode SSH Task resume completion arguments were invalid")
  }
  if (args.background === true) {
    throw new Error("OpenCode SSH background Task is unsupported")
  }
  return {
    taskID: requireTaskArgument(args, "task_id"),
    subagentType: requireTaskArgument(args, "subagent_type"),
  }
}

function requireTaskArgument(
  args: Record<string, unknown>,
  field: "task_id" | "subagent_type"
): string {
  const value = args[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OpenCode SSH Task resume requires a non-empty ${field}`)
  }
  return value
}

function wildcardMatch(input: string, pattern: string): boolean {
  const normalizedInput = input.replaceAll("\\", "/")
  const normalizedPattern = pattern.replaceAll("\\", "/")
  const expression = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(
    `^${expression}$`,
    process.platform === "win32" ? "si" : "s"
  ).test(normalizedInput)
}

function requireSessionID(sessionID: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    throw new Error("OpenCode SSH requires a non-empty session ID")
  }
  return sessionID
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OpenCode SSH requires a non-empty ${field}`)
  }
  return value
}

function validateRemoteIdentity(
  result: Pick<
    RemoteCommandResult,
    "stdout" | "stdoutTruncated" | "stderrTruncated"
  >,
  canonicalWorkdir: string
): RemoteIdentity {
  if (result.stdoutTruncated || result.stderrTruncated) {
    statusFailure("identity command output was truncated")
  }

  const lines = result.stdout.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (lines.length !== 3) {
    statusFailure(
      "identity command did not return exactly hostname, user, and workdir lines"
    )
  }
  if (!lines[0].trim()) statusFailure("hostname was empty")
  if (!lines[1].trim()) statusFailure("user was empty")
  if (lines[2] !== canonicalWorkdir) {
    statusFailure(
      `canonical workdir ${JSON.stringify(lines[2])} did not match ${JSON.stringify(
        canonicalWorkdir
      )}`
    )
  }
  return Object.freeze({
    hostname: lines[0],
    user: lines[1],
    workdir: lines[2],
  })
}

function statusFailure(reason: string): never {
  throw new Error(`OpenCode SSH remote_status preflight failed: ${reason}`)
}

function invalidSessionResponse(sessionID: string): never {
  throw new Error(
    `OpenCode SSH Task denied due to invalid session lookup response for ${JSON.stringify(
      sessionID
    )}`
  )
}

function invalidTaskResult(): never {
  throw new Error(
    "OpenCode SSH Task result was malformed; expected successful Task metadata parentSessionId and sessionId"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isPermissionAction(
  value: unknown
): value is SessionPermissionRule["action"] {
  return value === "allow" || value === "ask" || value === "deny"
}
