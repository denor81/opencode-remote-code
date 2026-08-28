import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PROBE_ENV,
  PROBE_PROTOCOL,
  activateCompatibilityProbe,
  parseProbeMarker,
} from "../../src/opencode-probe.js"
import {
  OPEN_CODE_RUNTIME_OBSERVATION_FAILURE_CODES,
  OpenCodeRuntimeObservationError,
  classifyOpenCodeRuntimeObservationFailure,
  observeOpenCodeRuntimeVersion,
  parseRuntimeExecutableVersionResult,
  type RuntimeExecutableVersionResult,
} from "../../src/opencode-runtime-version.js"

const temporaryRoots: string[] = []
const successfulRuntimeVersionResult: RuntimeExecutableVersionResult = {
  stdout: "1.18.18\n",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  exitCode: 0,
  signal: null,
  termination: null,
  timedOut: false,
  aborted: false,
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("OpenCode loader probe", () => {
  it("activates only for the matching private tuple and writes a private marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const token = "a".repeat(64)
    const resultPath = path.join(root, "result.json")
    const env = {
      [PROBE_ENV.token]: token,
      [PROBE_ENV.resultPath]: resultPath,
    }

    const globalFetch = stubFailingGlobalFetch()
    const clientFetch = vi.fn(async (_request: Request) =>
      healthResponse("1.18.18")
    )
    const input = pluginInput(createLegacyClient(clientFetch))
    expect(activateCompatibilityProbe(input, {}, env)).toBeNull()
    const hooks = activateCompatibilityProbe(
      input,
      { compatibilityProbe: token },
      env
    )

    expect(hooks?.config).toEqual(expect.any(Function))
    await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" })
    await hooks?.config?.({} as never)
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
      protocol: PROBE_PROTOCOL,
      token,
      loaderRuntimeVersion: "1.18.18",
      loaderRuntimeVersionSource: "client._client.get",
      callableSessionLookupObservedInLoaderProcess: true,
    })
    expect(clientFetch).toHaveBeenCalledOnce()
    expect(new URL(clientFetch.mock.calls[0]![0].url).pathname).toBe(
      "/global/health"
    )
    expect(globalFetch).not.toHaveBeenCalled()
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600)
  })

  it("does not activate with a mismatched tuple token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    const resultPath = path.join(root, "result.json")

    expect(
      activateCompatibilityProbe(
        {} as never,
        { compatibilityProbe: "b".repeat(64) },
        {
          [PROBE_ENV.token]: "a".repeat(64),
          [PROBE_ENV.resultPath]: resultPath,
        }
      )
    ).toBeNull()
    await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("records an unavailable loader observation when session.get is not callable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    const token = "c".repeat(64)
    const resultPath = path.join(root, "result.json")
    const hooks = activateCompatibilityProbe(
      {
        client: {
          global: {
            health: async () => ({
              data: { healthy: true, version: "1.18.18" },
            }),
          },
          session: {},
        },
        serverUrl: new URL("http://127.0.0.1:4096"),
      } as never,
      { compatibilityProbe: token },
      {
        [PROBE_ENV.token]: token,
        [PROBE_ENV.resultPath]: resultPath,
      }
    )

    await hooks?.config?.({} as never)
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
      protocol: PROBE_PROTOCOL,
      token,
      loaderRuntimeVersion: "1.18.18",
      loaderRuntimeVersionSource: "client.global.health",
      callableSessionLookupObservedInLoaderProcess: false,
    })
  })

  it("gives public client health precedence over the legacy transport", async () => {
    const globalFetch = stubFailingGlobalFetch()
    const clientFetch = vi.fn(async (_request: Request) => {
      throw new Error("legacy transport must not be called")
    })
    const client = createLegacyClient(clientFetch)
    const health = vi.fn(async () => ({
      data: { healthy: true, version: "1.18.19" },
      request: new Request("http://localhost:4096/global/health"),
      response: healthResponse("1.18.19"),
    }))
    Object.assign(client.global, { health })

    await expect(
      observeOpenCodeRuntimeVersion(pluginInput(client))
    ).resolves.toEqual({
      version: "1.18.19",
      source: "client.global.health",
    })
    expect(health).toHaveBeenCalledOnce()
    expect(clientFetch).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("uses the legacy SDK in-process transport without global fetch", async () => {
    const globalFetch = stubFailingGlobalFetch()
    const clientFetch = vi.fn(async (_request: Request) =>
      healthResponse("1.18.20")
    )

    await expect(
      observeOpenCodeRuntimeVersion(
        pluginInput(createLegacyClient(clientFetch))
      )
    ).resolves.toEqual({
      version: "1.18.20",
      source: "client._client.get",
    })
    expect(clientFetch).toHaveBeenCalledOnce()
    const request = clientFetch.mock.calls[0]![0]
    expect(request.method).toBe("GET")
    expect(new URL(request.url).pathname).toBe("/global/health")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("does not fall back after a malformed legacy health payload", async () => {
    const globalFetch = stubFailingGlobalFetch()
    const clientFetch = vi.fn(async (_request: Request) =>
      new Response(JSON.stringify({ healthy: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )

    const error = await rejected(
      observeOpenCodeRuntimeVersion(
        pluginInput(createLegacyClient(clientFetch)),
        { allowRuntimeExecutableFallback: true }
      )
    )
    expect(error).toBeInstanceOf(OpenCodeRuntimeObservationError)
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "health-response-invalid"
    )
    expect(error).toHaveProperty(
      "message",
      "OpenCode global health returned an invalid payload"
    )
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "missing own SDK fields",
      result: () => ({
        data: { healthy: true, version: "1.18.20" },
        response: { status: 200, ok: "true" },
      }),
    },
    {
      name: "inherited SDK fields",
      result: () =>
        Object.create(
          sdkHealthEnvelope({ healthy: true, version: "1.18.20" })
        ) as unknown,
    },
    {
      name: "a non-Request request",
      result: () => ({
        data: { healthy: true, version: "1.18.20" },
        request: { method: "GET", url: "http://localhost/global/health" },
        response: healthResponse("1.18.20"),
      }),
    },
    {
      name: "a non-Response response",
      result: () => ({
        data: { healthy: true, version: "1.18.20" },
        request: healthRequest(),
        response: { status: 200, ok: true },
      }),
    },
    {
      name: "a non-GET request",
      result: () =>
        sdkHealthEnvelope(
          { healthy: true, version: "1.18.20" },
          { request: healthRequest("/global/health", "POST") }
        ),
    },
    {
      name: "a request for another path",
      result: () =>
        sdkHealthEnvelope(
          { healthy: true, version: "1.18.20" },
          { request: healthRequest("/session") }
        ),
    },
    {
      name: "an SDK error response",
      result: () => ({
        error: { message: "unavailable" },
        request: healthRequest(),
        response: healthResponse("1.18.20", 503),
      }),
    },
    {
      name: "a non-200 response",
      result: () => ({
        data: { healthy: true, version: "1.18.20" },
        request: healthRequest(),
        response: healthResponse("1.18.20", 503),
      }),
    },
    {
      name: "an additional SDK envelope field",
      result: () => ({
        ...sdkHealthEnvelope({ healthy: true, version: "1.18.20" }),
        extra: true,
      }),
    },
    {
      name: "an additional non-enumerable payload key",
      result: () => {
        const data = { healthy: true, version: "1.18.20" }
        Object.defineProperty(data, "extra", { value: true })
        return sdkHealthEnvelope(data)
      },
    },
  ])("does not fall back after $name", async ({ result }) => {
    const globalFetch = stubFailingGlobalFetch()
    const get = vi.fn(async () => result())

    const error = await rejected(
      observeOpenCodeRuntimeVersion(legacyTransportInput(get), {
        allowRuntimeExecutableFallback: true,
      })
    )
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "health-response-invalid"
    )
    expect(error).toHaveProperty(
      "message",
      expect.stringMatching(/returned an invalid (?:result|payload)/u)
    )
    expect(get).toHaveBeenCalledOnce()
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("sanitizes public health request failures without falling back", async () => {
    const globalFetch = stubFailingGlobalFetch()
    const health = vi.fn(async () => {
      throw new Error("secret public transport detail")
    })

    const error = await rejected(
      observeOpenCodeRuntimeVersion(
        pluginInput({
          global: { health },
          session: { get: () => undefined },
        }),
        { allowRuntimeExecutableFallback: true }
      )
    )
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "health-request-failed"
    )
    expect(error).toHaveProperty("message", "OpenCode runtime health request failed")
    expect((error as Error).message).not.toContain("secret public transport detail")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("does not fall back after the legacy transport rejects", async () => {
    const globalFetch = stubFailingGlobalFetch()
    const transportError = new Error("in-process transport failed")
    const clientFetch = vi.fn(async (_request: Request): Promise<Response> => {
      throw transportError
    })

    const error = await rejected(
      observeOpenCodeRuntimeVersion(
        pluginInput(createLegacyClient(clientFetch)),
        { allowRuntimeExecutableFallback: true }
      )
    )
    expect(error).not.toBe(transportError)
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "health-request-failed"
    )
    expect(error).toHaveProperty("message", "OpenCode runtime health request failed")
    expect((error as Error).message).not.toContain(transportError.message)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("preserves and classifies a public health caller abort", async () => {
    const controller = new AbortController()
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    const health = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          requestStarted()
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        })
    )
    const observation = observeOpenCodeRuntimeVersion(
      pluginInput({ global: { health }, session: { get: () => undefined } }),
      { signal: controller.signal }
    )

    await started
    const abortReason = new Error("stop public runtime observation")
    controller.abort(abortReason)
    const error = await rejected(observation)
    expect(error).toBe(abortReason)
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "health-aborted"
    )
  })

  it("aborts the legacy transport without falling back", async () => {
    const globalFetch = stubFailingGlobalFetch()
    const controller = new AbortController()
    let requestObserved!: (request: Request) => void
    const observedRequest = new Promise<Request>((resolve) => {
      requestObserved = resolve
    })
    const clientFetch = vi.fn(
      (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          requestObserved(request)
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true }
          )
        })
    )
    const observation = observeOpenCodeRuntimeVersion(
      pluginInput(createLegacyClient(clientFetch)),
      {
        signal: controller.signal,
        allowRuntimeExecutableFallback: true,
      }
    )

    const request = await observedRequest
    const abortReason = new Error("stop runtime observation")
    controller.abort(abortReason)
    const error = await rejected(observation)
    expect(error).toBe(abortReason)
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "health-aborted"
    )
    expect(request.signal.aborted).toBe(true)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("classifies a bounded health timeout without waiting five seconds", async () => {
    const health = vi.fn(() => new Promise<never>(() => undefined))

    const error = await rejected(
      observeOpenCodeRuntimeVersion(
        pluginInput({ global: { health }, session: { get: () => undefined } }),
        { healthTimeoutMs: 5 }
      )
    )
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "health-timeout"
    )
    expect(error).toHaveProperty("message", "OpenCode runtime health request timed out")
  })

  it("fails closed on a malformed private transport shape", async () => {
    const globalFetch = stubFailingGlobalFetch()

    const error = await rejected(
      observeOpenCodeRuntimeVersion(
        pluginInput({ global: {}, _client: { get: "not callable" } }),
        { allowRuntimeExecutableFallback: true }
      )
    )
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "legacy-transport-invalid"
    )
    expect(error).toHaveProperty(
      "message",
      "OpenCode legacy client transport has an invalid shape"
    )
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it.each<{
    name: string
    mutate: (client: LegacyClientShape) => void
  }>([
    {
      name: "the global subclient lacks its own transport",
      mutate: (client) => {
        delete client.global._client
      },
    },
    {
      name: "the session subclient inherits its transport",
      mutate: (client) => {
        const transport = client.session._client
        delete client.session._client
        Object.setPrototypeOf(client.session, { _client: transport })
      },
    },
    {
      name: "the global subclient has a different transport",
      mutate: (client) => {
        client.global._client = { get: client._client.get }
      },
    },
    {
      name: "the session subclient has a different transport",
      mutate: (client) => {
        client.session._client = { get: client._client.get }
      },
    },
  ])("rejects legacy transport drift when $name", async ({ mutate }) => {
    const get = vi.fn(async () =>
      sdkHealthEnvelope({ healthy: true, version: "1.18.20" })
    )
    const client = legacyClientShape(get)
    mutate(client)

    const error = await rejected(
      observeOpenCodeRuntimeVersion(pluginInput(client), {
        allowRuntimeExecutableFallback: true,
      })
    )
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "legacy-transport-invalid"
    )
    expect(get).not.toHaveBeenCalled()
  })

  it("uses the runtime executable only when fallback is explicitly enabled", async () => {
    const globalFetch = stubFailingGlobalFetch()
    const input = pluginInput({ global: {}, session: { get: () => undefined } })

    const unavailable = await rejected(observeOpenCodeRuntimeVersion(input))
    expect(classifyOpenCodeRuntimeObservationFailure(unavailable)).toBe(
      "health-unavailable"
    )
    expect(unavailable).toHaveProperty(
      "message",
      "OpenCode runtime health is unavailable in this loader process"
    )

    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    const executable = path.join(root, "opencode")
    await writeFile(executable, "#!/bin/sh\nprintf '1.18.20\\n'\n", {
      mode: 0o700,
    })
    await withProcessExecPath(executable, async () => {
      await expect(
        observeOpenCodeRuntimeVersion(input, {
          allowRuntimeExecutableFallback: true,
        })
      ).resolves.toEqual({
        version: "1.18.20",
        source: "runtime-executable",
      })
    })
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("classifies an invalid executable fallback without an aggregate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    const executable = path.join(root, "opencode")
    await writeFile(executable, "#!/bin/sh\nprintf 'v1.18.20\\n'\n", {
      mode: 0o700,
    })

    await withProcessExecPath(executable, async () => {
      const error = await rejected(
        observeOpenCodeRuntimeVersion(pluginInput({ global: {} }), {
          allowRuntimeExecutableFallback: true,
        })
      )
      expect(error).toBeInstanceOf(OpenCodeRuntimeObservationError)
      expect(error).not.toBeInstanceOf(AggregateError)
      expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
        "executable-version-invalid"
      )
    })
  })

  it("preserves a caller abort while terminating executable fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    const executable = path.join(root, "opencode")
    const startedPath = path.join(root, "started")
    await writeFile(
      executable,
      `#!/bin/sh\n: > "${startedPath}"\nsleep 30\n`,
      { mode: 0o700 }
    )
    const controller = new AbortController()
    const abortReason = new Error("stop executable fallback")

    await withProcessExecPath(executable, async () => {
      const observation = observeOpenCodeRuntimeVersion(
        pluginInput({ global: {} }),
        {
          signal: controller.signal,
          allowRuntimeExecutableFallback: true,
        }
      )
      await vi.waitFor(async () => {
        expect((await stat(startedPath)).isFile()).toBe(true)
      })
      controller.abort(abortReason)

      const error = await rejected(observation)
      expect(error).toBe(abortReason)
      expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
        "health-aborted"
      )
    })
  })

  it("exports the stable runtime observation failure codes", () => {
    expect(OPEN_CODE_RUNTIME_OBSERVATION_FAILURE_CODES).toEqual([
      "health-unavailable",
      "legacy-transport-invalid",
      "health-request-failed",
      "health-timeout",
      "health-aborted",
      "health-response-invalid",
      "executable-version-invalid",
    ])
    expect(classifyOpenCodeRuntimeObservationFailure(new Error("other"))).toBe(
      undefined
    )
  })

  it("accepts only an unambiguous runtime executable version result", () => {
    expect(
      parseRuntimeExecutableVersionResult(successfulRuntimeVersionResult)
    ).toBe("1.18.18")
  })

  it.each<{
    name: string
    override: Partial<RuntimeExecutableVersionResult>
  }>([
    { name: "truncated stdout", override: { stdoutTruncated: true } },
    { name: "truncated stderr", override: { stderrTruncated: true } },
    { name: "termination", override: { termination: "timeout" } },
    { name: "inconsistent timeout", override: { timedOut: true } },
    { name: "inconsistent abort", override: { aborted: true } },
    { name: "signal exit", override: { signal: "SIGTERM" } },
    { name: "non-zero exit", override: { exitCode: 1 } },
  ])("rejects runtime executable ambiguity from $name", ({ override }) => {
    const error = thrown(() =>
      parseRuntimeExecutableVersionResult({
        ...successfulRuntimeVersionResult,
        ...override,
      })
    )
    expect(error).toHaveProperty(
      "message",
      "OpenCode runtime executable returned an ambiguous version result"
    )
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "executable-version-invalid"
    )
  })

  it.each([
    { name: "a missing version", payload: { healthy: true } },
    {
      name: "a malformed version",
      payload: { healthy: true, version: "v1.18.18" },
    },
    {
      name: "an additional field",
      payload: { healthy: true, version: "1.18.18", extra: true },
    },
  ])("rejects callable client health with $name", async ({ payload }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    const token = "e".repeat(64)
    const resultPath = path.join(root, "result.json")
    const hooks = activateCompatibilityProbe(
      {
        client: {
          global: { health: async () => ({ data: payload }) },
          session: { get: () => undefined },
        },
        serverUrl: new URL("http://127.0.0.1:4096"),
      } as never,
      { compatibilityProbe: token },
      {
        [PROBE_ENV.token]: token,
        [PROBE_ENV.resultPath]: resultPath,
      }
    )

    const error = await rejected(hooks!.config!({} as never))
    expect(error).toHaveProperty(
      "message",
      expect.stringMatching(/global health returned an invalid payload/u)
    )
    expect(classifyOpenCodeRuntimeObservationFailure(error)).toBe(
      "health-response-invalid"
    )
    await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("parses only the exact nonce-bound v3 marker into a loader observation", () => {
    const token = "f".repeat(64)
    const record = {
      protocol: PROBE_PROTOCOL,
      token,
      loaderRuntimeVersion: "1.18.18",
      loaderRuntimeVersionSource: "client._client.get",
      callableSessionLookupObservedInLoaderProcess: true,
    }

    expect(parseProbeMarker(record, token)).toEqual({
      loaderRuntimeVersion: "1.18.18",
      loaderRuntimeVersionSource: "client._client.get",
      callableSessionLookupObservedInLoaderProcess: true,
    })
    expect(parseProbeMarker({ ...record, extra: true }, token)).toBeNull()
    expect(parseProbeMarker({ protocol: PROBE_PROTOCOL, token }, token)).toBeNull()
    expect(
      parseProbeMarker({ ...record, token: "0".repeat(64) }, token)
    ).toBeNull()
    expect(parseProbeMarker({ ...record, loaderRuntimeVersion: "v1.18.18" }, token)).toBeNull()
    expect(parseProbeMarker({ ...record, loaderRuntimeVersion: undefined }, token)).toBeNull()
    expect(
      parseProbeMarker({ ...record, loaderRuntimeVersionSource: "unknown" }, token)
    ).toBeNull()
    expect(
      parseProbeMarker(
        { ...record, callableSessionLookupObservedInLoaderProcess: false },
        token
      )
    ).toEqual({
      loaderRuntimeVersion: "1.18.18",
      loaderRuntimeVersionSource: "client._client.get",
      callableSessionLookupObservedInLoaderProcess: false,
    })
  })
})

function createLegacyClient(
  fetch: (request: Request) => Promise<Response>
): ReturnType<typeof createOpencodeClient> {
  return createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch,
  })
}

function pluginInput(client: unknown): never {
  return {
    client,
    serverUrl: new URL("http://localhost:4096"),
  } as never
}

interface LegacyHealthRequest {
  url: "/global/health"
  signal: AbortSignal
}

type LegacyGet = (request: LegacyHealthRequest) => Promise<unknown>

interface LegacyTransport {
  get: LegacyGet
}

interface LegacyClientShape {
  global: { _client?: LegacyTransport }
  session: { get: () => undefined; _client?: LegacyTransport }
  _client: LegacyTransport
}

function legacyClientShape(get: LegacyGet): LegacyClientShape {
  const transport = { get }
  return {
    global: { _client: transport },
    session: { get: () => undefined, _client: transport },
    _client: transport,
  }
}

function legacyTransportInput(get: LegacyGet): never {
  return pluginInput(legacyClientShape(get))
}

function healthResponse(version: string, status = 200): Response {
  return new Response(JSON.stringify({ healthy: true, version }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function healthRequest(
  pathname = "/global/health",
  method = "GET"
): Request {
  return new Request(new URL(pathname, "http://localhost:4096"), { method })
}

function sdkHealthEnvelope(
  data: unknown,
  overrides: { request?: Request; response?: Response } = {}
) {
  return {
    data,
    request: overrides.request ?? healthRequest(),
    response: overrides.response ?? healthResponse("1.18.20"),
  }
}

function stubFailingGlobalFetch() {
  const fetch = vi.fn(async () => {
    throw new Error("global fetch must not be called")
  })
  vi.stubGlobal("fetch", fetch)
  return fetch
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject")
}

function thrown(operation: () => unknown): unknown {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("Expected operation to throw")
}

async function withProcessExecPath<T>(
  executable: string,
  operation: () => Promise<T>
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "execPath")!
  Object.defineProperty(process, "execPath", {
    ...descriptor,
    value: executable,
  })
  try {
    return await operation()
  } finally {
    Object.defineProperty(process, "execPath", descriptor)
  }
}
