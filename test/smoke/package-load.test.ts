import { describe, expect, it } from "vitest"

const LAUNCHER_ENV_PREFIX = "OPENCODE_SSH"

describe("package entry", () => {
  it("loads the built server plugin without activating outside a launcher", async () => {
    const savedEnvironment = takeLauncherEnvironment()
    clearLauncherEnvironment()

    try {
      const packageEntry = await import(new URL("../../dist/index.js", import.meta.url).href)

      expect(packageEntry.default).toMatchObject({
        id: "opencode-ssh",
        server: expect.any(Function),
      })
      await expect(packageEntry.default.server({} as never, {})).resolves.toEqual({})
    } finally {
      clearLauncherEnvironment()
      for (const [name, value] of savedEnvironment) process.env[name] = value
    }
  })
})

function takeLauncherEnvironment(): Map<string, string> {
  const saved = new Map<string, string>()
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith(LAUNCHER_ENV_PREFIX) && value !== undefined) saved.set(name, value)
  }
  return saved
}

function clearLauncherEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(LAUNCHER_ENV_PREFIX)) delete process.env[name]
  }
}
