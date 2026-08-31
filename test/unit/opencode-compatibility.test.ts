import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { runOpenCodeCompatibilityCheck } from "../../src/opencode-compatibility.js"
import { readPackageMetadata } from "../../src/package-metadata.js"

const fakeOpenCode = fileURLToPath(new URL("../fixtures/bin/opencode", import.meta.url))
const pluginURL = new URL("../../", import.meta.url)
const BASELINE_VERSION = "1.18.18"

describe("OpenCode compatibility preflight", () => {
  it("supports Task resume when loader lookup is callable", async () => {
    const progress: string[] = []

    const result = await runOpenCodeCompatibilityCheck({
      binary: fakeOpenCode,
      env: {
        ...process.env,
        FAKE_OPENCODE_VERSION_STDOUT: `${BASELINE_VERSION}\n`,
        npm_config_opencode_ssh_probe_runtime_version:
          BASELINE_VERSION,
      },
      signal: new AbortController().signal,
      testedVersion: BASELINE_VERSION,
      pluginURL,
      writeProgress: (message) => progress.push(message),
      writeWarning: () => undefined,
    })

    expect(progress).toHaveLength(3)
    expect(progress[0]).toBe("checking OpenCode compatibility...")
    expect(progress[1]).toBe(
      `testing OpenCode ${BASELINE_VERSION} plugin loader...`
    )
    expect(progress[2]).toMatch(/^compatibility passed \([\d.]+s\)$/u)
    expect(result).toEqual({
      detectedVersion: BASELINE_VERSION,
      loaderRuntimeVersion: BASELINE_VERSION,
      loaderRuntimeVersionSource: "runtime-executable",
      callableSessionLookupObservedInLoaderProcess: true,
      taskResumeSupported: true,
    })
  })

  it("supports another loader-tested version with callable lookup", async () => {
    const loaderTestedVersion = "1.18.19"
    const warnings: string[] = []

    const result = await runOpenCodeCompatibilityCheck({
      binary: fakeOpenCode,
      env: {
        ...process.env,
        FAKE_OPENCODE_VERSION_STDOUT: `${loaderTestedVersion}\n`,
        npm_config_opencode_ssh_probe_runtime_version: loaderTestedVersion,
      },
      signal: new AbortController().signal,
      testedVersion: loaderTestedVersion,
      pluginURL,
      writeProgress: () => undefined,
      writeWarning: (message) => warnings.push(message),
    })

    expect(warnings).toEqual([])
    expect(result).toEqual({
      detectedVersion: loaderTestedVersion,
      loaderRuntimeVersion: loaderTestedVersion,
      loaderRuntimeVersionSource: "runtime-executable",
      callableSessionLookupObservedInLoaderProcess: true,
      taskResumeSupported: true,
    })
  })

  it("rejects outer version dispatch that differs from the loader runtime", async () => {
    await expect(
      runOpenCodeCompatibilityCheck({
        binary: fakeOpenCode,
        env: {
          ...process.env,
          FAKE_OPENCODE_VERSION_STDOUT: "1.18.19\n",
          npm_config_opencode_ssh_probe_runtime_version: "1.18.18",
        },
        signal: new AbortController().signal,
        testedVersion: "1.18.19",
        pluginURL,
      })
    ).rejects.toThrow(
      /reported OpenCode version "1\.18\.19" did not match loader runtime version "1\.18\.18".*SSH connection was not started/u
    )
  })

  it("rejects a loader without callable session lookup", async () => {
    const progress: string[] = []
    const warnings: string[] = []

    await expect(
      runOpenCodeCompatibilityCheck({
        binary: fakeOpenCode,
        env: {
          ...process.env,
          FAKE_OPENCODE_VERSION_STDOUT: `${BASELINE_VERSION}\n`,
          npm_config_opencode_ssh_probe_runtime_version:
            BASELINE_VERSION,
          npm_config_opencode_ssh_probe_without_session_get: "1",
        },
        signal: new AbortController().signal,
        testedVersion: BASELINE_VERSION,
        pluginURL,
        writeProgress: (message) => progress.push(message),
        writeWarning: (message) => warnings.push(message),
      })
    ).rejects.toThrow(
      /client\.session\.get required for Task safety.*SSH connection was not started/u
    )
    expect(progress).toEqual([
      "checking OpenCode compatibility...",
      `testing OpenCode ${BASELINE_VERSION} plugin loader...`,
    ])
    expect(warnings).toEqual([])
  })

  it.each([
    [
      "missing",
      { npm_config_opencode_ssh_probe_without_runtime_version: "1" },
    ],
    [
      "malformed",
      { npm_config_opencode_ssh_probe_runtime_version: "v1.18.18" },
    ],
  ])("rejects a %s loader health version", async (_name, probeEnv) => {
    await expect(
      runOpenCodeCompatibilityCheck({
        binary: fakeOpenCode,
        env: {
          ...process.env,
          FAKE_OPENCODE_VERSION_STDOUT: `${BASELINE_VERSION}\n`,
          ...probeEnv,
        },
        signal: new AbortController().signal,
        testedVersion: BASELINE_VERSION,
        pluginURL,
      })
    ).rejects.toThrow(/plugin loader returned an invalid result/u)
  })

  it("rejects a probe marker with additional fields", async () => {
    const { testedOpenCodeVersion } = await readPackageMetadata()

    await expect(
      runOpenCodeCompatibilityCheck({
        binary: fakeOpenCode,
        env: {
          ...process.env,
          npm_config_opencode_ssh_probe_extra_field: "1",
        },
        signal: new AbortController().signal,
        testedVersion: testedOpenCodeVersion,
        pluginURL,
      })
    ).rejects.toThrow(/plugin loader returned an invalid result/u)
  })

  it("forwards lowercase proxy settings needed by the loader", async () => {
    const proxy = "http://proxy.example.invalid:8080"

    await expect(
      runOpenCodeCompatibilityCheck({
        binary: fakeOpenCode,
        env: {
          ...process.env,
          FAKE_OPENCODE_VERSION_STDOUT: `${BASELINE_VERSION}\n`,
          npm_config_opencode_ssh_probe_runtime_version:
            BASELINE_VERSION,
          https_proxy: proxy,
          npm_config_opencode_ssh_expected_https_proxy: proxy,
        },
        signal: new AbortController().signal,
        testedVersion: BASELINE_VERSION,
        pluginURL,
      })
    ).resolves.toEqual({
      detectedVersion: BASELINE_VERSION,
      loaderRuntimeVersion: BASELINE_VERSION,
      loaderRuntimeVersionSource: "runtime-executable",
      callableSessionLookupObservedInLoaderProcess: true,
      taskResumeSupported: true,
    })
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

  it("derives the loader-tested version from the exact plugin dependency", async () => {
    const metadata = await readPackageMetadata()
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(metadata.testedOpenCodeVersion).toMatch(/^\d+\.\d+\.\d+/u)
  })
})
