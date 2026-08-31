import { describe, expect, it } from "vitest"
import {
  LauncherConfigError,
  mergeOpenCodeConfigContent,
  parseCli,
} from "../../src/launcher-config.js"
import {
  TASK_RESUME_PROTOCOL,
} from "../../src/task-resume-capability.js"

describe("parseCli", () => {
  it("accepts exactly an alias and an absolute POSIX workdir", () => {
    expect(parseCli(["staging", "/srv/app with spaces"])).toEqual({
      action: "launch",
      alias: "staging",
      workdir: "/srv/app with spaces",
    })
    expect(parseCli(["staging", "/"])).toEqual({
      action: "launch",
      alias: "staging",
      workdir: "/",
    })
  })

  it("models launcher-owned help, version, and self-test commands", () => {
    expect(parseCli(["--help"])).toEqual({ action: "help" })
    expect(parseCli(["-h"])).toEqual({ action: "help" })
    expect(parseCli(["--version"])).toEqual({ action: "version" })
    expect(parseCli(["-V"])).toEqual({ action: "version" })
    expect(parseCli(["self-test"])).toEqual({ action: "self-test" })
  })

  it("does not accept OpenCode argument forwarding", () => {
    expect(() => parseCli(["staging", "/srv/app", "--model", "test/model"])).toThrow(
      /Usage/
    )
    expect(() => parseCli(["staging", "/srv/app", "--", "--help"])).toThrow(/Usage/)
  })

  it.each([
    "-staging",
    "bad host",
    "bad:host",
    "bad;host",
    "bad\thost",
    "bad\u0000host",
    "bad\u0085host",
  ])(
    "rejects invalid SSH alias %j",
    (alias) => {
      expect(() => parseCli([alias, "/srv/app"])).toThrow(/SSH alias/)
    }
  )

  it.each(["srv/app", "./srv/app", "", "/srv/app\nother", "/srv/\u007fapp"])(
    "rejects invalid workdir %j",
    (workdir) => {
      expect(() => parseCli(["staging", workdir])).toThrow(/absolute POSIX path/)
    }
  )
})

describe("mergeOpenCodeConfigContent", () => {
  const safetyInstructionsPath = "/opt/opencode/opencode-ssh-safety.md"
  const expectedRuntimeVersion = "1.18.18"

  it("creates additive config when existing content is absent", () => {
    const merged = JSON.parse(
      mergeOpenCodeConfigContent(
        undefined,
        "file:///opt/opencode/plugin.js",
        "launch-1",
        safetyInstructionsPath,
        expectedRuntimeVersion
      )
    ) as Record<string, unknown>

    expect(merged).toEqual({
      instructions: [safetyInstructionsPath],
      plugin: [[
        "file:///opt/opencode/plugin.js",
        {
          launchID: "launch-1",
          expectedOpenCodeRuntimeVersion: expectedRuntimeVersion,
        },
      ]],
    })
  })

  it("treats empty environment content as absent", () => {
    expect(
      JSON.parse(
        mergeOpenCodeConfigContent(
          "  \n",
          "file:///opt/opencode/plugin.js",
          "launch-1",
          safetyInstructionsPath,
          expectedRuntimeVersion
        )
      )
    ).toEqual({
      instructions: [safetyInstructionsPath],
      plugin: [[
        "file:///opt/opencode/plugin.js",
        {
          launchID: "launch-1",
          expectedOpenCodeRuntimeVersion: expectedRuntimeVersion,
        },
      ]],
    })
  })

  it("injects the private Task resume protocol only when supported", () => {
    const merged = JSON.parse(
      mergeOpenCodeConfigContent(
        undefined,
        "file:///opt/opencode/plugin.js",
        "launch-1",
        safetyInstructionsPath,
        expectedRuntimeVersion,
        TASK_RESUME_PROTOCOL
      )
    ) as { plugin: unknown[] }

    expect(merged.plugin).toEqual([
      [
        "file:///opt/opencode/plugin.js",
        {
          launchID: "launch-1",
          expectedOpenCodeRuntimeVersion: expectedRuntimeVersion,
          taskResumeCapability: TASK_RESUME_PROTOCOL,
        },
      ],
    ])
  })

  it("parses JSONC and preserves all fields and existing plugins", () => {
    const content = `{
      // Keep the user's normal configuration.
      "model": "provider/model",
      "mcp": { "search": { "enabled": true } },
      "instructions": ["CONTRIBUTING.md"],
      "plugin": ["existing-plugin",],
    }`
    const merged = JSON.parse(
      mergeOpenCodeConfigContent(
        content,
        new URL("file:///opt/opencode/plugin.js"),
        "fixed-id",
        safetyInstructionsPath,
        expectedRuntimeVersion
      )
    ) as {
      instructions: string[]
      model: string
      mcp: unknown
      plugin: unknown[]
    }

    expect(merged.model).toBe("provider/model")
    expect(merged.mcp).toEqual({ search: { enabled: true } })
    expect(merged.instructions).toEqual(["CONTRIBUTING.md", safetyInstructionsPath])
    expect(merged.plugin).toEqual([
      "existing-plugin",
      [
        "file:///opt/opencode/plugin.js",
        {
          launchID: "fixed-id",
          expectedOpenCodeRuntimeVersion: expectedRuntimeVersion,
        },
      ],
    ])
  })

  it("does not duplicate an existing safety instruction path", () => {
    const merged = JSON.parse(
      mergeOpenCodeConfigContent(
        JSON.stringify({ instructions: ["CONTRIBUTING.md", safetyInstructionsPath] }),
        "file:///opt/opencode/plugin.js",
        "launch-1",
        safetyInstructionsPath,
        expectedRuntimeVersion
      )
    ) as { instructions: string[] }

    expect(merged.instructions).toEqual(["CONTRIBUTING.md", safetyInstructionsPath])
  })

  it.each([
    { name: "malformed", content: "{]", expected: /malformed/ },
    { name: "array root", content: "[]", expected: /JSON object/ },
    { name: "null root", content: "null", expected: /JSON object/ },
    {
      name: "non-array plugin",
      content: '{"plugin": {}}',
      expected: /plugin must be an array/,
    },
    {
      name: "non-array instructions",
      content: '{"instructions": {}}',
      expected: /instructions must be an array of strings/,
    },
    {
      name: "non-string instruction",
      content: '{"instructions": ["README.md", 1]}',
      expected: /instructions must be an array of strings/,
    },
  ])("rejects $name input", ({ content, expected }) => {
    expect(() =>
      mergeOpenCodeConfigContent(
        content,
        "file:///opt/opencode/plugin.js",
        "launch-1",
        safetyInstructionsPath,
        expectedRuntimeVersion
      )
    ).toThrow(expected)
  })

  it("requires a file URL and a safe launch ID", () => {
    expect(() =>
      mergeOpenCodeConfigContent(
        "{}",
        "https://example.test/plugin.js",
        "launch-1",
        safetyInstructionsPath,
        expectedRuntimeVersion
      )
    ).toThrow(LauncherConfigError)
    expect(() =>
      mergeOpenCodeConfigContent(
        "{}",
        "file:///plugin.js",
        "bad/id",
        safetyInstructionsPath,
        expectedRuntimeVersion
      )
    ).toThrow(/Launch ID/)
  })

  it.each(["", "v1.18.18", "01.18.18", "1.18"])(
    "rejects invalid expected runtime version %j",
    (version) => {
      expect(() =>
        mergeOpenCodeConfigContent(
          undefined,
          "file:///opt/opencode/plugin.js",
          "launch-1",
          safetyInstructionsPath,
          version
        )
      ).toThrow(/Expected OpenCode runtime version/i)
    }
  )
})
