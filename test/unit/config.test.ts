import path from "node:path"
import { describe, expect, it } from "vitest"
import { REMOTE_ENV, loadConfig } from "../../src/config.js"
import { computeTargetID } from "../../src/runtime-paths.js"
import { TASK_RESUME_PROTOCOL } from "../../src/task-resume-capability.js"

const BASELINE_VERSION = "1.18.18"

describe("launcher Task resume capability", () => {
  it("enables resume for a valid runtime and protocol agreement", () => {
    const env = launcherEnvironment()
    env[REMOTE_ENV.taskResumeCapability] = TASK_RESUME_PROTOCOL

    expect(
      loadConfig(
        launcherOptions(env, {
          taskResumeCapability: TASK_RESUME_PROTOCOL,
        }),
        env
      )?.taskResumeEnabled
    ).toBe(true)
  })

  it("enables resume when another expected runtime matches", () => {
    const env = launcherEnvironment("1.18.19")
    env[REMOTE_ENV.taskResumeCapability] = TASK_RESUME_PROTOCOL

    expect(
      loadConfig(
        launcherOptions(env, {
          taskResumeCapability: TASK_RESUME_PROTOCOL,
        }),
        env
      )
    ).toMatchObject({
      expectedOpenCodeRuntimeVersion: "1.18.19",
      taskResumeEnabled: true,
    })
  })

  it.each([
    { name: "missing tuple capability", options: {} },
    {
      name: "plain user boolean",
      options: { taskResumeEnabled: true },
    },
    {
      name: "malformed tuple capability",
      options: { taskResumeCapability: "invalid" },
    },
  ])("fails closed for $name", ({ options }) => {
    const env = launcherEnvironment()
    env[REMOTE_ENV.taskResumeCapability] = TASK_RESUME_PROTOCOL

    expect(
      loadConfig(
        launcherOptions(env, options),
        env
      )?.taskResumeEnabled
    ).toBe(false)
  })

  it("fails closed for missing, malformed, or mismatched environment capability", () => {
    for (const capability of [undefined, "invalid", "opencode-ssh-task-resume-v2"]) {
      const env = launcherEnvironment()
      if (capability !== undefined) env[REMOTE_ENV.taskResumeCapability] = capability

      expect(
        loadConfig(
          launcherOptions(env, {
            taskResumeCapability: TASK_RESUME_PROTOCOL,
          }),
          env
        )?.taskResumeEnabled
      ).toBe(false)
    }
  })

  it("requires a plain expected runtime and exact tuple/environment agreement", () => {
    const env = launcherEnvironment()
    expect(() =>
      loadConfig({ launchID: env[REMOTE_ENV.launchID] }, env)
    ).toThrow(/expected runtime version option.*does not match/i)
    expect(() =>
      loadConfig(
        {
          launchID: env[REMOTE_ENV.launchID],
          expectedOpenCodeRuntimeVersion: "1.18.19",
        },
        env
      )
    ).toThrow(/expected runtime version option.*does not match/i)

    const malformed = launcherEnvironment("v1.18.18")
    expect(() => loadConfig(launcherOptions(malformed), malformed)).toThrow(
      /invalid expected OpenCode runtime version/i
    )

    const missing = launcherEnvironment()
    delete missing[REMOTE_ENV.expectedOpenCodeRuntimeVersion]
    expect(() =>
      loadConfig(
        {
          launchID: missing[REMOTE_ENV.launchID],
          expectedOpenCodeRuntimeVersion: BASELINE_VERSION,
        },
        missing
      )
    ).toThrow(/context is incomplete.*EXPECTED_OPENCODE_RUNTIME_VERSION/i)
  })

  it("preserves dormant behavior outside a matching launcher tuple", () => {
    expect(
      loadConfig(
        {
          expectedOpenCodeRuntimeVersion: BASELINE_VERSION,
          taskResumeCapability: TASK_RESUME_PROTOCOL,
        },
        {}
      )
    ).toBeNull()

    const env = launcherEnvironment()
    env[REMOTE_ENV.taskResumeCapability] = TASK_RESUME_PROTOCOL
    expect(
      loadConfig(
        {
          launchID: "another-launch",
          expectedOpenCodeRuntimeVersion: BASELINE_VERSION,
          taskResumeCapability: TASK_RESUME_PROTOCOL,
        },
        env
      )
    ).toBeNull()
  })
})

function launcherEnvironment(
  expectedOpenCodeRuntimeVersion: string = BASELINE_VERSION
): NodeJS.ProcessEnv {
  const alias = "fixture-host"
  const remoteWorkdir = "/srv/fixture"
  const runtimeDir = "/tmp/opencode-ssh-config/runtime"
  return {
    [REMOTE_ENV.alias]: alias,
    [REMOTE_ENV.workdir]: remoteWorkdir,
    [REMOTE_ENV.socket]: path.join(runtimeDir, "control.sock"),
    [REMOTE_ENV.targetID]: computeTargetID(alias, remoteWorkdir),
    [REMOTE_ENV.launchID]: "fixture-launch",
    [REMOTE_ENV.readyPath]: "/tmp/opencode-ssh-config/ready.json",
    [REMOTE_ENV.readyNonce]: "n".repeat(32),
    [REMOTE_ENV.runtimeDir]: runtimeDir,
    [REMOTE_ENV.mirrorRoot]: "/tmp/opencode-ssh-config/mirror",
    [REMOTE_ENV.expectedOpenCodeRuntimeVersion]: expectedOpenCodeRuntimeVersion,
  }
}

function launcherOptions(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    launchID: env[REMOTE_ENV.launchID],
    expectedOpenCodeRuntimeVersion:
      env[REMOTE_ENV.expectedOpenCodeRuntimeVersion],
    ...overrides,
  }
}
