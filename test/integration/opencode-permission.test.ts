import { readFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Part, PermissionRequest, Session } from "@opencode-ai/sdk/v2"
import { resolveDailyLogFilePath } from "../../src/logger.js"
import {
  TASK_FIXTURE_MODEL_ID,
  TASK_FIXTURE_PROVIDER_ID,
  detectInstalledOpenCode,
  startInstalledOpenCodeTaskFixture,
  type InstalledOpenCodeTaskFixture,
  type TaskFixtureSshResponse,
} from "../helpers/installed-opencode-task-fixture.js"
import {
  providerHasToolCall,
  providerHistoryContains,
  type ScriptedProviderStep,
} from "../helpers/scripted-openai-provider.js"

const installedOpenCode = detectInstalledOpenCode()
const skipReason =
  installedOpenCode.kind === "absent" && !installedOpenCode.required
    ? installedOpenCode.reason
    : undefined
const activeFixtures = new Set<InstalledOpenCodeTaskFixture>()
const ROOT_PROMPT = "Verify process-local external-directory permission reuse."
const SECOND_PROMPT = "Verify the existing external-directory approval in this session."
const ROOT_COMPLETE = "External-directory permission reuse verified."
const SECOND_COMPLETE = "Cross-session external-directory approval verified."
const DENY_AGENT = "external-deny"
const PATHS = {
  scope: "/var/log",
  descendant: "/var/log/subdir/deep",
  unrelated: "/opt/other",
} as const
const CALLS = {
  rootStatus: "call_permission_root_status",
  first: "call_permission_first",
  exact: "call_permission_exact",
  descendant: "call_permission_descendant",
  unrelated: "call_permission_unrelated",
  secondStatus: "call_permission_second_status",
  second: "call_permission_second",
} as const

afterEach(async () => {
  const results = await Promise.allSettled(
    [...activeFixtures].map(async (fixture) => {
      try {
        await fixture.close()
        fixture.provider.assertComplete()
      } finally {
        activeFixtures.delete(fixture)
      }
    })
  )
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, "OpenCode permission fixture cleanup failed")
  }
})

describe("real installed OpenCode permission engine through opencode-ssh", () => {
  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "reuses external-directory always for exact and descendant scopes only",
    async () => {
      if (installedOpenCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }

      const fixture = await startInstalledOpenCodeTaskFixture({
        openCode: installedOpenCode,
        steps: providerSteps(),
        configOverride: {
          permission: { bash: "ask", external_directory: "ask" },
          agent: {
            [DENY_AGENT]: {
              mode: "primary",
              description: "Permission precedence fixture agent",
              permission: {
                remote_status: "allow",
                external_directory: "deny",
                bash: "allow",
              },
            },
          },
        },
        enableFakeRemoteFilesystem: true,
        fakeRemoteDirectories: Object.values(PATHS),
        extraSshResponses: sshResponses(),
      })
      activeFixtures.add(fixture)
      const activePrompts: Promise<unknown>[] = []
      let scenarioError: unknown

      try {
        const root = requireData<Session>(
          await fixture.client.session.create({
            title: "External permission root",
            agent: "build",
          }, { signal: AbortSignal.timeout(30_000) }),
          "create permission root"
        )
        await fixture.waitForReady()
        const rootPrompt = fixture.client.session.prompt({
          sessionID: root.id,
          model: {
            providerID: TASK_FIXTURE_PROVIDER_ID,
            modelID: TASK_FIXTURE_MODEL_ID,
          },
          agent: "build",
          parts: [{ type: "text", text: ROOT_PROMPT }],
        }, { signal: AbortSignal.timeout(60_000) })
        activePrompts.push(rootPrompt)
        void rootPrompt.catch(() => undefined)
        const seen = new Set<string>()

        const external = await waitForPermission(fixture, seen, "external_directory")
        expect(external.patterns).toEqual([PATHS.scope])
        expect(external.always).toEqual([PATHS.scope, `${PATHS.scope}/*`])
        await replyPermission(fixture, external, "always")

        for (const description of [
          "permission first",
          "permission exact",
          "permission descendant",
        ]) {
          const bash = await waitForPermission(fixture, seen, "bash")
          expect(bash.always).toEqual([])
          expect(bash.metadata).toMatchObject({ description })
          await replyPermission(fixture, bash, "once")
        }

        const unrelated = await waitForPermission(
          fixture,
          seen,
          "external_directory"
        )
        expect(unrelated.patterns).toEqual([PATHS.unrelated])
        await replyPermission(fixture, unrelated, "once")
        const unrelatedBash = await waitForPermission(fixture, seen, "bash")
        await replyPermission(fixture, unrelatedBash, "once")

        const rootResult = requireData<{ parts: Part[] }>(
          await rootPrompt,
          "complete permission root prompt"
        )
        expect(textParts(rootResult.parts)).toContain(ROOT_COMPLETE)
        expect(
          requireData<PermissionRequest[]>(
            await fixture.client.permission.list(
              {},
              { signal: AbortSignal.timeout(10_000) }
            ),
            "list settled root permissions"
          )
        ).toEqual([])

        const second = requireData<Session>(
          await fixture.client.session.create({
            title: "External permission second root",
            agent: DENY_AGENT,
          }, { signal: AbortSignal.timeout(30_000) }),
          "create second permission root"
        )
        const secondPrompt = fixture.client.session.prompt({
          sessionID: second.id,
          model: {
            providerID: TASK_FIXTURE_PROVIDER_ID,
            modelID: TASK_FIXTURE_MODEL_ID,
          },
          agent: DENY_AGENT,
          parts: [{ type: "text", text: SECOND_PROMPT }],
        }, { signal: AbortSignal.timeout(30_000) })
        activePrompts.push(secondPrompt)
        void secondPrompt.catch(() => undefined)
        const secondResult = requireData<{ parts: Part[] }>(
          await secondPrompt,
          "complete second permission prompt"
        )
        expect(textParts(secondResult.parts)).toContain(SECOND_COMPLETE)
        expect(
          requireData<PermissionRequest[]>(
            await fixture.client.permission.list(
              {},
              { signal: AbortSignal.timeout(10_000) }
            ),
            "list settled cross-session permissions"
          )
        ).toEqual([])

        const lifecycleRecords = await waitForPermissionLifecycleLogs(fixture)
        expect(lifecycleRecords).toHaveLength(4)
        expect(
          lifecycleRecords.filter(
            (record) =>
              record.event === "plugin.permission.external_directory.requested"
          )
        ).toHaveLength(2)
        expect(
          lifecycleRecords
            .filter(
              (record) =>
                record.event === "plugin.permission.external_directory.replied"
            )
            .map((record) => [
              record.fields?.reply,
              record.fields?.approvalLifetime,
            ])
            .sort()
        ).toEqual([
          ["always", "opencode-process"],
          ["once", "single-request"],
        ])
        expect(
          lifecycleRecords.filter(
            (record) =>
              record.event === "plugin.permission.external_directory.replied"
          )
        ).toHaveLength(2)
        const serializedLifecycle = JSON.stringify(lifecycleRecords)
        for (const secret of [
          ...Object.values(PATHS),
          root.id,
          second.id,
          ...seen,
        ]) {
          expect(serializedLifecycle).not.toContain(secret)
        }

        const inputs = await fixture.readSshInputs()
        for (const response of sshResponses()) {
          expect(inputs.filter((input) => input === response.input)).toHaveLength(1)
        }
      } catch (error) {
        scenarioError = error
      }
      await finishPermissionFixture(fixture, activePrompts, scenarioError)
    },
    180_000
  )
})

function providerSteps(): ScriptedProviderStep[] {
  return [
    toolStep("root calls remote_status", ROOT_PROMPT, CALLS.rootStatus, "remote_status", {}),
    toolStep("root calls first external Bash", ROOT_PROMPT, CALLS.first, "bash", {
      command: "printf PERMISSION_FIRST",
      description: "permission first",
      workdir: PATHS.scope,
    }),
    toolStep("root repeats exact external Bash", ROOT_PROMPT, CALLS.exact, "bash", {
      command: "printf PERMISSION_EXACT",
      description: "permission exact",
      workdir: PATHS.scope,
    }),
    toolStep(
      "root uses descendant external Bash",
      ROOT_PROMPT,
      CALLS.descendant,
      "bash",
      {
        command: "printf PERMISSION_DESCENDANT",
        description: "permission descendant",
        workdir: PATHS.descendant,
      }
    ),
    toolStep(
      "root uses unrelated external Bash",
      ROOT_PROMPT,
      CALLS.unrelated,
      "bash",
      {
        command: "printf PERMISSION_UNRELATED",
        description: "permission unrelated",
        workdir: PATHS.unrelated,
      }
    ),
    textStep("root completes permission check", CALLS.unrelated, ROOT_COMPLETE),
    toolStep(
      "second root calls remote_status",
      SECOND_PROMPT,
      CALLS.secondStatus,
      "remote_status",
      {}
    ),
    toolStep("second root uses approved scope", SECOND_PROMPT, CALLS.second, "bash", {
      command: "printf PERMISSION_SECOND",
      description: "permission second",
      workdir: PATHS.scope,
    }),
    textStep("second root completes permission check", CALLS.second, SECOND_COMPLETE),
  ]
}

function toolStep(
  name: string,
  prompt: string,
  callID: string,
  tool: string,
  args: Record<string, unknown>
): ScriptedProviderStep {
  return {
    name,
    match: (request) =>
      providerHistoryContains(request, prompt) &&
      !providerHasToolCall(request, callID),
    response: { type: "tool-call", id: callID, name: tool, arguments: args },
  }
}

function textStep(name: string, callID: string, text: string): ScriptedProviderStep {
  return {
    name,
    match: (request) => providerHasToolCall(request, callID),
    response: { type: "text", text },
  }
}

function sshResponses(): TaskFixtureSshResponse[] {
  return [
    bashResponse(PATHS.scope, "printf PERMISSION_FIRST", "PERMISSION_FIRST"),
    bashResponse(PATHS.scope, "printf PERMISSION_EXACT", "PERMISSION_EXACT"),
    bashResponse(
      PATHS.descendant,
      "printf PERMISSION_DESCENDANT",
      "PERMISSION_DESCENDANT"
    ),
    bashResponse(
      PATHS.unrelated,
      "printf PERMISSION_UNRELATED",
      "PERMISSION_UNRELATED"
    ),
    bashResponse(PATHS.scope, "printf PERMISSION_SECOND", "PERMISSION_SECOND"),
  ]
}

function bashResponse(
  workdir: string,
  command: string,
  stdout: string
): TaskFixtureSshResponse {
  return {
    input: `cd ${workdir} || exit $?\n${command}`,
    stdout,
  }
}

async function waitForPermission(
  fixture: InstalledOpenCodeTaskFixture,
  seen: Set<string>,
  permission: string,
  timeoutMs = 20_000
): Promise<PermissionRequest> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const pending = requireData<PermissionRequest[]>(
      await fixture.client.permission.list(
        {},
        { signal: AbortSignal.timeout(5_000) }
      ),
      "list pending permissions"
    )
    const next = pending.find((request) => !seen.has(request.id))
    if (next) {
      seen.add(next.id)
      expect(next.permission).toBe(permission)
      return next
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${permission} permission`)
}

async function replyPermission(
  fixture: InstalledOpenCodeTaskFixture,
  request: PermissionRequest,
  reply: "once" | "always" | "reject"
): Promise<void> {
  requireData(
    await fixture.client.permission.reply(
      { requestID: request.id, reply },
      { signal: AbortSignal.timeout(10_000) }
    ),
    `reply ${reply} to ${request.permission}`
  )
}

function textParts(parts: readonly Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

interface PluginLogRecord {
  event: string
  fields?: Record<string, unknown>
}

async function waitForPermissionLifecycleLogs(
  fixture: InstalledOpenCodeTaskFixture,
  timeoutMs = 5_000
): Promise<PluginLogRecord[]> {
  const logDirectory = path.join(fixture.root, "state", "opencode-ssh", "logs")
  const startedAt = new Date()
  const deadline = Date.now() + timeoutMs
  let records: PluginLogRecord[] = []
  while (Date.now() <= deadline) {
    records = await readPermissionLogRecords(logDirectory, startedAt)
    const requested = records.filter(
      (record) => record.event === "plugin.permission.external_directory.requested"
    ).length
    const replied = records.filter(
      (record) => record.event === "plugin.permission.external_directory.replied"
    ).length
    if (requested >= 2 && replied >= 2) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const stableRecords = await readPermissionLogRecords(logDirectory, startedAt)
      return stableRecords.filter((record) =>
        record.event.startsWith("plugin.permission.external_directory.")
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `Timed out waiting for real permission lifecycle logs; observed ${JSON.stringify(records.map((record) => record.event))}`
  )
}

async function readPermissionLogRecords(
  logDirectory: string,
  startedAt: Date
): Promise<PluginLogRecord[]> {
  const now = new Date()
  const candidateDates = [
    new Date(startedAt.getTime() - 24 * 60 * 60 * 1_000),
    startedAt,
    now,
  ]
  const logPaths = new Set(
    candidateDates.map((candidate) =>
      resolveDailyLogFilePath({ logDirectory, now: candidate })
    )
  )
  const contents = await Promise.all(
    [...logPaths].map(async (logPath) => {
      try {
        return await readFile(logPath, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
        throw error
      }
    })
  )
  return contents.flatMap((content) =>
    content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PluginLogRecord)
  )
}

function requireData<T>(
  result: { data?: T; error?: unknown },
  operation: string
): T {
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`${operation} failed: ${JSON.stringify(result.error)}`)
  }
  return result.data
}

async function finishPermissionFixture(
  fixture: InstalledOpenCodeTaskFixture,
  activePrompts: readonly Promise<unknown>[],
  scenarioError: unknown
): Promise<void> {
  let failure = scenarioError
  try {
    await fixture.close()
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError([failure, cleanupError], "Permission scenario and cleanup failed")
      : cleanupError
  } finally {
    await Promise.allSettled(activePrompts)
    activeFixtures.delete(fixture)
  }
  try {
    fixture.provider.assertComplete()
  } catch (providerError) {
    failure = failure
      ? new AggregateError(
          [failure, providerError],
          "Permission scenario and provider script both failed"
        )
      : providerError
  }
  if (failure) throw failure
}
