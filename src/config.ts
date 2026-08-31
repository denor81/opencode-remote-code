import path from "node:path"
import { isOpenCodeVersion } from "./opencode-runtime-version.js"
import { computeTargetID } from "./runtime-paths.js"
import { TASK_RESUME_PROTOCOL } from "./task-resume-capability.js"

export const REMOTE_ENV = {
  alias: "OPENCODE_SSH_ALIAS",
  workdir: "OPENCODE_SSH_WORKDIR",
  socket: "OPENCODE_SSH_SOCKET",
  targetID: "OPENCODE_SSH_TARGET_ID",
  launchID: "OPENCODE_SSH_LAUNCH_ID",
  readyPath: "OPENCODE_SSH_READY_PATH",
  readyNonce: "OPENCODE_SSH_READY_NONCE",
  runtimeDir: "OPENCODE_SSH_RUNTIME_DIR",
  mirrorRoot: "OPENCODE_SSH_MIRROR_ROOT",
  sshBinary: "OPENCODE_SSH_SSH_BIN",
  sftpBinary: "OPENCODE_SSH_SFTP_BIN",
  expectedOpenCodeRuntimeVersion:
    "OPENCODE_SSH_EXPECTED_OPENCODE_RUNTIME_VERSION",
  taskResumeCapability: "OPENCODE_SSH_TASK_RESUME_CAPABILITY",
} as const

export interface RemoteConfig {
  alias: string
  remoteWorkdir: string
  controlSocket: string
  targetID: string
  launchID: string
  readyPath: string
  readyNonce: string
  runtimeDir: string
  mirrorRoot: string
  sshBinary: string
  sftpBinary: string
  expectedOpenCodeRuntimeVersion?: string
  taskResumeEnabled?: boolean
  active: true
}

export interface LoadedRemoteConfig extends RemoteConfig {
  expectedOpenCodeRuntimeVersion: string
  taskResumeEnabled: boolean
}

const REQUIRED_FIELDS = [
  REMOTE_ENV.alias,
  REMOTE_ENV.workdir,
  REMOTE_ENV.socket,
  REMOTE_ENV.targetID,
  REMOTE_ENV.launchID,
  REMOTE_ENV.readyPath,
  REMOTE_ENV.readyNonce,
  REMOTE_ENV.runtimeDir,
  REMOTE_ENV.mirrorRoot,
  REMOTE_ENV.expectedOpenCodeRuntimeVersion,
] as const

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

/** Load only the plugin instance injected by the matching launcher process. */
export function loadConfig(
  options?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): LoadedRemoteConfig | null {
  const launchID = env[REMOTE_ENV.launchID]
  const optionLaunchID = options?.launchID

  if (!launchID) return null
  if (optionLaunchID !== launchID) return null

  const missing = REQUIRED_FIELDS.filter((name) => !env[name])
  if (missing.length > 0) {
    throw new Error(`OpenCode SSH launcher context is incomplete: missing ${missing.join(", ")}`)
  }

  const alias = env[REMOTE_ENV.alias]!
  const remoteWorkdir = env[REMOTE_ENV.workdir]!
  const controlSocket = env[REMOTE_ENV.socket]!
  const targetID = env[REMOTE_ENV.targetID]!
  const readyPath = env[REMOTE_ENV.readyPath]!
  const readyNonce = env[REMOTE_ENV.readyNonce]!
  const runtimeDir = env[REMOTE_ENV.runtimeDir]!
  const mirrorRoot = env[REMOTE_ENV.mirrorRoot]!
  const expectedOpenCodeRuntimeVersion =
    env[REMOTE_ENV.expectedOpenCodeRuntimeVersion]!

  if (!isOpenCodeVersion(expectedOpenCodeRuntimeVersion)) {
    throw new Error(
      "OpenCode SSH launcher supplied an invalid expected OpenCode runtime version"
    )
  }
  if (
    options?.expectedOpenCodeRuntimeVersion !== expectedOpenCodeRuntimeVersion
  ) {
    throw new Error(
      "OpenCode SSH plugin expected runtime version option does not match the launcher environment"
    )
  }
  const taskResumeEnabled =
    options?.taskResumeCapability === TASK_RESUME_PROTOCOL &&
    env[REMOTE_ENV.taskResumeCapability] === TASK_RESUME_PROTOCOL

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias) || CONTROL_CHARACTERS.test(alias)) {
    throw new Error("OpenCode SSH launcher supplied an invalid SSH alias")
  }
  if (!path.posix.isAbsolute(remoteWorkdir) || CONTROL_CHARACTERS.test(remoteWorkdir)) {
    throw new Error("OpenCode SSH launcher supplied an invalid remote workdir")
  }
  for (const [name, value] of [
    ["control socket", controlSocket],
    ["ready path", readyPath],
    ["runtime directory", runtimeDir],
    ["mirror root", mirrorRoot],
  ] as const) {
    if (!path.isAbsolute(value) || CONTROL_CHARACTERS.test(value)) {
      throw new Error(`OpenCode SSH launcher supplied an invalid ${name}`)
    }
  }

  const resolvedRuntime = path.resolve(runtimeDir)
  const resolvedSocket = path.resolve(controlSocket)
  if (
    resolvedSocket !== resolvedRuntime &&
    !resolvedSocket.startsWith(`${resolvedRuntime}${path.sep}`)
  ) {
    throw new Error("OpenCode SSH control socket is outside its private runtime directory")
  }
  if (!/^[a-f0-9]{64}$/.test(targetID)) {
    throw new Error("OpenCode SSH launcher supplied an invalid target ID")
  }
  if (computeTargetID(alias, remoteWorkdir) !== targetID) {
    throw new Error("OpenCode SSH target ID does not match the alias and workdir")
  }
  if (readyNonce.length < 32 || CONTROL_CHARACTERS.test(readyNonce)) {
    throw new Error("OpenCode SSH launcher supplied an invalid ready nonce")
  }

  return {
    alias,
    remoteWorkdir,
    controlSocket,
    targetID,
    launchID,
    readyPath,
    readyNonce,
    runtimeDir,
    mirrorRoot,
    sshBinary: env[REMOTE_ENV.sshBinary] || "ssh",
    sftpBinary: env[REMOTE_ENV.sftpBinary] || "sftp",
    expectedOpenCodeRuntimeVersion,
    taskResumeEnabled,
    active: true,
  }
}
