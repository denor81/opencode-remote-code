import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const APPLICATION_NAME = "opencode-ssh"
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const LAUNCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Conservative limit that works for Unix-domain sockets on Linux and macOS. */
export const MAX_SOCKET_PATH_BYTES = 80

export interface LaunchPathOptions {
  launchID?: string
  env?: NodeJS.ProcessEnv
  uid?: number
  tmpDir?: string
  socketPathLimit?: number
}

export interface RuntimePathOptions extends LaunchPathOptions {
  alias: string
  canonicalWorkdir: string
  homeDir?: string
}

export interface LaunchPaths {
  launchID: string
  runtimeDir: string
  socketPath: string
}

export interface RuntimePaths extends LaunchPaths {
  targetID: string
  stateRoot: string
  stateDir: string
  cacheRoot: string
  cacheDir: string
  workspaceDir: string
  mirrorDir: string
  readyPath: string
}

function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value)
}

function assertAlias(alias: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias) ||
    hasControlCharacters(alias)
  ) {
    throw new Error("Invalid SSH alias")
  }
}

function assertCanonicalWorkdir(workdir: string): void {
  if (!path.posix.isAbsolute(workdir) || hasControlCharacters(workdir)) {
    throw new Error("Canonical workdir must be an absolute POSIX path")
  }
}

function assertLaunchID(launchID: string): void {
  if (launchID.length > 128 || !LAUNCH_ID.test(launchID)) {
    throw new Error("Invalid launch ID")
  }
}

function assertAbsoluteLocalPath(value: string, name: string): void {
  if (!path.isAbsolute(value) || hasControlCharacters(value) || value.includes("%")) {
    throw new Error(`${name} must be an absolute local path`)
  }
}

function xdgHome(value: string | undefined, fallback: string): string {
  if (value && path.isAbsolute(value) && !hasControlCharacters(value)) {
    return value
  }
  return fallback
}

function socketPathLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function selectSocketPath(
  runtimeBase: string,
  tmpDir: string,
  uid: number,
  launchID: string,
  limit: number
): Pick<LaunchPaths, "runtimeDir" | "socketPath"> {
  const standardName = `${launchID}.sock`
  const primaryDir = path.join(runtimeBase, `${APPLICATION_NAME}-${uid}`)
  const primarySocket = path.join(primaryDir, standardName)
  if (socketPathLength(primarySocket) <= limit) {
    return { runtimeDir: primaryDir, socketPath: primarySocket }
  }

  const fallbackDir = path.join(tmpDir, `${APPLICATION_NAME}-${uid}`)
  const fallbackSocket = path.join(fallbackDir, standardName)
  if (socketPathLength(fallbackSocket) <= limit) {
    return { runtimeDir: fallbackDir, socketPath: fallbackSocket }
  }

  const shortDir = path.join(tmpDir, `ocssh-${uid}`)
  const shortName = `${createHash("sha256").update(launchID).digest("hex").slice(0, 24)}.sock`
  const shortSocket = path.join(shortDir, shortName)
  if (socketPathLength(shortSocket) > limit) {
    throw new Error("Unable to construct a sufficiently short control socket path")
  }
  return { runtimeDir: shortDir, socketPath: shortSocket }
}

function resolveLaunchID(launchID: string | undefined): string {
  const resolved = launchID ?? randomUUID()
  assertLaunchID(resolved)
  return resolved
}

export function computeTargetID(alias: string, canonicalWorkdir: string): string {
  assertAlias(alias)
  assertCanonicalWorkdir(canonicalWorkdir)
  return createHash("sha256")
    .update(alias, "utf8")
    .update("\0", "utf8")
    .update(canonicalWorkdir, "utf8")
    .digest("hex")
}

/** Resolve launch-only paths before the remote workdir has been canonicalized. */
export function resolveLaunchPaths(options: LaunchPathOptions = {}): LaunchPaths {
  const env = options.env ?? process.env
  const launchID = resolveLaunchID(options.launchID)
  const uid = options.uid ?? process.getuid?.() ?? 0
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("UID must be a non-negative integer")
  }

  const tmpDir = options.tmpDir ?? "/tmp"
  assertAbsoluteLocalPath(tmpDir, "Temporary directory")
  const configuredRuntime = env.XDG_RUNTIME_DIR
  const runtimeBase =
    configuredRuntime &&
    path.isAbsolute(configuredRuntime) &&
    !hasControlCharacters(configuredRuntime) &&
    !configuredRuntime.includes("%")
      ? configuredRuntime
      : tmpDir
  const limit = options.socketPathLimit ?? MAX_SOCKET_PATH_BYTES
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Socket path limit must be a positive integer")
  }

  return {
    launchID,
    ...selectSocketPath(runtimeBase, tmpDir, uid, launchID, limit),
  }
}

export function resolveRuntimePaths(options: RuntimePathOptions): RuntimePaths {
  assertAlias(options.alias)
  assertCanonicalWorkdir(options.canonicalWorkdir)

  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? env.HOME ?? os.homedir()
  assertAbsoluteLocalPath(homeDir, "Home directory")

  const stateHome = xdgHome(env.XDG_STATE_HOME, path.join(homeDir, ".local", "state"))
  const cacheHome = xdgHome(env.XDG_CACHE_HOME, path.join(homeDir, ".cache"))
  const targetID = computeTargetID(options.alias, options.canonicalWorkdir)
  const stateRoot = path.join(stateHome, APPLICATION_NAME)
  const stateDir = path.join(stateRoot, targetID)
  const cacheRoot = path.join(cacheHome, APPLICATION_NAME)
  const cacheDir = path.join(cacheRoot, targetID)
  const launchPaths = resolveLaunchPaths(options)

  return {
    ...launchPaths,
    targetID,
    stateRoot,
    stateDir,
    cacheRoot,
    cacheDir,
    workspaceDir: path.join(stateDir, "workspace"),
    mirrorDir: path.join(cacheDir, "mirror", launchPaths.launchID),
    readyPath: path.join(stateDir, `plugin-ready-${launchPaths.launchID}.json`),
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stats = await lstat(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Runtime path is not a private directory: ${directory}`)
  }
  await chmod(directory, 0o700)
}

export async function createLaunchPaths(options: LaunchPathOptions = {}): Promise<LaunchPaths> {
  const paths = resolveLaunchPaths(options)
  await ensurePrivateDirectory(paths.runtimeDir)
  return paths
}

export async function createRuntimePaths(options: RuntimePathOptions): Promise<RuntimePaths> {
  const paths = resolveRuntimePaths(options)
  const directories = [
    paths.stateRoot,
    paths.stateDir,
    paths.workspaceDir,
    paths.cacheRoot,
    paths.cacheDir,
    paths.mirrorDir,
    paths.runtimeDir,
  ]
  for (const directory of new Set(directories)) {
    await ensurePrivateDirectory(directory)
  }
  return paths
}
