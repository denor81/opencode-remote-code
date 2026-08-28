import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

export function assertValidRemotePath(value: string, name = "Remote path"): void {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${name} must be a string without control characters`)
  }
}

export function normalizeRemotePath(remoteRoot: string, input: string): string {
  assertValidRemotePath(remoteRoot, "Remote workspace")
  assertValidRemotePath(input)
  if (!path.posix.isAbsolute(remoteRoot)) {
    throw new Error("Remote workspace must be an absolute POSIX path")
  }
  const root = path.posix.normalize(remoteRoot)
  const absolute = path.posix.isAbsolute(input)
    ? input
    : path.posix.join(root, input)
  return path.posix.normalize(absolute)
}

export function isWithinRemoteRoot(remoteRoot: string, remotePath: string): boolean {
  const root = normalizeRemotePath("/", remoteRoot)
  const candidate = normalizeRemotePath(root, remotePath)
  if (root === "/") return true
  return candidate === root || candidate.startsWith(`${root}/`)
}

export function remotePermissionPattern(remoteRoot: string, remotePath: string): string {
  const root = normalizeRemotePath("/", remoteRoot)
  const candidate = normalizeRemotePath(root, remotePath)
  if (!isWithinRemoteRoot(root, candidate)) return candidate
  const relative = path.posix.relative(root, candidate)
  return relative || "."
}

export async function requestExternalDirectory(
  ctx: ToolContext,
  remoteRoot: string,
  remotePath: string
): Promise<void> {
  const normalized = normalizeRemotePath(remoteRoot, remotePath)
  if (isWithinRemoteRoot(remoteRoot, normalized)) return
  await ctx.ask({
    permission: "external_directory",
    patterns: [normalized],
    always: [],
    metadata: {
      executor: "ssh",
      remoteWorkspace: normalizeRemotePath("/", remoteRoot),
    },
  })
}
