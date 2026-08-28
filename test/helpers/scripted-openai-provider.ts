import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_DIAGNOSTIC_CHARACTERS = 2_048

export interface ScriptedProviderRequest {
  readonly sequence: number
  readonly method: string
  readonly pathname: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
  matchedStep?: string
}

export type ScriptedProviderMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"

export type ScriptedProviderResponse =
  | { type: "text"; text: string }
  | ({ type: "tool-call" } & ScriptedToolCall)
  | { type: "tool-calls"; calls: ScriptedToolCall[] }

export interface ScriptedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ScriptedProviderStep {
  readonly name: string
  readonly match: (request: ScriptedProviderRequest) => boolean
  readonly response:
    | ScriptedProviderResponse
    | ((
        request: ScriptedProviderRequest
      ) => ScriptedProviderResponse | Promise<ScriptedProviderResponse>)
}

export function providerMessageTexts(
  request: ScriptedProviderRequest,
  role?: ScriptedProviderMessageRole
): string[] {
  return providerMessages(request).flatMap((message) => {
    if (role !== undefined && message.role !== role) return []
    const content = normalizeTextContent(message.content)
    return content === undefined ? [] : [content]
  })
}

export function providerHistoryContains(
  request: ScriptedProviderRequest,
  value: string
): boolean {
  return providerMessages(request).some((message) => {
    if (normalizeTextContent(message.content)?.includes(value)) return true
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      return false
    }
    return message.tool_calls.some((call) => {
      if (!isRecord(call)) return false
      if (call.id === value) return true
      if (!isRecord(call.function)) return false
      return (
        typeof call.function.arguments === "string" &&
        call.function.arguments.includes(value)
      )
    })
  })
}

export function providerHasToolCall(
  request: ScriptedProviderRequest,
  callID: string
): boolean {
  return providerMessages(request).some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some(
        (call) => isRecord(call) && call.id === callID
      )
  )
}

export function providerToolResultText(
  request: ScriptedProviderRequest,
  callID: string
): string | undefined {
  const results = providerMessages(request).filter(
    (message) => message.role === "tool" && message.tool_call_id === callID
  )
  if (results.length === 0) return undefined
  const content =
    results.length === 1 ? normalizeTextContent(results[0].content) : undefined
  if (content === undefined) {
    throw new Error(
      `Provider request contained an invalid tool result for ${JSON.stringify(callID)}`
    )
  }
  return content
}

export interface ScriptedOpenAIProvider {
  readonly hostname: "127.0.0.1"
  readonly baseURL: string
  readonly requests: ScriptedProviderRequest[]
  configure(steps: readonly ScriptedProviderStep[]): void
  assertComplete(): void
  close(): Promise<void>
}

export async function startScriptedOpenAIProvider(
  steps?: readonly ScriptedProviderStep[]
): Promise<ScriptedOpenAIProvider> {
  const pending = steps === undefined ? [] : validateSteps(steps)
  const requests: ScriptedProviderRequest[] = []
  const failures: string[] = []
  const activeHandlers = new Set<Promise<void>>()
  let configured = steps !== undefined
  let closePromise: Promise<void> | undefined

  const server = createServer((request, response) => {
    const handler = handleRequest(request, response)
      .catch((error: unknown) => {
        const message = boundedDiagnostic(errorMessage(error))
        failures.push(`provider handler failed: ${message}`)
        if (!response.headersSent) {
          writeError(response, 500, `Scripted provider handler failed: ${message}`)
        } else if (!response.writableEnded) {
          response.end()
        }
      })
      .finally(() => activeHandlers.delete(handler))
    activeHandlers.add(handler)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true })
  })

  const address = server.address()
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error("Scripted provider did not bind to IPv4 loopback")
  }

  const baseURL = `http://127.0.0.1:${(address as AddressInfo).port}/v1`

  return {
    hostname: "127.0.0.1",
    baseURL,
    requests,
    configure(nextSteps) {
      if (configured) {
        throw new Error("Scripted provider is already configured")
      }
      if (requests.length > 0) {
        throw new Error("Scripted provider received a request before configuration")
      }
      pending.push(...validateSteps(nextSteps))
      configured = true
    },
    assertComplete() {
      if (configured && pending.length === 0 && failures.length === 0) return
      const pendingNames = pending.map((step) => step.name).join(", ") || "none"
      const failureSummary = failures.join("; ") || "none"
      throw new Error(
        `Scripted provider incomplete: configured=${configured}; pending=[${pendingNames}]; failures=[${failureSummary}]`
      )
    },
    close() {
      closePromise ??= (async () => {
        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
        await serverClosed
        while (activeHandlers.size > 0) {
          await Promise.all([...activeHandlers])
        }
      })()
      return closePromise
    },
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const remoteAddress = request.socket.remoteAddress
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") {
      failures.push("rejected a non-loopback provider request")
      writeError(response, 403, "Scripted provider accepts loopback requests only")
      return
    }

    const method = request.method ?? ""
    const requestURL = new URL(request.url ?? "/", baseURL)
    let body: Record<string, unknown>
    try {
      body = parseRequestBody(await readBody(request))
    } catch (error) {
      const message = boundedDiagnostic(errorMessage(error))
      failures.push(`invalid request body: ${message}`)
      writeError(response, 400, message)
      return
    }

    const captured: ScriptedProviderRequest = {
      sequence: requests.length + 1,
      method,
      pathname: requestURL.pathname,
      headers: normalizeHeaders(request.headers),
      body,
    }
    requests.push(captured)

    if (!configured) {
      const message = "provider request arrived before script configuration"
      failures.push(message)
      writeError(response, 503, message)
      return
    }

    if (method !== "POST" || requestURL.pathname !== "/v1/chat/completions") {
      const message = `unmatched request ${method} ${requestURL.pathname}`
      failures.push(message)
      writeError(response, 400, message)
      return
    }

    let matchedIndex = -1
    for (const [index, step] of pending.entries()) {
      try {
        if (step.match(captured)) {
          matchedIndex = index
          break
        }
      } catch (error) {
        const message = `matcher ${JSON.stringify(step.name)} failed: ${boundedDiagnostic(
          errorMessage(error)
        )}`
        failures.push(message)
        writeError(response, 400, message)
        return
      }
    }

    if (matchedIndex === -1) {
      const message = `unmatched request ${method} ${requestURL.pathname} session=${boundedDiagnostic(
        JSON.stringify({
          sessionID: captured.headers["x-session-id"],
          parentSessionID: captured.headers["x-parent-session-id"],
        })
      )} body=${boundedDiagnostic(requestDiagnostic(body))}`
      failures.push(message)
      writeError(response, 400, message)
      return
    }

    const [step] = pending.splice(matchedIndex, 1)
    captured.matchedStep = step.name
    const scripted =
      typeof step.response === "function"
        ? await step.response(captured)
        : step.response
    streamCompletion(response, captured.sequence, body, scripted)
  }
}

function validateSteps(
  steps: readonly ScriptedProviderStep[]
): ScriptedProviderStep[] {
  const validated = [...steps]
  for (const [index, step] of validated.entries()) {
    if (!step.name.trim() || typeof step.match !== "function") {
      throw new TypeError(`Scripted provider step ${index} is invalid`)
    }
  }
  return validated
}

function providerMessages(
  request: ScriptedProviderRequest
): Record<string, unknown>[] {
  return Array.isArray(request.body.messages)
    ? request.body.messages.filter(isRecord)
    : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizeTextContent(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (
    !Array.isArray(value) ||
    !value.every(
      (part) => isRecord(part) && part.type === "text" && typeof part.text === "string"
    )
  ) {
    return undefined
  }
  return value.map((part) => part.text).join("")
}

function streamCompletion(
  response: ServerResponse,
  sequence: number,
  requestBody: Record<string, unknown>,
  scripted: ScriptedProviderResponse
): void {
  const id = `chatcmpl-fixture-${sequence}`
  const model = typeof requestBody.model === "string" ? requestBody.model : "fixture-model"
  const base = {
    id,
    object: "chat.completion.chunk",
    created: 1,
    model,
  }
  const writeEvent = (value: unknown) => {
    response.write(`data: ${JSON.stringify(value)}\n\n`)
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "text/event-stream; charset=utf-8",
    "x-request-id": id,
  })
  writeEvent({
    ...base,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })

  if (scripted.type === "text") {
    writeEvent({
      ...base,
      choices: [{ index: 0, delta: { content: scripted.text }, finish_reason: null }],
    })
    writeEvent({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })
  } else {
    const calls = scripted.type === "tool-call" ? [scripted] : scripted.calls
    if (calls.length === 0) {
      throw new Error("Scripted tool-call response must contain at least one call")
    }
    writeEvent({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: "" },
            })),
          },
          finish_reason: null,
        },
      ],
    })
    writeEvent({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              function: { arguments: JSON.stringify(call.arguments) },
            })),
          },
          finish_reason: null,
        },
      ],
    })
    writeEvent({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })
  }

  writeEvent({
    ...base,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  })
  response.end("data: [DONE]\n\n")
}

async function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8")
  let body = ""
  let bytes = 0
  for await (const chunk of request) {
    const text = String(chunk)
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error(`Provider request exceeded ${MAX_REQUEST_BYTES} bytes`)
    }
    body += text
  }
  return body
}

function parseRequestBody(body: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new Error("Provider request body is not valid JSON")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Provider request body must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function requestDiagnostic(body: Record<string, unknown>): string {
  return JSON.stringify({
    ...body,
    ...(Array.isArray(body.messages)
      ? { messages: [...body.messages].reverse() }
      : {}),
  })
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined) return []
      return [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]]
    })
  )
}

function writeError(response: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({
    error: {
      message: boundedDiagnostic(message),
      type: "invalid_request_error",
    },
  })
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  })
  response.end(body)
}

function boundedDiagnostic(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_CHARACTERS) return value
  return `${value.slice(0, MAX_DIAGNOSTIC_CHARACTERS)}...[truncated]`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
