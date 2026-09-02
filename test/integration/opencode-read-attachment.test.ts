import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Part, Session, ToolPart } from "@opencode-ai/sdk/v2"
import { afterEach, describe, expect, it } from "vitest"
import {
  TASK_FIXTURE_MODEL_ID,
  TASK_FIXTURE_PROVIDER_ID,
  TASK_FIXTURE_WORKDIR,
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
const ROOT_PROMPT = "Read the hermetic remote PNG and inspect it."
const ROOT_COMPLETE = "Remote image attachment received."
const STATUS_CALL_ID = "call_image_root_status"
const READ_CALL_ID = "call_image_root_read"
const REMOTE_IMAGE_PATH = `${TASK_FIXTURE_WORKDIR}/pixel.png`
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`

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
    throw new AggregateError(failures, "OpenCode image fixture cleanup failed")
  }
})

describe("real installed OpenCode remote read attachments", () => {
  it.skipIf(skipReason !== undefined)(
    skipReason
      ? `requires an installed OpenCode (${skipReason})`
      : "delivers a remote PNG attachment to OpenCode and the model request",
    async () => {
      if (installedOpenCode.kind !== "available") {
        throw new Error("OpenCode availability guard did not skip the test")
      }

      const fixture = await startInstalledOpenCodeTaskFixture({
        openCode: installedOpenCode,
        steps: providerSteps(),
        configOverride: {
          permission: { read: "allow" },
          modelCapabilities: {
            attachment: true,
            inputModalities: ["text", "image"],
          },
        },
        enableFakeRemoteFilesystem: true,
        extraSshResponses: imageSshResponses(),
      })
      activeFixtures.add(fixture)

      const localRemoteImage = path.join(
        fixture.root,
        "fake-remote",
        ...REMOTE_IMAGE_PATH.split("/").filter(Boolean)
      )
      await mkdir(path.dirname(localRemoteImage), { recursive: true })
      await writeFile(localRemoteImage, PNG_BYTES)

      const root = requireData<Session>(
        await fixture.client.session.create(
          { title: "Hermetic remote image fixture", agent: "build" },
          { signal: AbortSignal.timeout(30_000) }
        ),
        "create image session"
      )
      await fixture.waitForReady()

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
        "prompt image session"
      )
      expect(
        promptResult.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      ).toContain(ROOT_COMPLETE)

      const messages = requireData<Array<{ info: unknown; parts: Part[] }>>(
        await fixture.client.session.messages(
          { sessionID: root.id },
          { signal: AbortSignal.timeout(10_000) }
        ),
        "read image session messages"
      )
      const readPart = completedTool(messages, "read")
      expect(readPart.state.attachments).toEqual([
        expect.objectContaining({
          type: "file",
          mime: "image/png",
          url: PNG_DATA_URL,
        }),
      ])
      expect(readPart.state.output).toBe("Image read successfully")

      const requestAfterRead = fixture.provider.requests.find((request) =>
        providerHasToolCall(request, READ_CALL_ID)
      )
      expect(requestAfterRead).toBeDefined()
      expect(providerImageUrls(requestAfterRead!)).toContain(PNG_DATA_URL)
      expect(await fixture.readSftpInputs()).toHaveLength(1)
    },
    180_000
  )
})

function providerSteps(): ScriptedProviderStep[] {
  return [
    {
      name: "root calls remote_status before image read",
      match: (request) =>
        providerHistoryContains(request, ROOT_PROMPT) &&
        !providerHasToolCall(request, STATUS_CALL_ID),
      response: {
        type: "tool-call",
        id: STATUS_CALL_ID,
        name: "remote_status",
        arguments: {},
      },
    },
    {
      name: "root reads remote image",
      match: (request) =>
        providerHasToolCall(request, STATUS_CALL_ID) &&
        !providerHasToolCall(request, READ_CALL_ID),
      response: {
        type: "tool-call",
        id: READ_CALL_ID,
        name: "read",
        arguments: { filePath: REMOTE_IMAGE_PATH },
      },
    },
    {
      name: "root completes after remote image",
      match: (request) => providerHasToolCall(request, READ_CALL_ID),
      response: { type: "text", text: ROOT_COMPLETE },
    },
  ]
}

function imageSshResponses(): TaskFixtureSshResponse[] {
  const octets = Array.from(PNG_BYTES.subarray(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  )
  return [
    {
      input: `if [ -d ${REMOTE_IMAGE_PATH} ]; then echo "DIR"; elif [ -f ${REMOTE_IMAGE_PATH} ]; then echo "FILE"; else echo "MISSING"; fi`,
      stdout: "FILE\n",
    },
    {
      input: `size=$(stat -c %s -- ${REMOTE_IMAGE_PATH}) || exit $?; printf '%s\\n' "$size"; dd bs=12 count=1 if=${REMOTE_IMAGE_PATH} 2>/dev/null | od -An -v -tx1 2>/dev/null || :`,
      stdout: `${PNG_BYTES.byteLength}\n${octets.join(" ")}\n`,
    },
    {
      input: `stat -c %a ${REMOTE_IMAGE_PATH} 2>/dev/null`,
      stdout: "600\n",
    },
  ]
}

function providerImageUrls(request: { body: Record<string, unknown> }): string[] {
  if (!Array.isArray(request.body.messages)) return []
  return request.body.messages.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return []
    return message.content.flatMap((part) => {
      if (!isRecord(part) || part.type !== "image_url" || !isRecord(part.image_url)) {
        return []
      }
      return typeof part.image_url.url === "string" ? [part.image_url.url] : []
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

type CompletedToolPart = ToolPart & {
  state: Extract<ToolPart["state"], { status: "completed" }>
}

function completedTool(
  messages: Array<{ info: unknown; parts: Part[] }>,
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

function requireData<T>(
  result: { data?: unknown; error?: unknown },
  operation: string
): T {
  if (result.data !== undefined) return result.data as T
  throw new Error(`${operation} failed: ${JSON.stringify(result.error ?? "missing data")}`)
}
