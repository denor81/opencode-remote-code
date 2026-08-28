const REMOTE_STATUS_PERMISSION = "remote_status"
const PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"])

type PermissionAction = "allow" | "ask" | "deny"
type PermissionRule = PermissionAction | Record<string, PermissionAction>
type PermissionPolicy = PermissionAction | Record<string, PermissionRule>

export interface SubagentPolicy {
  readonly requestedDepth: number | null
  readonly effectiveDepth: 0 | 1
  readonly depthWasNarrowed: boolean
  readonly taskPrimaryOnly: true
}

/** Apply launch-local policy to OpenCode's merged, runtime config shape. */
export function applySubagentPolicy(input: unknown): SubagentPolicy {
  const config = requireRecord(input, "root")
  const requestedDepth = readDepth(config.subagent_depth)
  const globalPermission = readPermission(config.permission, "permission")
  const mcp = readOptionalRecord(config.mcp, "mcp")

  const agents = readOptionalRecord(config.agent, "agent")
  const explore = readOptionalRecord(agents?.explore, "agent.explore")
  if (explore?.disable !== undefined && typeof explore.disable !== "boolean") {
    incompatible("agent.explore.disable must be a boolean")
  }
  const explorePermission = readPermission(
    explore?.permission,
    "agent.explore.permission"
  )

  const experimental = readOptionalRecord(config.experimental, "experimental")
  const primaryTools = readPrimaryTools(experimental?.primary_tools)

  rejectRemoteMcpCollision(mcp)

  const effectiveDepth: 0 | 1 = requestedDepth === 0 ? 0 : 1
  const hasExplicitStatusPolicy =
    hasMatchingPermission(globalPermission) ||
    hasMatchingPermission(explorePermission)

  config.subagent_depth = effectiveDepth

  if (!hasExplicitStatusPolicy) {
    if (globalPermission === undefined) {
      config.permission = { [REMOTE_STATUS_PERMISSION]: "ask" }
    } else if (typeof globalPermission !== "string") {
      globalPermission[REMOTE_STATUS_PERMISSION] = "ask"
    }
  }

  const nextPrimaryTools = addPrimaryTask(primaryTools)
  if (experimental === undefined) {
    config.experimental = { primary_tools: nextPrimaryTools }
  } else if (nextPrimaryTools !== primaryTools) {
    experimental.primary_tools = nextPrimaryTools
  }

  return Object.freeze({
    requestedDepth,
    effectiveDepth,
    depthWasNarrowed: requestedDepth !== null && requestedDepth > 1,
    taskPrimaryOnly: true as const,
  })
}

function readDepth(value: unknown): number | null {
  if (value === undefined) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    incompatible("subagent_depth must be a non-negative integer")
  }
  return value
}

function readPermission(value: unknown, field: string): PermissionPolicy | undefined {
  if (value === undefined) return undefined
  if (isPermissionAction(value)) return value
  if (!isRecord(value)) {
    incompatible(`${field} must be an action or permission object`)
  }

  for (const [permission, rule] of Object.entries(value)) {
    if (isPermissionAction(rule)) continue
    if (!isRecord(rule) || !Object.values(rule).every(isPermissionAction)) {
      incompatible(`${field}.${permission} must contain permission actions`)
    }
  }
  return value as Record<string, PermissionRule>
}

function readPrimaryTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    incompatible("experimental.primary_tools must be an array of strings")
  }
  return value
}

function addPrimaryTask(primaryTools: string[] | undefined): string[] {
  if (primaryTools === undefined) return ["task"]

  const firstTask = primaryTools.indexOf("task")
  if (firstTask === -1) return [...primaryTools, "task"]
  if (primaryTools.indexOf("task", firstTask + 1) === -1) return primaryTools
  return primaryTools.filter((tool, index) => tool !== "task" || index === firstTask)
}

function hasMatchingPermission(permission: PermissionPolicy | undefined): boolean {
  if (permission === undefined) return false
  if (typeof permission === "string") return true
  return Object.entries(permission).some(
    ([pattern, rule]) =>
      (typeof rule === "string" || Object.keys(rule).length > 0) &&
      wildcardMatch(REMOTE_STATUS_PERMISSION, pattern)
  )
}

function rejectRemoteMcpCollision(
  mcp: Record<string, unknown> | undefined
): void {
  const remote = mcp?.remote
  if (remote === undefined) return
  if (!isRecord(remote)) {
    incompatible("mcp.remote must be an MCP server object")
  }
  if (remote.enabled !== undefined && typeof remote.enabled !== "boolean") {
    incompatible("mcp.remote.enabled must be a boolean")
  }
  if (remote.enabled !== false) {
    incompatible(
      "enabled mcp.remote conflicts with the package remote_status tool namespace"
    )
  }
}

function wildcardMatch(input: string, pattern: string): boolean {
  const normalizedInput = input.replaceAll("\\", "/")
  const normalizedPattern = pattern.replaceAll("\\", "/")
  let escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) {
    escaped = `${escaped.slice(0, -3)}( .*)?`
  }
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(
    normalizedInput
  )
}

function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === "string" && PERMISSION_ACTIONS.has(value)
}

function readOptionalRecord(
  value: unknown,
  field: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return requireRecord(value, field)
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    incompatible(`${field} must be an object`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function incompatible(message: string): never {
  throw new TypeError(`Incompatible resolved OpenCode config: ${message}`)
}
