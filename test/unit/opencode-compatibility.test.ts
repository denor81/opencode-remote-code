import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { warnIfOpenCodeIsUntested } from "../../src/opencode-compatibility.js"
import { readPackageMetadata } from "../../src/package-metadata.js"

const fakeOpenCode = fileURLToPath(new URL("../fixtures/bin/opencode", import.meta.url))

describe("OpenCode compatibility warning", () => {
  it("continues immediately for the tested version", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const warnings: string[] = []
    const waits: number[] = []

    await warnIfOpenCodeIsUntested({
      binary: fakeOpenCode,
      env: { ...process.env },
      signal: new AbortController().signal,
      testedVersion: testedOpenCodeVersion,
      writeWarning: (message) => warnings.push(message),
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    expect(warnings).toEqual([])
    expect(waits).toEqual([])
  })

  it("accepts the tested stdout version despite a truncated stderr diagnostic", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const warnings: string[] = []
    const waits: number[] = []

    await warnIfOpenCodeIsUntested({
      binary: fakeOpenCode,
      env: {
        ...process.env,
        FAKE_OPENCODE_VERSION_STDERR: "x".repeat(5_000),
      },
      signal: new AbortController().signal,
      testedVersion: testedOpenCodeVersion,
      writeWarning: (message) => warnings.push(message),
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    expect(warnings).toEqual([])
    expect(waits).toEqual([])
  })

  it("warns, waits three seconds, and continues for another version", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const warnings: string[] = []
    const waits: number[] = []

    await warnIfOpenCodeIsUntested({
      binary: fakeOpenCode,
      env: { ...process.env, FAKE_OPENCODE_VERSION_STDOUT: "9.8.7\n" },
      signal: new AbortController().signal,
      testedVersion: testedOpenCodeVersion,
      writeWarning: (message) => warnings.push(message),
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`OpenCode 9.8.7 differs from the tested version ${testedOpenCodeVersion}`)
    expect(warnings[0]).toContain("manual TUI checks")
    expect(waits).toEqual([3_000])
  })

  it("does not reflect untrusted output when the version is unknown", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const warnings: string[] = []

    await warnIfOpenCodeIsUntested({
      binary: fakeOpenCode,
      env: {
        ...process.env,
        FAKE_OPENCODE_VERSION_STDOUT: "unexpected\nsecond line\n",
        FAKE_OPENCODE_VERSION_STDERR: "private diagnostic",
      },
      signal: new AbortController().signal,
      testedVersion: testedOpenCodeVersion,
      writeWarning: (message) => warnings.push(message),
      wait: async () => undefined,
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("could not be determined")
    expect(warnings[0]).not.toContain("unexpected")
    expect(warnings[0]).not.toContain("private diagnostic")
  })

  it("warns and continues when the version command exits non-zero", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const warnings: string[] = []
    const waits: number[] = []

    await warnIfOpenCodeIsUntested({
      binary: fakeOpenCode,
      env: {
        ...process.env,
        FAKE_OPENCODE_VERSION_STDERR: "version unavailable",
        FAKE_OPENCODE_VERSION_EXIT_CODE: "2",
      },
      signal: new AbortController().signal,
      testedVersion: testedOpenCodeVersion,
      writeWarning: (message) => warnings.push(message),
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("could not be determined")
    expect(warnings[0]).not.toContain("version unavailable")
    expect(waits).toEqual([3_000])
  })

  it("fails immediately when the OpenCode executable cannot be started", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const warnings: string[] = []
    const waits: number[] = []

    await expect(
      warnIfOpenCodeIsUntested({
        binary: "/definitely/missing/opencode",
        env: { ...process.env },
        signal: new AbortController().signal,
        testedVersion: testedOpenCodeVersion,
        writeWarning: (message) => warnings.push(message),
        wait: async (milliseconds) => {
          waits.push(milliseconds)
        },
      })
    ).rejects.toThrow(/Failed to spawn process/u)

    expect(warnings).toEqual([])
    expect(waits).toEqual([])
  })

  it("propagates cancellation during the warning delay", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const controller = new AbortController()
    const cancellation = new Error("cancel compatibility wait")

    await expect(
      warnIfOpenCodeIsUntested({
        binary: fakeOpenCode,
        env: { ...process.env, FAKE_OPENCODE_VERSION_STDOUT: "9.8.7\n" },
        signal: controller.signal,
        testedVersion: testedOpenCodeVersion,
        writeWarning: () => undefined,
        wait: async (_milliseconds, signal) => {
          controller.abort(cancellation)
          throw signal.reason
        },
      })
    ).rejects.toBe(cancellation)
  })

  it("derives the tested version from the exact plugin dependency", async () => {
    const metadata = await readPackageMetadata()
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(metadata.testedOpenCodeVersion).toMatch(/^\d+\.\d+\.\d+/u)
  })
})
