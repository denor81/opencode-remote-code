import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { runOpenCodeCompatibilityCheck } from "../../src/opencode-compatibility.js"
import { readPackageMetadata } from "../../src/package-metadata.js"

const fakeOpenCode = fileURLToPath(new URL("../fixtures/bin/opencode", import.meta.url))
const pluginURL = new URL("../../", import.meta.url)

describe("OpenCode compatibility preflight", () => {
  it("runs the loader probe and reports concise progress", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const progress: string[] = []

    await runOpenCodeCompatibilityCheck({
      binary: fakeOpenCode,
      env: { ...process.env },
      signal: new AbortController().signal,
      testedVersion: testedOpenCodeVersion,
      pluginURL,
      writeProgress: (message) => progress.push(message),
      writeWarning: () => undefined,
    })

    expect(progress).toHaveLength(3)
    expect(progress[0]).toBe("checking OpenCode compatibility...")
    expect(progress[1]).toBe(`testing OpenCode ${testedOpenCodeVersion} plugin loader...`)
    expect(progress[2]).toMatch(/^compatibility passed \([\d.]+s\)$/u)
  })

  it("allows a different identified version only after a successful probe", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const warnings: string[] = []

    await runOpenCodeCompatibilityCheck({
      binary: fakeOpenCode,
      env: { ...process.env, FAKE_OPENCODE_VERSION_STDOUT: "1.18.19\n" },
      signal: new AbortController().signal,
      testedVersion: testedOpenCodeVersion,
      pluginURL,
      writeProgress: () => undefined,
      writeWarning: (message) => warnings.push(message),
    })

    expect(warnings).toEqual([
      `OpenCode 1.18.19 passed the loader check but differs from the tested version ${testedOpenCodeVersion}; visual TUI checks remain required.`,
    ])
  })

  it("forwards lowercase proxy settings needed by the loader", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()
    const proxy = "http://proxy.example.invalid:8080"

    await expect(
      runOpenCodeCompatibilityCheck({
        binary: fakeOpenCode,
        env: {
          ...process.env,
          https_proxy: proxy,
          npm_config_opencode_ssh_expected_https_proxy: proxy,
        },
        signal: new AbortController().signal,
        testedVersion: testedOpenCodeVersion,
        pluginURL,
      })
    ).resolves.toBeUndefined()
  })

  it("fails when the OpenCode version cannot be identified", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()

    await expect(
      runOpenCodeCompatibilityCheck({
        binary: fakeOpenCode,
        env: { ...process.env, FAKE_OPENCODE_VERSION_STDOUT: "unexpected output\n" },
        signal: new AbortController().signal,
        testedVersion: testedOpenCodeVersion,
        pluginURL,
      })
    ).rejects.toThrow(/version could not be determined/u)
  })

  it("fails immediately when the OpenCode executable cannot be started", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()

    await expect(
      runOpenCodeCompatibilityCheck({
        binary: "/definitely/missing/opencode",
        env: { ...process.env },
        signal: new AbortController().signal,
        testedVersion: testedOpenCodeVersion,
        pluginURL,
      })
    ).rejects.toThrow(/OpenCode is required.*npm install --global opencode-ai@1\.18\.18/u)
  })

  it("does not report other executable errors as a missing installation", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()

    await expect(
      runOpenCodeCompatibilityCheck({
        binary: "/",
        env: { ...process.env },
        signal: new AbortController().signal,
        testedVersion: testedOpenCodeVersion,
        pluginURL,
      })
    ).rejects.toThrow(/Failed to spawn process/u)
  })

  it("reports a failed version command before running the loader", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()

    await expect(
      runOpenCodeCompatibilityCheck({
        binary: fakeOpenCode,
        env: { ...process.env, FAKE_OPENCODE_VERSION_EXIT_CODE: "7" },
        signal: new AbortController().signal,
        testedVersion: testedOpenCodeVersion,
        pluginURL,
      })
    ).rejects.toThrow(/version check exited with code 7/u)
  })

  it("derives the tested version from the exact plugin dependency", async () => {
    const metadata = await readPackageMetadata()
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(metadata.testedOpenCodeVersion).toMatch(/^\d+\.\d+\.\d+/u)
  })
})
