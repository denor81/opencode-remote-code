import { stat } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import type {
  Part,
  Session,
  ToolPart,
} from "@opencode-ai/sdk/v2"
import {
  LOCAL_EXECUTION_CANARY,
  REMOTE_AGENTS_MARKER,
  SSH_FIXTURE_CHILD_OUTPUT,
  TASK_FIXTURE_ALIAS,
  TASK_FIXTURE_MODEL_ID,
  TASK_FIXTURE_PROVIDER_ID,
  TASK_FIXTURE_REQUESTED_WORKDIR,
  TASK_FIXTURE_WORKDIR,
  detectInstalledOpenCode,
  startInstalledOpenCodeTaskFixture,
  type InstalledOpenCodeConfigOverride,
  type InstalledOpenCodeTaskFixture,
} from "../helpers/installed-opencode-task-fixture.js"
import type {
  ScriptedProviderMessageRole,
  ScriptedProviderRequest,
  ScriptedProviderStep,
} from "../helpers/scripted-openai-provider.js"
import {
  providerHasToolCall,
  providerHistoryContains,
  providerMessageTexts,
  providerToolResultText,
} from "../helpers/scripted-openai-provider.js"

const installedOpenCode = detectInstalledOpenCode()
const skipReason =
  installedOpenCode.kind === "absent" && !installedOpenCode.required
    ? installedOpenCode.reason
    : undefined
const activeFixtures = new Set<InstalledOpenCodeTaskFixture>()
const TASK_SCENARIO_TIMEOUT_MS = 420_000
const ROOT_PROMPT = "Delegate the one hermetic remote preflight task."
const CHILD_TEXT = "Child verified the SSH canary."
const ROOT_TEXT = "Root received the verified child result."
const CUSTOM_AGENT = "task3-custom"
const CANCELLATION_AGENT = "task3-cancellation"
const CUSTOM_AGENT_PROMPT = "TASK3_CUSTOM_AGENT_PROMPT_MARKER"
const IDENTITY_COMMAND = "hostname; whoami; pwd -P"
const ROOT_VERIFY_COMMAND = "printf TASK3_ROOT_FINAL_VERIFICATION"
const ROOT_VERIFY_OUTPUT = "TASK3_ROOT_FINAL_VERIFIED\n"
const LONG_COMMANDS = {
  explore: "printf TASK3_EXPLORE_LONG_RUNNING_SSH",
  custom: "printf TASK3_CUSTOM_LONG_RUNNING_SSH",
} as const
type ChildKind = keyof typeof LONG_COMMANDS
const SIBLING_ROOT_PROMPT = "Run both direct Task children concurrently."
const DENY_ROOT_PROMPT = "Delegate once and require the child to obey SSH safety."
const DEPTH_ZERO_PROMPT = "Attempt one Task under explicit depth zero."
const CANCELLATION_ROOT_PROMPT = "Start both cancellable direct children."
const RESUME_ROOT_PROMPT =
  "Create one direct child, then resume its model-visible Task ID once. If resume is disabled, prove a fresh Task still works."
const EXPLORE_CHILD_MARKER = "TASK3_EXPLORE_CHILD_MARKER"
const CUSTOM_CHILD_MARKER = "TASK3_CUSTOM_CHILD_MARKER"
const DENY_CHILD_MARKER = "TASK3_DENY_CHILD_MARKER"
const RESUME_INITIAL_CONTEXT_MARKER = "TASK_RESUME_INITIAL_CONTEXT_MARKER"
const RESUME_CHILD_MARKER = "TASK_RESUME_SECOND_PART_MARKER"
const RESUME_INITIAL_TEXT = "Child saved the initial resume context."
const RESUME_CHILD_TEXT =
  "Resumed child retained context and verified fresh SFTP mutation."
const RESUME_FALLBACK_MARKER = "TASK_RESUME_FRESH_FALLBACK_MARKER"
const RESUME_FALLBACK_TEXT = "Fresh fallback child verified Task remains available."
const RESUME_ENABLED_ROOT_TEXT = "Root verified same-session Task resume."
const RESUME_DISABLED_ROOT_TEXT =
  "Root observed Task resume is unavailable and verified fresh Task remains available."
const RESUME_WRITE_PATH = `${TASK_FIXTURE_WORKDIR}/resume-sftp-proof.txt`
const RESUME_WRITE_CONTENT = "TASK_RESUME_SFTP_CONTENT\n"

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
    throw new AggregateError(failures, "OpenCode Task fixture cleanup failed")
  }
})

describe("real installed OpenCode Task through opencode-ssh", () => {
  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "runs one real root-to-general-child Task with SSH-backed tools",
    async () => {
      if (installedOpenCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }

      const fixture = await startInstalledOpenCodeTaskFixture({
        openCode: installedOpenCode,
        steps: providerScript(),
      })
      activeFixtures.add(fixture)
      let scenarioError: unknown

      try {
        assertOpenCodeProvenance(fixture)
        const root = requireData<Session>(
          await fixture.client.session.create(
            {
              title: "Hermetic root Task fixture",
              agent: "build",
            },
            { signal: AbortSignal.timeout(30_000) }
          ),
          "create root session"
        )
        expect(root.permission).toBeUndefined()
        expect(
          requireData<Session>(
            await fixture.client.session.get(
              { sessionID: root.id },
              { signal: AbortSignal.timeout(10_000) }
            ),
            "reload root session"
          ).permission
        ).toBeUndefined()

        const ready = await fixture.waitForReady()
        expect(ready).toMatchObject({
          alias: TASK_FIXTURE_ALIAS,
          canonicalWorkdir: TASK_FIXTURE_WORKDIR,
        })
        expect((await stat(fixture.readyPath)).mode & 0o777).toBe(0o600)
        await expect(stat(`${fixture.socketPath}.fake-ssh-master`)).resolves.toBeDefined()

        const promptResult = requireData<{ info: unknown; parts: Part[] }>(
          await fixture.client.session.prompt(
            {
              sessionID: root.id,
              model: {
                providerID: TASK_FIXTURE_PROVIDER_ID,
                modelID: TASK_FIXTURE_MODEL_ID,
              },
              agent: "build",
              parts: [{ type: "text", text: ROOT_PROMPT }],
            },
            { signal: AbortSignal.timeout(60_000) }
          ),
          "prompt root session"
        )

        expect(textParts(promptResult.parts)).toContain(ROOT_TEXT)
        const children = requireData<Session[]>(
          await fixture.client.session.children(
            { sessionID: root.id },
            { signal: AbortSignal.timeout(10_000) }
          ),
          "list root children"
        )
        expect(children).toHaveLength(1)
        const [child] = children
        expect(child).toMatchObject({ parentID: root.id, agent: "general" })
        expect(child.permission).toEqual(expect.any(Array))
        const rootMessages = requireData<Array<{ info: MessageInfo; parts: Part[] }>>(
          await fixture.client.session.messages(
            { sessionID: root.id },
            { signal: AbortSignal.timeout(10_000) }
          ),
          "read root messages"
        )
        const taskPart = completedTool(
          rootMessages,
          "task"
        )
        expect(taskPart.state.metadata).toMatchObject({
          parentSessionId: root.id,
          sessionId: child.id,
          model: {
            providerID: TASK_FIXTURE_PROVIDER_ID,
            modelID: TASK_FIXTURE_MODEL_ID,
          },
        })

        const childMessages = requireData<Array<{ info: MessageInfo; parts: Part[] }>>(
          await fixture.client.session.messages(
            { sessionID: child.id },
            { signal: AbortSignal.timeout(10_000) }
          ),
          "read child messages"
        )
        const childAssistant = childMessages.find(
          (message) => message.info.role === "assistant"
        )
        expect(childAssistant?.info).toMatchObject({
          providerID: TASK_FIXTURE_PROVIDER_ID,
          modelID: TASK_FIXTURE_MODEL_ID,
          agent: "general",
        })
        expect(textParts(childMessages.flatMap((message) => message.parts))).toContain(
          CHILD_TEXT
        )

        const statusPart = completedTool(childMessages, "remote_status")
        expect(statusPart.state.metadata).toMatchObject({
          executor: "ssh",
          targetAlias: TASK_FIXTURE_ALIAS,
          remoteWorkdir: TASK_FIXTURE_WORKDIR,
          controlMaster: "healthy",
          identity: {
            hostname: "task3-remote-host",
            user: "task3-remote-user",
            workdir: TASK_FIXTURE_WORKDIR,
          },
        })
        expect(JSON.parse(statusPart.state.output)).toMatchObject({
          executor: "ssh",
          controlMaster: "healthy",
        })

        const bashPart = completedToolWithCommand(
          childMessages,
          "bash",
          `printf ${LOCAL_EXECUTION_CANARY}`
        )
        expect(bashPart.state.metadata).toMatchObject({
          executor: "ssh",
          workdir: TASK_FIXTURE_WORKDIR,
        })
        expect(bashPart.state.output).toContain(SSH_FIXTURE_CHILD_OUTPUT.trim())
        expect(bashPart.state.output).not.toContain(LOCAL_EXECUTION_CANARY)

        const requests = fixture.provider.requests
        expect(requests.map((request) => request.matchedStep)).toEqual([
          "single root calls remote_status",
          "root calls Task",
          "child calls remote_status",
          "child calls SSH-backed Bash",
          "child completes",
          "root completes",
        ])
        expect(requests).toHaveLength(6)
        for (const request of requests) {
          expect(request.headers.authorization).toBe("Bearer fixture-api-key")
        }

        const rootRequests = requests.filter(
          (request) => request.headers["x-parent-session-id"] === undefined
        )
        expect(rootRequests).toHaveLength(3)
        for (const request of rootRequests) {
          expect(request.headers["x-session-affinity"]).toBe(root.id)
          expect(request.headers["x-session-id"]).toBe(root.id)
          expect(systemPrompt(request)).toContain("Rules for Working Through OpenCode SSH")
          expect(systemPrompt(request)).toContain("OpenCode SSH remote project context:")
          expect(systemPrompt(request)).not.toContain(REMOTE_AGENTS_MARKER)
        }

        const childRequests = requests.filter(
          (request) => request.headers["x-parent-session-id"] === root.id
        )
        expect(childRequests).toHaveLength(3)
        for (const request of childRequests) {
          expect(request.headers["x-session-affinity"]).toBe(child.id)
          expect(request.headers["x-session-id"]).toBe(child.id)
          expect(systemPrompt(request)).toContain("Rules for Working Through OpenCode SSH")
          expect(systemPrompt(request)).toContain("OpenCode SSH remote project context:")
          expect(systemPrompt(request)).toContain(`SSH alias: ${TASK_FIXTURE_ALIAS}`)
          expect(systemPrompt(request)).toContain(`Remote workspace: ${TASK_FIXTURE_WORKDIR}`)
          expect(systemPrompt(request)).not.toContain(REMOTE_AGENTS_MARKER)

          const tools = providerTools(request)
          expect(tools.get("remote_status")?.description).toContain(
            "Verify the active OpenCode SSH target"
          )
          expect(tools.get("bash")?.description).toContain(
            "one-shot POSIX shell on the remote machine"
          )
          expect(tools.has("task")).toBe(false)
        }

        await assertSshScenario(fixture, [
          [realpathInput(), 1],
          [sshInput(IDENTITY_COMMAND), 2],
          [sshInput(`printf ${LOCAL_EXECUTION_CANARY}`), 1],
        ])
      } catch (error) {
        scenarioError = error
      }

      await finishTaskFixture(fixture, scenarioError, "Task scenario")
    },
    TASK_SCENARIO_TIMEOUT_MS
  )

  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "runs concurrent direct siblings and clamps configured depth seven",
    async () => {
      if (installedOpenCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }
      const script = siblingProviderScript("complete")
      const fixture = await startInstalledOpenCodeTaskFixture({
        openCode: installedOpenCode,
        steps: script.steps,
        configOverride: task3Config(7),
        extraSshResponses: [
          {
            input: sshInput(ROOT_VERIFY_COMMAND),
            stdout: ROOT_VERIFY_OUTPUT,
          },
        ],
      })
      activeFixtures.add(fixture)
      let scenarioError: unknown

      try {
        const root = await createReadyRoot(
          fixture,
          "Concurrent sibling fixture",
          allowAllPermission()
        )
        const result = requireData<{ info: unknown; parts: Part[] }>(
          await fixture.client.session.prompt(
            rootPrompt(root.id, SIBLING_ROOT_PROMPT),
            { signal: AbortSignal.timeout(60_000) }
          ),
          "prompt concurrent sibling root"
        )
        expect(textParts(result.parts)).toContain("Root verified both direct children.")
        expect(script.barrier.arrivedKinds).toEqual(new Set(["explore", "custom"]))
        expect(script.barrier.releaseArrivalCounts).toEqual([2, 2])

        const children = await sessionChildren(fixture, root.id)
        expect(children).toHaveLength(2)
        expect(new Set(children.map((child) => child.parentID))).toEqual(new Set([root.id]))
        expect(new Set(children.map((child) => child.agent))).toEqual(
          new Set(["explore", CUSTOM_AGENT])
        )

        const rootMessages = await sessionMessages(fixture, root.id)
        const taskParts = completedToolParts(rootMessages, "task")
        expect(taskParts).toHaveLength(2)
        expect(
          new Set(taskParts.map((part) => part.state.metadata.sessionId))
        ).toEqual(new Set(children.map((child) => child.id)))
        const rootVerify = completedToolWithCommand(
          rootMessages,
          "bash",
          ROOT_VERIFY_COMMAND
        )
        expect(rootVerify.state.output).toContain(ROOT_VERIFY_OUTPUT.trim())

        for (const child of children) {
          expect(await sessionChildren(fixture, child.id)).toEqual([])
          const messages = await sessionMessages(fixture, child.id)
          const status = completedTool(messages, "remote_status")
          expect(status.state.metadata).toMatchObject({
            executor: "ssh",
            controlMaster: "healthy",
            subagentPolicy: {
              requestedDepth: 7,
              effectiveDepth: 1,
              depthWasNarrowed: true,
              taskPrimaryOnly: true,
            },
          })
        }

        const childRequests = fixture.provider.requests.filter(hasParentHeader)
        expect(childRequests).toHaveLength(4)
        expect(
          new Set(childRequests.map((request) => request.headers["x-session-id"]))
        ).toEqual(new Set(children.map((child) => child.id)))
        expect(new Set(childRequests.map(childKind))).toEqual(
          new Set(["explore", "custom"])
        )
        for (const request of childRequests) {
          assertChildRequestContext(request, root.id)
          const tools = providerTools(request)
          expect(tools.has("task")).toBe(false)
          if (childKind(request) === "explore") {
            expect(tools.has("write")).toBe(false)
            expect(tools.has("edit")).toBe(false)
            expect(tools.has("apply_patch")).toBe(false)
          } else {
            expect(tools.has("write")).toBe(true)
            expect(tools.has("edit")).toBe(true)
            expect(systemPrompt(request)).toContain(CUSTOM_AGENT_PROMPT)
          }
        }

        await assertSshScenario(fixture, [
          [realpathInput(), 1],
          [sshInput(IDENTITY_COMMAND), 3],
          [sshInput(ROOT_VERIFY_COMMAND), 1],
        ])
      } catch (error) {
        scenarioError = error
      }
      await finishTaskFixture(fixture, scenarioError, "Sibling Task scenario")
    },
    TASK_SCENARIO_TIMEOUT_MS
  )

  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "preserves an inherited session deny for read",
    async () => {
      if (installedOpenCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }
      const fixture = await startInstalledOpenCodeTaskFixture({
        openCode: installedOpenCode,
        steps: remoteStatusDenyProviderScript(),
      })
      activeFixtures.add(fixture)
      let scenarioError: unknown

      try {
        const root = await createReadyRoot(
          fixture,
          "Inherited read deny fixture",
          [{ permission: "read", pattern: "*", action: "deny" }]
        )
        const result = requireData<{ info: unknown; parts: Part[] }>(
          await fixture.client.session.prompt(rootPrompt(root.id, DENY_ROOT_PROMPT), {
            signal: AbortSignal.timeout(45_000),
          }),
          "prompt inherited read deny root"
        )
        expect(textParts(result.parts)).toContain("Root observed the child safety stop.")

        const [child] = await sessionChildren(fixture, root.id)
        expect(child).toBeDefined()
        expect(child.permission).toContainEqual({
          permission: "read",
          pattern: "*",
          action: "deny",
        })
        expect(await sessionChildren(fixture, child.id)).toEqual([])
        const requests = fixture.provider.requests.filter(hasParentHeader)
        expect(requests).toHaveLength(2)
        expect(providerTools(requests[0]).has("remote_status")).toBe(true)
        expect(providerTools(requests[0]).has("read")).toBe(false)
        const childSystem = systemPrompt(requests[0])
        expect(childSystem).toContain("Rules for Working Through OpenCode SSH")
        expect(childSystem).toContain(
          "receives this guidance and must separately satisfy"
        )
        expect(childSystem).toContain("host policy hides")
        expect(childSystem).toContain("required tool cannot proceed")

        const childMessages = await sessionMessages(fixture, child.id)
        expect(textParts(childMessages.flatMap((message) => message.parts))).toContain(
          "Child stopped because read is unavailable."
        )
        expect(toolParts(childMessages).map((part) => part.tool)).toEqual([
          "remote_status",
        ])
        await assertSshScenario(fixture, [[sshInput(IDENTITY_COMMAND), 2]])
      } catch (error) {
        scenarioError = error
      }
      await finishTaskFixture(fixture, scenarioError, "Deny Task scenario")
    },
    TASK_SCENARIO_TIMEOUT_MS
  )

  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "preserves explicit subagent depth zero without creating a child",
    async () => {
      if (installedOpenCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }
      const fixture = await startInstalledOpenCodeTaskFixture({
        openCode: installedOpenCode,
        steps: depthZeroProviderScript(),
        configOverride: { subagent_depth: 0 },
      })
      activeFixtures.add(fixture)
      let scenarioError: unknown

      try {
        const root = await createReadyRoot(
          fixture,
          "Depth zero fixture",
          allowAllPermission()
        )
        const result = requireData<{ info: unknown; parts: Part[] }>(
          await fixture.client.session.prompt(rootPrompt(root.id, DEPTH_ZERO_PROMPT), {
            signal: AbortSignal.timeout(45_000),
          }),
          "prompt depth zero root"
        )
        expect(textParts(result.parts)).toContain("Root observed depth zero rejection.")
        expect(await sessionChildren(fixture, root.id)).toEqual([])

        const rootRequests = fixture.provider.requests.filter(
          (request) => !hasParentHeader(request)
        )
        expect(rootRequests).toHaveLength(3)
        expect(providerTools(rootRequests[0]).has("task")).toBe(true)
        const messages = await sessionMessages(fixture, root.id)
        const task = toolParts(messages).find((part) => part.tool === "task")
        expect(task?.state.status).toBe("error")
        expect(task?.state.status === "error" ? task.state.error : "").toContain(
          "Subagent depth limit reached (0)"
        )
        await assertSshScenario(fixture, [[sshInput(IDENTITY_COMMAND), 1]])
      } catch (error) {
        scenarioError = error
      }
      await finishTaskFixture(fixture, scenarioError, "Depth-zero Task scenario")
    },
    TASK_SCENARIO_TIMEOUT_MS
  )

  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "propagates root session abort to two child SSH slaves without retry",
    async () => {
      if (installedOpenCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }
      const script = siblingProviderScript("cancel")
      const fixture = await startInstalledOpenCodeTaskFixture({
        openCode: installedOpenCode,
        steps: script.steps,
        configOverride: task3Config(7),
        extraSshResponses: [
          ...Object.values(LONG_COMMANDS).map((command) => ({
            input: sshInput(command),
            delayMs: 60_000,
            trackPid: true,
          })),
        ],
      })
      activeFixtures.add(fixture)
      let scenarioError: unknown

      try {
        const root = await createReadyRoot(
          fixture,
          "Cancellation fixture",
          allowAllPermission()
        )
        const prompt = fixture.client.session.prompt(
          rootPrompt(root.id, CANCELLATION_ROOT_PROMPT),
          { signal: AbortSignal.timeout(60_000) }
        )
        const started = await fixture.waitForSshPidRecords({
          event: "started",
          count: 2,
          timeoutMs: 30_000,
        })
        expect(new Set(started.map((record) => record.input))).toEqual(
          new Set(Object.values(LONG_COMMANDS).map(sshInput))
        )
        expect(new Set(started.map((record) => record.pid)).size).toBe(2)

        const aborted = requireData<boolean>(
          await fixture.client.session.abort(
            { sessionID: root.id },
            { signal: AbortSignal.timeout(20_000) }
          ),
          "abort cancellation root"
        )
        expect(aborted).toBe(true)
        await boundedPromise(prompt, 20_000, "root prompt did not settle after session abort")
        const exited = await fixture.waitForSshPidRecords({
          event: "exited",
          count: 2,
          timeoutMs: 20_000,
        })
        expect(new Set(exited.map((record) => record.pid))).toEqual(
          new Set(started.map((record) => record.pid))
        )
        await Promise.all(
          started.map((record) => waitForPidExit(record.pid, 5_000))
        )
        for (const record of started) {
          expect(() => process.kill(record.pid, 0)).toThrow()
        }

        const children = await sessionChildren(fixture, root.id)
        expect(children).toHaveLength(2)
        expect(new Set(children.map((child) => child.agent))).toEqual(
          new Set([CANCELLATION_AGENT, CUSTOM_AGENT])
        )
        for (const child of children) {
          expect(await sessionChildren(fixture, child.id)).toEqual([])
          const messages = await sessionMessages(fixture, child.id)
          expect(completedTool(messages, "remote_status").state.metadata).toMatchObject({
            executor: "ssh",
            controlMaster: "healthy",
          })
          const kind: ChildKind =
            child.agent === CANCELLATION_AGENT ? "explore" : "custom"
          const longParts = toolParts(messages).filter(
            (part) =>
              part.tool === "bash" &&
              "input" in part.state &&
              part.state.input.command === LONG_COMMANDS[kind]
          )
          expect(longParts).toHaveLength(1)
          expect(longParts[0].state.status).toBe("error")
          expect(
            toolParts(messages).some(
              (part) =>
                (part.tool === "bash" || part.tool === "task") &&
                (part.state.status === "pending" || part.state.status === "running")
            )
          ).toBe(false)
        }
        const rootMessages = await sessionMessages(fixture, root.id)
        const rootTasks = toolParts(rootMessages).filter((part) => part.tool === "task")
        expect(rootTasks).toHaveLength(2)
        expect(rootTasks.map((part) => part.state.status)).toEqual(["error", "error"])
        expect(
          toolParts(rootMessages).some(
            (part) =>
              (part.tool === "bash" || part.tool === "task") &&
              (part.state.status === "pending" || part.state.status === "running")
          )
        ).toBe(false)
        await assertSshScenario(fixture, [
          [realpathInput(), 2],
          [sshInput(IDENTITY_COMMAND), 3],
          [sshInput(LONG_COMMANDS.explore), 1],
          [sshInput(LONG_COMMANDS.custom), 1],
        ])
        expect(script.barrier.releaseArrivalCounts).toEqual([2, 2])
        expect(fixture.provider.requests).toHaveLength(7)
      } catch (error) {
        scenarioError = error
      }
      await finishTaskFixture(fixture, scenarioError, "Cancellation Task scenario")
    },
    TASK_SCENARIO_TIMEOUT_MS
  )

  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "resumes one completed direct child when startup capability is established",
    async () => {
      if (installedOpenCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }
      const exactExpectedVersion = installedOpenCode.expectedVersion
      let fixture: InstalledOpenCodeTaskFixture | undefined
      let sshInputsBeforeBlockedMutation: string[] | undefined
      let sftpCallsBeforeBlockedMutation: string[][] | undefined
      const activeResumeFixture = () => {
        if (!fixture) {
          throw new Error("Resume fixture was unavailable at the preflight rejection boundary")
        }
        return fixture
      }
      const script = resumeProviderScript({
        async beforeBlockedProjectTool() {
          const activeFixture = activeResumeFixture()
          sshInputsBeforeBlockedMutation = await activeFixture.readSshInputs()
          sftpCallsBeforeBlockedMutation = await activeFixture.readSftpCalls()
        },
        async afterBlockedProjectToolResult() {
          const activeFixture = activeResumeFixture()
          if (!sshInputsBeforeBlockedMutation || !sftpCallsBeforeBlockedMutation) {
            throw new Error("Blocked project-tool operation logs were not snapshotted")
          }
          expect(await activeFixture.readSshInputs()).toEqual(
            sshInputsBeforeBlockedMutation
          )
          expect(await activeFixture.readSftpCalls()).toEqual(
            sftpCallsBeforeBlockedMutation
          )
          await expect(activeFixture.readRemoteFile(RESUME_WRITE_PATH)).rejects.toMatchObject({
            code: "ENOENT",
          })
        },
      })
      let launchState:
        | {
            installedVersion: string
            taskResumeEnabled: boolean
            expectedTaskResumeEnabled: boolean
          }
        | undefined
      fixture = await startInstalledOpenCodeTaskFixture({
        openCode: installedOpenCode,
        steps: (state) => {
          if (exactExpectedVersion !== undefined) {
            expect(state.installedVersion).toBe(exactExpectedVersion)
          }
          const expectedTaskResumeEnabled = true
          expect(state.taskResumeEnabled).toBe(expectedTaskResumeEnabled)
          launchState = { ...state, expectedTaskResumeEnabled }
          return script.steps(expectedTaskResumeEnabled)
        },
        configOverride: { permission: { edit: "allow" } },
        enableFakeRemoteFilesystem: true,
      })
      activeFixtures.add(fixture)
      let scenarioError: unknown

      try {
        const expectedTaskResumeEnabled = true
        if (exactExpectedVersion !== undefined) {
          expect(fixture.installedVersion).toBe(exactExpectedVersion)
          expect(fixture.taskResumeEnabled).toBe(true)
        }
        expect(launchState).toEqual({
          installedVersion: fixture.installedVersion,
          taskResumeEnabled: fixture.taskResumeEnabled,
          expectedTaskResumeEnabled,
        })
        expect(fixture.taskResumeEnabled).toBe(expectedTaskResumeEnabled)

        const root = await createReadyRoot(fixture, "Same-launch resume fixture")
        expect(root.permission).toBeUndefined()
        const result = requireData<{ info: unknown; parts: Part[] }>(
          await fixture.client.session.prompt(
            rootPrompt(root.id, RESUME_ROOT_PROMPT),
            { signal: AbortSignal.timeout(60_000) }
          ),
          "prompt same-launch resume root"
        )
        expect(textParts(result.parts)).toContain(
          expectedTaskResumeEnabled
            ? RESUME_ENABLED_ROOT_TEXT
            : RESUME_DISABLED_ROOT_TEXT
        )

        const rootMessages = await sessionMessages(fixture, root.id)
        expect(completedTool(rootMessages, "remote_status").state.metadata).toMatchObject({
          executor: "ssh",
          controlMaster: "healthy",
        })
        const rootTasks = toolParts(rootMessages).filter(
          (part) => part.tool === "task"
        )
        expect(rootTasks).toHaveLength(expectedTaskResumeEnabled ? 2 : 3)
        const [freshTask, resumeTask] = rootTasks
        if (freshTask.state.status !== "completed") {
          throw new Error("Expected the initial fresh Task to complete")
        }
        expect(freshTask.state).toMatchObject({
          input: { subagent_type: "general" },
          metadata: { parentSessionId: root.id },
        })
        expect(freshTask.state.input).not.toHaveProperty("task_id")
        expect(freshTask.state.input).not.toHaveProperty("background", true)

        const modelVisibleTaskID = script.modelVisibleTaskID
        if (!modelVisibleTaskID) {
          throw new Error("Root model-visible Task result did not provide a task ID")
        }
        expect(script.observedChildID).toBe(modelVisibleTaskID)
        expect(freshTask.state.metadata).toMatchObject({
          sessionId: modelVisibleTaskID,
        })
        expect(resumeTask.state.input).toMatchObject({
          task_id: modelVisibleTaskID,
          subagent_type: "general",
        })

        const children = await sessionChildren(fixture, root.id)
        expect(children).toHaveLength(expectedTaskResumeEnabled ? 1 : 2)
        const child = children.find((candidate) => candidate.id === modelVisibleTaskID)
        if (!child) {
          throw new Error("Model-visible Task ID did not identify an actual root child")
        }
        expect(child).toMatchObject({ parentID: root.id, agent: "general" })
        expect(script.observedChildID).toBe(child.id)
        expect(script.modelVisibleTaskID).toBe(child.id)
        expect(await sessionChildren(fixture, child.id)).toEqual([])

        const childMessages = await sessionMessages(fixture, child.id)
        const childText = textParts(
          childMessages.flatMap((message) => message.parts)
        )
        expect(childText).toContain(RESUME_INITIAL_TEXT)
        expect(
          childText.some((text) => text.includes(RESUME_INITIAL_CONTEXT_MARKER))
        ).toBe(true)
        expect(
          [...toolParts(rootMessages), ...toolParts(childMessages)].some(
            (part) =>
              part.state.status === "pending" || part.state.status === "running"
          )
        ).toBe(false)

        const requests = fixture.provider.requests
        const rootRequests = requests.filter((request) => !hasParentHeader(request))
        const childRequests = requests.filter(hasParentHeader)
        expect(rootRequests).toHaveLength(expectedTaskResumeEnabled ? 4 : 5)
        for (const request of requests) {
          assertResumeGuidance(request, expectedTaskResumeEnabled)
        }
        for (const request of childRequests) {
          assertChildRequestContext(request, root.id)
          expect(providerTools(request).has("task")).toBe(false)
        }
        expect(
          new Set(childRequests.map((request) => request.headers["x-session-id"]))
        ).toEqual(new Set(children.map((candidate) => candidate.id)))
        const initialChildRequests = childRequests.filter(
          (request) => request.headers["x-session-id"] === child.id
        )

        if (expectedTaskResumeEnabled) {
          if (resumeTask.state.status !== "completed") {
            throw new Error("Expected the enabled Task resume to complete")
          }
          expect(resumeTask.state.metadata).toMatchObject({
            parentSessionId: root.id,
            sessionId: child.id,
          })
          expect(
            completedToolParts(rootMessages, "task").map(
              (part) => part.state.metadata.sessionId
            )
          ).toEqual([child.id, child.id])

          expect(initialChildRequests).toHaveLength(6)
          const resumedRequests = initialChildRequests.filter((request) =>
            providerMessageTexts(request, "user").some((text) =>
              text.includes(RESUME_CHILD_MARKER)
            )
          )
          expect(resumedRequests).toHaveLength(4)
          for (const request of resumedRequests) {
            expect(
              providerMessageTexts(request, "user").some((text) =>
                text.includes(RESUME_INITIAL_CONTEXT_MARKER)
              )
            ).toBe(true)
            expect(providerMessageTexts(request, "assistant")).toContain(
              RESUME_INITIAL_TEXT
            )
          }
          expect(childText).toContain(RESUME_CHILD_TEXT)
          expect(
            childText.some((text) => text.includes(RESUME_CHILD_MARKER))
          ).toBe(true)
          expect(toolParts(childMessages).map((part) => part.tool)).toEqual([
            "remote_status",
            "write",
            "remote_status",
            "write",
          ])
          const resumedMutations = toolParts(childMessages).filter(
            (part) =>
              part.tool === "write" &&
              "input" in part.state &&
              part.state.input.filePath === RESUME_WRITE_PATH &&
              part.state.input.content === RESUME_WRITE_CONTENT
          )
          expect(resumedMutations).toHaveLength(2)
          const [blockedMutation, completedMutation] = resumedMutations
          expect(blockedMutation.state.status).toBe("error")
          expect(
            blockedMutation.state.status === "error"
              ? blockedMutation.state.error
              : ""
          ).toMatch(/preflight/iu)
          if (completedMutation.state.status !== "completed") {
            throw new Error(
              `Expected resumed write to complete after renewed preflight: ${
                completedMutation.state.status === "error"
                  ? completedMutation.state.error
                  : completedMutation.state.status
              }`
            )
          }
          expect(
            completedMutation.state.status === "completed"
              ? completedMutation.state.output
              : ""
          ).toBe("Wrote file successfully.")
          expect(
            completedMutation.state.status === "completed"
              ? completedMutation.state.metadata
              : undefined
          ).toMatchObject({
            filepath: RESUME_WRITE_PATH,
            exists: false,
          })
          expect(script.blockedPreflightError).toMatch(/preflight/iu)
          expect(completedToolParts(childMessages, "remote_status")).toHaveLength(2)
          expect(await fixture.readRemoteFile(RESUME_WRITE_PATH)).toBe(
            RESUME_WRITE_CONTENT
          )
          expect(requests.map((request) => request.matchedStep)).toEqual([
            "resume root calls remote_status",
            "resume root creates fresh Task",
            "fresh resume child calls remote_status",
            "fresh resume child completes",
            "root resumes model-visible Task",
            "resumed child attempts project write before preflight",
            "resumed child observes preflight rejection and repeats remote_status",
            "resumed child performs SFTP-backed write",
            "resumed child completes",
            "root completes enabled resume",
          ])
          await assertResumeWriteScenario(fixture)
        } else {
          if (resumeTask.state.status !== "error") {
            throw new Error("Expected Task resume without launcher capability to fail")
          }
          expect(resumeTask.state.error).toContain(
            "Task resume capability was not established for this launch"
          )
          expect(script.blockedPreflightError).toBeUndefined()
          expect(initialChildRequests).toHaveLength(2)
          expect(
            childRequests.some((request) =>
              providerMessageTexts(request, "user").some((text) =>
                text.includes(RESUME_CHILD_MARKER)
              )
            )
          ).toBe(false)
          expect(
            childText.some((text) => text.includes(RESUME_CHILD_MARKER))
          ).toBe(false)
          expect(childText).not.toContain(RESUME_CHILD_TEXT)
          expect(toolParts(childMessages).map((part) => part.tool)).toEqual([
            "remote_status",
          ])

          const fallbackTask = rootTasks[2]
          if (fallbackTask.state.status !== "completed") {
            throw new Error("Expected a fresh Task to remain available after resume rejection")
          }
          expect(fallbackTask.state.input).toMatchObject({
            subagent_type: "general",
          })
          expect(fallbackTask.state.input).not.toHaveProperty("task_id")
          expect(fallbackTask.state.metadata).toMatchObject({
            parentSessionId: root.id,
          })
          const fallbackID = fallbackTask.state.metadata.sessionId
          if (typeof fallbackID !== "string") {
            throw new Error("Fresh fallback Task omitted its child session ID")
          }
          expect(fallbackID).not.toBe(child.id)
          const fallbackChild = children.find(
            (candidate) => candidate.id === fallbackID
          )
          if (!fallbackChild) {
            throw new Error("Fresh fallback Task did not create the reported child")
          }
          expect(fallbackChild).toMatchObject({
            parentID: root.id,
            agent: "general",
          })
          expect(await sessionChildren(fixture, fallbackChild.id)).toEqual([])
          const fallbackMessages = await sessionMessages(fixture, fallbackChild.id)
          expect(textParts(fallbackMessages.flatMap((message) => message.parts))).toContain(
            RESUME_FALLBACK_TEXT
          )
          expect(completedTool(fallbackMessages, "remote_status").state.metadata).toMatchObject({
            executor: "ssh",
            controlMaster: "healthy",
          })
          expect(toolParts(fallbackMessages).map((part) => part.tool)).toEqual([
            "remote_status",
          ])
          expect(
            childRequests.filter(
              (request) => request.headers["x-session-id"] === fallbackChild.id
            )
          ).toHaveLength(2)
          expect(requests.map((request) => request.matchedStep)).toEqual([
            "resume root calls remote_status",
            "resume root creates fresh Task",
            "fresh resume child calls remote_status",
            "fresh resume child completes",
            "root resumes model-visible Task",
            "root starts fresh Task after disabled resume",
            "fresh fallback child calls remote_status",
            "fresh fallback child completes",
            "root records disabled resume and fresh fallback",
          ])
          await assertSshScenario(fixture, [[sshInput(IDENTITY_COMMAND), 3]])
        }
      } catch (error) {
        scenarioError = error
      }
      await finishTaskFixture(fixture, scenarioError, "Resume Task scenario")
    },
    TASK_SCENARIO_TIMEOUT_MS
  )
})

function providerScript(): ScriptedProviderStep[] {
  const rootStatusID = "call_single_root_status"
  return [
    ...rootPreflightProviderSteps(ROOT_PROMPT, "single"),
    {
      name: "root calls Task",
      match: (request) =>
        request.headers["x-parent-session-id"] === undefined &&
        providerTools(request).has("task") &&
        requestBodyContains(request, ROOT_PROMPT) &&
        requestBodyContains(request, rootStatusID),
      response: {
        type: "tool-call",
        id: "call_root_task",
        name: "task",
        arguments: {
          description: "Verify remote canary",
          prompt: `Call remote_status, then call bash with exactly \"printf ${LOCAL_EXECUTION_CANARY}\" and report the result.`,
          subagent_type: "general",
        },
      },
    },
    {
      name: "child calls remote_status",
      match: (request) =>
        hasParentHeader(request) && !requestBodyContains(request, "call_child_status"),
      response: {
        type: "tool-call",
        id: "call_child_status",
        name: "remote_status",
        arguments: {},
      },
    },
    {
      name: "child calls SSH-backed Bash",
      match: (request) =>
        hasParentHeader(request) &&
        requestBodyContains(request, "call_child_status") &&
        !requestBodyContains(request, "call_child_bash"),
      response: {
        type: "tool-call",
        id: "call_child_bash",
        name: "bash",
        arguments: {
          command: `printf ${LOCAL_EXECUTION_CANARY}`,
          description: "Run remote canary",
        },
      },
    },
    {
      name: "child completes",
      match: (request) =>
        hasParentHeader(request) && requestBodyContains(request, "call_child_bash"),
      response: { type: "text", text: CHILD_TEXT },
    },
    {
      name: "root completes",
      match: (request) =>
        request.headers["x-parent-session-id"] === undefined &&
        requestBodyContains(request, "call_root_task"),
      response: { type: "text", text: ROOT_TEXT },
    },
  ]
}

interface ChildRequestBarrier {
  readonly arrivedKinds: Set<ChildKind>
  readonly releaseArrivalCounts: number[]
  arrive(kind: ChildKind): Promise<void>
}

function siblingProviderScript(mode: "complete" | "cancel"): {
  steps: ScriptedProviderStep[]
  barrier: ChildRequestBarrier
} {
  const barrier = childRequestBarrier()
  const prompt = mode === "complete" ? SIBLING_ROOT_PROMPT : CANCELLATION_ROOT_PROMPT
  const rootStatusID = `call_${mode}_root_status`
  const steps: ScriptedProviderStep[] = [
    ...rootPreflightProviderSteps(prompt, mode),
    {
      name: `${mode} root calls two Tasks`,
      match: (request) =>
        !hasParentHeader(request) &&
        providerTools(request).has("task") &&
        requestBodyContains(request, prompt) &&
        requestBodyContains(request, rootStatusID),
      response: {
        type: "tool-calls",
        calls: [
          {
            id: "call_task3_root_explore",
            name: "task",
            arguments: {
              description: "Verify explore child",
              prompt: childPrompt("explore", mode),
              subagent_type: mode === "cancel" ? CANCELLATION_AGENT : "explore",
            },
          },
          {
            id: "call_task3_root_custom",
            name: "task",
            arguments: {
              description: "Verify custom child",
              prompt: childPrompt("custom", mode),
              subagent_type: CUSTOM_AGENT,
            },
          },
        ],
      },
    },
  ]

  for (const kind of ["explore", "custom"] as const) {
    const statusID = `call_task3_${kind}_status`
    steps.push({
      name: `${mode} ${kind} child calls remote_status after sibling barrier`,
      match: (request) =>
        hasParentHeader(request) &&
        childKind(request) === kind &&
        !requestBodyContains(request, statusID),
      response: async () => {
        await barrier.arrive(kind)
        return {
          type: "tool-call",
          id: statusID,
          name: "remote_status",
          arguments: {},
        }
      },
    })

    if (mode === "complete") {
      steps.push({
        name: `${kind} child completes`,
        match: (request) =>
          hasParentHeader(request) &&
          childKind(request) === kind &&
          requestBodyContains(request, statusID),
        response: {
          type: "text",
          text: `${kind} child independently verified the remote target.`,
        },
      })
    } else {
      steps.push({
        name: `${kind} child starts cancellable Bash`,
        match: (request) =>
          hasParentHeader(request) &&
          childKind(request) === kind &&
          requestBodyContains(request, statusID),
        response: {
          type: "tool-call",
          id: `call_task3_${kind}_long`,
          name: "bash",
          arguments: {
            command: LONG_COMMANDS[kind],
            description: "Run cancellable remote command",
          },
        },
      })
    }
  }

  if (mode === "complete") {
    steps.push(
      {
        name: "root remotely verifies both children",
        match: (request) =>
          !hasParentHeader(request) &&
          requestBodyContains(request, "call_task3_root_explore") &&
          requestBodyContains(request, "call_task3_root_custom") &&
          !requestBodyContains(request, "call_task3_root_verify"),
        response: {
          type: "tool-call",
          id: "call_task3_root_verify",
          name: "bash",
          arguments: {
            command: ROOT_VERIFY_COMMAND,
            description: "Verify final remote state",
          },
        },
      },
      {
        name: "root completes sibling verification",
        match: (request) =>
          !hasParentHeader(request) &&
          requestBodyContains(request, "call_task3_root_verify"),
        response: { type: "text", text: "Root verified both direct children." },
      }
    )
  } else {
    steps.push({
      name: "root settles cancelled Tasks",
      match: (request) =>
        !hasParentHeader(request) &&
        requestBodyContains(request, "call_task3_root_explore") &&
        requestBodyContains(request, "call_task3_root_custom"),
      response: { type: "text", text: "Root cancellation settled." },
    })
  }

  return { steps, barrier }
}

function remoteStatusDenyProviderScript(): ScriptedProviderStep[] {
  const rootStatusID = "call_deny_root_status"
  return [
    ...rootPreflightProviderSteps(DENY_ROOT_PROMPT, "deny"),
    {
      name: "deny root calls Task",
      match: (request) =>
        !hasParentHeader(request) &&
        requestBodyContains(request, DENY_ROOT_PROMPT) &&
        requestBodyContains(request, rootStatusID),
      response: {
        type: "tool-call",
        id: "call_task3_deny_task",
        name: "task",
        arguments: {
          description: "Respect inherited read deny",
          prompt:
            `${DENY_CHILD_MARKER}. Call remote_status. If read is unavailable after preflight, ` +
            "stop without calling read.",
          subagent_type: "general",
        },
      },
    },
    {
      name: "denied child calls remote_status",
      match: (request) =>
        hasParentHeader(request) &&
        requestBodyContains(request, DENY_CHILD_MARKER) &&
        !requestBodyContains(request, "call_deny_child_status"),
      response: {
        type: "tool-call",
        id: "call_deny_child_status",
        name: "remote_status",
        arguments: {},
      },
    },
    {
      name: "denied child stops without read",
      match: (request) =>
        hasParentHeader(request) &&
        requestBodyContains(request, "call_deny_child_status"),
      response: {
        type: "text",
        text: "Child stopped because read is unavailable.",
      },
    },
    {
      name: "deny root completes",
      match: (request) =>
        !hasParentHeader(request) &&
        requestBodyContains(request, "call_task3_deny_task"),
      response: { type: "text", text: "Root observed the child safety stop." },
    },
  ]
}

function depthZeroProviderScript(): ScriptedProviderStep[] {
  const rootStatusID = "call_depth_zero_root_status"
  return [
    ...rootPreflightProviderSteps(DEPTH_ZERO_PROMPT, "depth_zero"),
    {
      name: "depth zero root attempts Task",
      match: (request) =>
        !hasParentHeader(request) &&
        requestBodyContains(request, DEPTH_ZERO_PROMPT) &&
        requestBodyContains(request, rootStatusID),
      response: {
        type: "tool-call",
        id: "call_task3_depth_zero",
        name: "task",
        arguments: {
          description: "Attempt forbidden child",
          prompt: "This child must never be created.",
          subagent_type: "general",
        },
      },
    },
    {
      name: "depth zero root records rejection",
      match: (request) =>
        !hasParentHeader(request) &&
        requestBodyContains(request, "call_task3_depth_zero"),
      response: { type: "text", text: "Root observed depth zero rejection." },
    },
  ]
}

interface ResumeProviderScript {
  readonly observedChildID: string | undefined
  readonly modelVisibleTaskID: string | undefined
  readonly blockedPreflightError: string | undefined
  steps(expectedTaskResumeEnabled: boolean): ScriptedProviderStep[]
}

function resumeProviderScript(callbacks: {
  beforeBlockedProjectTool(): Promise<void>
  afterBlockedProjectToolResult(): Promise<void>
}): ResumeProviderScript {
  const freshTaskCallID = "call_resume_fresh_task"
  const freshStatusCallID = "call_resume_child_status"
  const resumeTaskCallID = "call_resume_task"
  const blockedMutationCallID = "call_resumed_child_write_before_preflight"
  const resumedStatusCallID = "call_resumed_child_status"
  const resumedMutationCallID = "call_resumed_child_write"
  const fallbackTaskCallID = "call_resume_fallback_task"
  const fallbackStatusCallID = "call_resume_fallback_status"
  let observedChildID: string | undefined
  let modelVisibleTaskID: string | undefined
  let blockedPreflightError: string | undefined
  let configured = false

  return {
    get observedChildID() {
      return observedChildID
    },
    get modelVisibleTaskID() {
      return modelVisibleTaskID
    },
    get blockedPreflightError() {
      return blockedPreflightError
    },
    steps(expectedTaskResumeEnabled) {
      if (configured) {
        throw new Error("Resume provider script was configured more than once")
      }
      configured = true
      const steps: ScriptedProviderStep[] = [
        ...rootPreflightProviderSteps(RESUME_ROOT_PROMPT, "resume"),
        {
          name: "resume root creates fresh Task",
          match: (request) =>
            !hasParentHeader(request) &&
            providerMessageContains(request, "user", RESUME_ROOT_PROMPT) &&
            providerHasToolCall(request, "call_resume_root_status"),
          response: {
            type: "tool-call",
            id: freshTaskCallID,
            name: "task",
            arguments: {
              description: "Create resumable child",
              prompt: `${RESUME_INITIAL_CONTEXT_MARKER}. Call remote_status. Preserve this context and report completion.`,
              subagent_type: "general",
            },
          },
        },
        {
          name: "fresh resume child calls remote_status",
          match: (request) =>
            hasParentHeader(request) &&
            providerMessageContains(
              request,
              "user",
              RESUME_INITIAL_CONTEXT_MARKER
            ) &&
            !providerHasToolCall(request, freshStatusCallID),
          response: (request) => {
            const captured = request.headers["x-session-id"]
            if (!captured) {
              throw new Error("Fresh resume child request omitted x-session-id")
            }
            if (observedChildID !== undefined && observedChildID !== captured) {
              throw new Error("Fresh resume child session ID changed")
            }
            observedChildID = captured
            return {
              type: "tool-call",
              id: freshStatusCallID,
              name: "remote_status",
              arguments: {},
            }
          },
        },
        {
          name: "fresh resume child completes",
          match: (request) =>
            hasParentHeader(request) &&
            providerMessageContains(
              request,
              "user",
              RESUME_INITIAL_CONTEXT_MARKER
            ) &&
            providerHasToolCall(request, freshStatusCallID) &&
            !providerMessageContains(request, "user", RESUME_CHILD_MARKER),
          response: { type: "text", text: RESUME_INITIAL_TEXT },
        },
        {
          name: "root resumes model-visible Task",
          match: (request) =>
            !hasParentHeader(request) &&
            providerToolResultText(request, freshTaskCallID)?.includes(
              RESUME_INITIAL_TEXT
            ) === true &&
            !providerHasToolCall(request, resumeTaskCallID),
          response: (request) => {
            const taskResult = providerToolResultText(request, freshTaskCallID)
            if (taskResult === undefined) {
              throw new Error("Fresh Task result was not visible to the root model")
            }
            const extractedTaskID = taskIDFromModelVisibleResult(taskResult)
            if (!observedChildID) {
              throw new Error("Fresh child ground-truth session ID was not observed")
            }
            if (extractedTaskID !== observedChildID) {
              throw new Error(
                `Model-visible Task ID ${JSON.stringify(
                  extractedTaskID
                )} did not equal observed child session ${JSON.stringify(
                  observedChildID
                )}`
              )
            }
            modelVisibleTaskID = extractedTaskID
            return {
              type: "tool-call",
              id: resumeTaskCallID,
              name: "task",
              arguments: {
                description: "Resume exact verified child",
                prompt:
                  `${RESUME_CHILD_MARKER}. Retain the prior context. First call write with filePath ` +
                  `${JSON.stringify(RESUME_WRITE_PATH)} and content ${JSON.stringify(
                    RESUME_WRITE_CONTENT
                  )}, and observe that renewed preflight is required. ` +
                  "Then call remote_status, retry the exact same write, and report completion.",
                subagent_type: "general",
                task_id: extractedTaskID,
              },
            }
          },
        },
      ]

      if (!expectedTaskResumeEnabled) {
        steps.push(
          {
            name: "root starts fresh Task after disabled resume",
            match: (request) =>
              !hasParentHeader(request) &&
              providerHasToolCall(request, resumeTaskCallID) &&
              providerToolResultText(request, resumeTaskCallID)?.includes(
                "Task resume capability was not established for this launch"
              ) === true &&
              !providerHasToolCall(request, fallbackTaskCallID),
            response: {
              type: "tool-call",
              id: fallbackTaskCallID,
              name: "task",
              arguments: {
                description: "Verify fresh Task fallback",
                prompt: `${RESUME_FALLBACK_MARKER}. Call remote_status and report that fresh Task remains available.`,
                subagent_type: "general",
              },
            },
          },
          {
            name: "fresh fallback child calls remote_status",
            match: (request) =>
              hasParentHeader(request) &&
              providerMessageContains(request, "user", RESUME_FALLBACK_MARKER) &&
              !providerHasToolCall(request, fallbackStatusCallID),
            response: {
              type: "tool-call",
              id: fallbackStatusCallID,
              name: "remote_status",
              arguments: {},
            },
          },
          {
            name: "fresh fallback child completes",
            match: (request) =>
              hasParentHeader(request) &&
              providerMessageContains(request, "user", RESUME_FALLBACK_MARKER) &&
              providerHasToolCall(request, fallbackStatusCallID),
            response: { type: "text", text: RESUME_FALLBACK_TEXT },
          },
          {
            name: "root records disabled resume and fresh fallback",
            match: (request) =>
              !hasParentHeader(request) &&
              providerToolResultText(request, fallbackTaskCallID)?.includes(
                RESUME_FALLBACK_TEXT
              ) === true,
            response: { type: "text", text: RESUME_DISABLED_ROOT_TEXT },
          }
        )
        return steps
      }

      steps.push(
        {
          name: "resumed child attempts project write before preflight",
          match: (request) =>
            hasParentHeader(request) &&
            providerMessageContains(request, "user", RESUME_CHILD_MARKER) &&
            !providerHasToolCall(request, blockedMutationCallID),
          response: async () => {
            await callbacks.beforeBlockedProjectTool()
            return {
              type: "tool-call",
              id: blockedMutationCallID,
              name: "write",
              arguments: {
                filePath: RESUME_WRITE_PATH,
                content: RESUME_WRITE_CONTENT,
              },
            }
          },
        },
        {
          name: "resumed child observes preflight rejection and repeats remote_status",
          match: (request) =>
            hasParentHeader(request) &&
            providerMessageContains(request, "user", RESUME_CHILD_MARKER) &&
            providerHasToolCall(request, blockedMutationCallID) &&
            /preflight/iu.test(
              providerToolResultText(request, blockedMutationCallID) ?? ""
            ) &&
            !providerHasToolCall(request, resumedStatusCallID),
          response: async (request) => {
            const error = providerToolResultText(request, blockedMutationCallID)
            if (error === undefined || !/preflight/iu.test(error)) {
              throw new Error("Resumed child did not receive the preflight rejection")
            }
            blockedPreflightError = error
            await callbacks.afterBlockedProjectToolResult()
            return {
              type: "tool-call",
              id: resumedStatusCallID,
              name: "remote_status",
              arguments: {},
            }
          },
        },
        {
          name: "resumed child performs SFTP-backed write",
          match: (request) =>
            hasParentHeader(request) &&
            providerMessageContains(request, "user", RESUME_CHILD_MARKER) &&
            providerHasToolCall(request, resumedStatusCallID) &&
            !providerHasToolCall(request, resumedMutationCallID),
          response: {
            type: "tool-call",
            id: resumedMutationCallID,
            name: "write",
            arguments: {
              filePath: RESUME_WRITE_PATH,
              content: RESUME_WRITE_CONTENT,
            },
          },
        },
        {
          name: "resumed child completes",
          match: (request) =>
            hasParentHeader(request) &&
            providerMessageContains(request, "user", RESUME_CHILD_MARKER) &&
            providerHasToolCall(request, resumedMutationCallID),
          response: { type: "text", text: RESUME_CHILD_TEXT },
        },
        {
          name: "root completes enabled resume",
          match: (request) =>
            !hasParentHeader(request) &&
            providerToolResultText(request, resumeTaskCallID)?.includes(
              RESUME_CHILD_TEXT
            ) === true,
          response: { type: "text", text: RESUME_ENABLED_ROOT_TEXT },
        }
      )
      return steps
    },
  }
}

function taskIDFromModelVisibleResult(output: string): string {
  const match = /^<task id="([^"\r\n]+)" state="completed">(?:\r?\n|$)/u.exec(
    output
  )
  if (!match) {
    throw new Error(
      `Root model-visible Task result had an unexpected shape: ${bounded(output)}`
    )
  }
  return match[1]
}

function rootPreflightProviderSteps(
  prompt: string,
  prefix: string
): ScriptedProviderStep[] {
  const statusID = `call_${prefix}_root_status`
  return [
    {
      name: `${prefix} root calls remote_status`,
      match: (request) =>
        !hasParentHeader(request) &&
        requestBodyContains(request, prompt) &&
        !requestBodyContains(request, statusID),
      response: {
        type: "tool-call",
        id: statusID,
        name: "remote_status",
        arguments: {},
      },
    },
  ]
}

function childRequestBarrier(): ChildRequestBarrier {
  const arrivedKinds = new Set<ChildKind>()
  const releaseArrivalCounts: number[] = []
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })

  return {
    arrivedKinds,
    releaseArrivalCounts,
    async arrive(kind) {
      if (arrivedKinds.has(kind)) {
        throw new Error(`Child ${kind} reached the sibling barrier more than once`)
      }
      arrivedKinds.add(kind)
      if (arrivedKinds.size === 2) release()
      await boundedPromise(
        released,
        8_000,
        `Timed out waiting for the sibling of ${kind}`
      )
      releaseArrivalCounts.push(arrivedKinds.size)
    },
  }
}

function childPrompt(kind: ChildKind, mode: "complete" | "cancel"): string {
  const marker = kind === "explore" ? EXPLORE_CHILD_MARKER : CUSTOM_CHILD_MARKER
  const final =
    mode === "complete"
      ? "Report that the remote target was independently verified."
      : `Then call bash with exactly ${JSON.stringify(LONG_COMMANDS[kind])} and wait.`
  return `${marker}. Call remote_status first. ${final}`
}

function task3Config(depth: number): InstalledOpenCodeConfigOverride {
  return {
    subagent_depth: depth,
    agent: {
      [CUSTOM_AGENT]: {
        mode: "subagent",
        description: "Task 3 mutation-capable fixture agent",
        prompt: CUSTOM_AGENT_PROMPT,
        permission: { task: "allow" },
      },
      [CANCELLATION_AGENT]: {
        mode: "subagent",
        description: "Task 3 cancellation fixture agent",
        permission: { task: "allow" },
      },
    },
  }
}

function sshInput(command: string): string {
  return `cd ${TASK_FIXTURE_WORKDIR} || exit $?\n${command}`
}

function realpathInput(): string {
  return `realpath -e -- ${TASK_FIXTURE_WORKDIR}`
}

function assertOpenCodeProvenance(
  fixture: InstalledOpenCodeTaskFixture
): void {
  if (installedOpenCode.kind !== "available") {
    throw new Error(`Required OpenCode selection failed: ${installedOpenCode.reason}`)
  }
  expect(fixture.provenance).toEqual({
    originalCommandPath: installedOpenCode.originalCommandPath,
    resolvedExecutable: installedOpenCode.resolvedExecutable,
    reportedVersion: fixture.installedVersion,
    probeChildExecutable: installedOpenCode.resolvedExecutable,
    serveChildExecutable: installedOpenCode.resolvedExecutable,
  })
  expect(fixture.installedVersion).toMatch(
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
  )
  if (installedOpenCode.expectedVersion !== undefined) {
    expect(fixture.installedVersion).toBe(installedOpenCode.expectedVersion)
  }
}

async function assertResumeWriteScenario(
  fixture: InstalledOpenCodeTaskFixture
): Promise<void> {
  const parentCommands = ["/srv", TASK_FIXTURE_WORKDIR].map(
    (directory) =>
      `if mkdir -- ${directory} 2>/dev/null; then printf CREATED; ` +
      `elif [ -d ${directory} ]; then printf EXISTS; else exit 1; fi`
  )
  const expectedCounts: ReadonlyArray<readonly [string, number]> = [
    [`cd ${TASK_FIXTURE_REQUESTED_WORKDIR} || exit $?\npwd -P`, 1],
    ["uname -s", 1],
    [
      `git -C ${TASK_FIXTURE_WORKDIR} rev-parse --is-inside-work-tree 2>/dev/null`,
      1,
    ],
    [realpathInput(), 7],
    [`realpath -e -- ${RESUME_WRITE_PATH}`, 7],
    [sshInput(IDENTITY_COMMAND), 3],
    ...parentCommands.map((command) => [command, 1] as const),
  ]
  const sshInputs = await fixture.readSshInputs()
  expect(sshInputs.some((input) => input.includes("AGENTS.md"))).toBe(false)
  const actualCounts = new Map<string, number>()
  for (const input of sshInputs) {
    actualCounts.set(input, (actualCounts.get(input) ?? 0) + 1)
  }
  for (const [input, count] of expectedCounts) {
    expect(actualCounts.get(input)).toBe(count)
    actualCounts.delete(input)
  }

  const sftpInputs = await fixture.readSftpInputs()
  expect(sftpInputs.map((input) => input.slice(0, input.indexOf(" ")))).toEqual([
    "get",
    "get",
    "get",
    "put",
    "get",
  ])
  for (const input of sftpInputs.filter((candidate) => candidate.startsWith("get "))) {
    expect(input.startsWith(`get ${RESUME_WRITE_PATH} `)).toBe(true)
    expect(input.endsWith("\n")).toBe(true)
  }
  const putInput = sftpInputs[3]
  const remoteTemp = putInput.slice(putInput.lastIndexOf(" ") + 1, -1)
  expect(remoteTemp).toMatch(
    /^\/srv\/opencode-task-fixture\/\.resume-sftp-proof\.txt\.opencode-[a-f0-9]{24}\.tmp$/u
  )

  const remainingInputs = [...actualCounts.entries()].flatMap(([input, count]) =>
    Array.from({ length: count }, () => input)
  )
  expect(remainingInputs).toHaveLength(4)
  expect(
    remainingInputs.filter((input) =>
      input.startsWith(
        `if mkdir -- ${TASK_FIXTURE_WORKDIR}/.opencode-lock-`
      )
    )
  ).toHaveLength(1)
  expect(
    remainingInputs.filter((input) =>
      input.startsWith(`if [ "$(cat -- ${TASK_FIXTURE_WORKDIR}/.opencode-lock-`)
    )
  ).toHaveLength(1)
  expect(
    remainingInputs.filter((input) =>
      input.startsWith(`if (umask 077; set -C; : > ${remoteTemp});`)
    )
  ).toHaveLength(1)
  expect(remainingInputs).toContain(
    `mv -fT -- ${remoteTemp} ${RESUME_WRITE_PATH}`
  )

  const expectedSshArgv = [
    "-T",
    "-S",
    fixture.socketPath,
    "-o",
    "ControlMaster=no",
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ProxyCommand=false",
    "--",
    TASK_FIXTURE_ALIAS,
    "sh",
    "-s",
  ]
  const remoteCalls = (await fixture.readSshCalls()).filter(
    (call) => call[0] === "-T"
  )
  expect(remoteCalls).toHaveLength(sshInputs.length)
  for (const call of remoteCalls) expect(call).toEqual(expectedSshArgv)

  const expectedSftpArgv = [
    "-b",
    "-",
    "-o",
    `ControlPath=${fixture.socketPath}`,
    "-o",
    "ControlMaster=no",
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ProxyCommand=false",
    "--",
    TASK_FIXTURE_ALIAS,
  ]
  const sftpCalls = await fixture.readSftpCalls()
  expect(sftpCalls).toHaveLength(5)
  for (const call of sftpCalls) expect(call).toEqual(expectedSftpArgv)
}

async function assertSshScenario(
  fixture: InstalledOpenCodeTaskFixture,
  scenarioCounts: ReadonlyArray<readonly [input: string, count: number]>
): Promise<void> {
  const startupCounts: ReadonlyArray<readonly [string, number]> = [
    [`cd ${TASK_FIXTURE_REQUESTED_WORKDIR} || exit $?\npwd -P`, 1],
    ["uname -s", 1],
    [
      `git -C ${TASK_FIXTURE_WORKDIR} rev-parse --is-inside-work-tree 2>/dev/null`,
      1,
    ],
  ]
  const expectedCounts = new Map([...startupCounts, ...scenarioCounts])
  const sshInputs = await fixture.readSshInputs()
  const actualCounts = new Map<string, number>()
  for (const input of sshInputs) {
    actualCounts.set(input, (actualCounts.get(input) ?? 0) + 1)
  }
  const sorted = (counts: ReadonlyMap<string, number>) =>
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
  expect(sorted(actualCounts)).toEqual(sorted(expectedCounts))
  expect(sshInputs.some((input) => input.includes("AGENTS.md"))).toBe(false)

  const expectedArgv = [
    "-T",
    "-S",
    fixture.socketPath,
    "-o",
    "ControlMaster=no",
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ProxyCommand=false",
    "--",
    TASK_FIXTURE_ALIAS,
    "sh",
    "-s",
  ]
  const remoteCalls = (await fixture.readSshCalls()).filter(
    (call) => call[0] === "-T"
  )
  expect(remoteCalls).toHaveLength(sshInputs.length)
  for (const call of remoteCalls) expect(call).toEqual(expectedArgv)
  expect(await fixture.readSftpCalls()).toEqual([])
}

function rootPrompt(sessionID: string, text: string) {
  return {
    sessionID,
    model: {
      providerID: TASK_FIXTURE_PROVIDER_ID,
      modelID: TASK_FIXTURE_MODEL_ID,
    },
    agent: "build",
    parts: [{ type: "text" as const, text }],
  }
}

function allowAllPermission(): NonNullable<Session["permission"]> {
  return [{ permission: "*", pattern: "*", action: "allow" }]
}

async function createReadyRoot(
  fixture: InstalledOpenCodeTaskFixture,
  title: string,
  permission?: NonNullable<Session["permission"]>
): Promise<Session> {
  assertOpenCodeProvenance(fixture)
  const root = requireData<Session>(
    await fixture.client.session.create(
      { title, agent: "build", ...(permission ? { permission } : {}) },
      { signal: AbortSignal.timeout(30_000) }
    ),
    "create Task 3 root session"
  )
  const ready = await fixture.waitForReady()
  expect(ready).toMatchObject({
    alias: TASK_FIXTURE_ALIAS,
    canonicalWorkdir: TASK_FIXTURE_WORKDIR,
  })
  return root
}

async function sessionChildren(
  fixture: InstalledOpenCodeTaskFixture,
  sessionID: string
): Promise<Session[]> {
  return requireData<Session[]>(
    await fixture.client.session.children(
      { sessionID },
      { signal: AbortSignal.timeout(10_000) }
    ),
    `list children for ${sessionID}`
  )
}

async function sessionMessages(
  fixture: InstalledOpenCodeTaskFixture,
  sessionID: string
): Promise<Array<{ info: MessageInfo; parts: Part[] }>> {
  return requireData<Array<{ info: MessageInfo; parts: Part[] }>>(
    await fixture.client.session.messages(
      { sessionID },
      { signal: AbortSignal.timeout(10_000) }
    ),
    `read messages for ${sessionID}`
  )
}

function toolParts(
  messages: Array<{ info: MessageInfo; parts: Part[] }>
): ToolPart[] {
  return messages
    .flatMap((message) => message.parts)
    .filter((part): part is ToolPart => part.type === "tool")
}

function completedToolParts(
  messages: Array<{ info: MessageInfo; parts: Part[] }>,
  name: string
): CompletedToolPart[] {
  return toolParts(messages).filter(
    (part): part is CompletedToolPart =>
      part.tool === name && part.state.status === "completed"
  )
}

function completedToolWithCommand(
  messages: Array<{ info: MessageInfo; parts: Part[] }>,
  name: string,
  command: string
): CompletedToolPart {
  const part = completedToolParts(messages, name).find(
    (candidate) => candidate.state.input.command === command
  )
  if (!part) throw new Error(`Expected completed ${name} command ${JSON.stringify(command)}`)
  return part
}

function childKind(request: ScriptedProviderRequest): ChildKind {
  if (
    providerHistoryContains(request, CUSTOM_CHILD_MARKER) ||
    providerHistoryContains(request, CUSTOM_AGENT_PROMPT)
  ) {
    return "custom"
  }
  if (providerHistoryContains(request, EXPLORE_CHILD_MARKER)) return "explore"
  throw new Error(`Could not identify child provider request ${request.sequence}`)
}

function assertChildRequestContext(
  request: ScriptedProviderRequest,
  parentID: string
): void {
  expect(request.headers.authorization).toBe("Bearer fixture-api-key")
  expect(request.headers["x-parent-session-id"]).toBe(parentID)
  expect(request.headers["x-session-id"]).toEqual(expect.any(String))
  expect(request.headers["x-session-affinity"]).toBe(
    request.headers["x-session-id"]
  )
  expect(systemPrompt(request)).toContain("Rules for Working Through OpenCode SSH")
  expect(systemPrompt(request)).toContain("OpenCode SSH remote project context:")
  expect(systemPrompt(request)).toContain(`SSH alias: ${TASK_FIXTURE_ALIAS}`)
  expect(systemPrompt(request)).toContain(`Remote workspace: ${TASK_FIXTURE_WORKDIR}`)
  expect(systemPrompt(request)).not.toContain(REMOTE_AGENTS_MARKER)
}

async function finishTaskFixture(
  fixture: InstalledOpenCodeTaskFixture,
  scenarioError: unknown,
  scenarioName: string
): Promise<void> {
  let failure = scenarioError
  let cleanup: Awaited<ReturnType<InstalledOpenCodeTaskFixture["close"]>> | undefined
  try {
    cleanup = await fixture.close()
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError(
          [failure, cleanupError],
          `${scenarioName} and cleanup failed`
        )
      : cleanupError
  } finally {
    activeFixtures.delete(fixture)
  }

  if (cleanup) {
    try {
      fixture.provider.assertComplete()
    } catch (providerError) {
      failure = failure
        ? new AggregateError(
            [failure, providerError],
            `${scenarioName} and provider script both failed`
          )
        : providerError
    }
    try {
      expect(cleanup).toMatchObject({
        readyRemoved: true,
        socketRemoved: true,
        mirrorRemoved: true,
        masterStateRemoved: true,
        rootRemoved: true,
      })
      expect(cleanup.launcherResult.timedOut).toBe(false)
      expect(Buffer.byteLength(cleanup.launcherResult.stdout)).toBeLessThanOrEqual(
        64 * 1024
      )
      expect(Buffer.byteLength(cleanup.launcherResult.stderr)).toBeLessThanOrEqual(
        64 * 1024
      )
    } catch (assertionError) {
      failure = failure
        ? new AggregateError(
            [failure, assertionError],
            `${scenarioName} and cleanup assertions failed`
          )
        : assertionError
    }
  }
  if (failure) throw failure
}

function boundedPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for fake SSH PID ${pid} to exit`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

function hasParentHeader(request: ScriptedProviderRequest): boolean {
  return request.headers["x-parent-session-id"] !== undefined
}

function requestBodyContains(
  request: ScriptedProviderRequest,
  value: string
): boolean {
  return providerHistoryContains(request, value)
}

function providerMessageContains(
  request: ScriptedProviderRequest,
  role: ScriptedProviderMessageRole,
  value: string
): boolean {
  return providerMessageTexts(request, role).some((text) => text.includes(value))
}

function providerTools(
  request: ScriptedProviderRequest
): Map<string, { description?: string }> {
  const tools = request.body.tools
  if (!Array.isArray(tools)) return new Map()
  return new Map(
    tools.flatMap((tool) => {
      if (
        tool === null ||
        typeof tool !== "object" ||
        !("function" in tool) ||
        tool.function === null ||
        typeof tool.function !== "object" ||
        !("name" in tool.function) ||
        typeof tool.function.name !== "string"
      ) {
        return []
      }
      const description =
        "description" in tool.function &&
        typeof tool.function.description === "string"
          ? tool.function.description
          : undefined
      return [[tool.function.name, { description }] as const]
    })
  )
}

function systemPrompt(request: ScriptedProviderRequest): string {
  return providerMessageTexts(request, "system").join("\n")
}

function assertResumeGuidance(
  request: ScriptedProviderRequest,
  taskResumeEnabled: boolean
): void {
  const system = systemPrompt(request)
  if (taskResumeEnabled) {
    expect(system).toContain(
      "Task resume is limited to the exact task_id of a successfully completed foreground direct child"
    )
    expect(system).toContain(
      "A resumed child must repeat the one-step package remote_status preflight"
    )
    expect(system).not.toContain(
      "Task resume is unavailable because launcher capability was not established"
    )
    return
  }
  expect(system).toContain(
    "Task resume is unavailable because launcher capability was not established"
  )
  expect(system).not.toContain(
    "Task resume is limited to the exact task_id of a successfully completed foreground direct child"
  )
}

type MessageInfo = {
  role: "user" | "assistant"
  providerID?: string
  modelID?: string
  agent?: string
}

type CompletedToolPart = ToolPart & {
  state: Extract<ToolPart["state"], { status: "completed" }>
}

function completedTool(
  messages: Array<{ info: MessageInfo; parts: Part[] }>,
  name: string
): CompletedToolPart {
  const part = messages
    .flatMap((message) => message.parts)
    .find(
      (candidate): candidate is ToolPart =>
        candidate.type === "tool" && candidate.tool === name
    )
  if (!part || part.state.status !== "completed") {
    throw new Error(`Expected completed ${name} tool part`)
  }
  return part as CompletedToolPart
}

function textParts(parts: Part[]): string[] {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
}

function requireData<T>(
  result: { data?: unknown; error?: unknown },
  operation: string
): T {
  if (result.data !== undefined) return result.data as T
  throw new Error(
    `${operation} failed: ${bounded(JSON.stringify(result.error ?? "missing response data"))}`
  )
}

function bounded(value: string): string {
  return value.length <= 2_048 ? value : `${value.slice(0, 2_048)}...[truncated]`
}
