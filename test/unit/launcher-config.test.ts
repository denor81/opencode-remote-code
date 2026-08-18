import { describe, expect, it } from "vitest"
import {
  LauncherConfigError,
  mergeOpenCodeConfigContent,
  parseCli,
} from "../../src/launcher-config.js"

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

  it("models launcher-owned help and version commands", () => {
    expect(parseCli(["--help"])).toEqual({ action: "help" })
    expect(parseCli(["-h"])).toEqual({ action: "help" })
    expect(parseCli(["--version"])).toEqual({ action: "version" })
    expect(parseCli(["-V"])).toEqual({ action: "version" })
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
  it("creates additive config when existing content is absent", () => {
    const merged = JSON.parse(
      mergeOpenCodeConfigContent(undefined, "file:///opt/opencode/plugin.js", "launch-1")
    ) as Record<string, unknown>

    expect(merged).toEqual({
      plugin: [["file:///opt/opencode/plugin.js", { launchID: "launch-1" }]],
    })
  })

  it("treats empty environment content as absent", () => {
    expect(
      JSON.parse(
        mergeOpenCodeConfigContent("  \n", "file:///opt/opencode/plugin.js", "launch-1")
      )
    ).toEqual({
      plugin: [["file:///opt/opencode/plugin.js", { launchID: "launch-1" }]],
    })
  })

  it("parses JSONC and preserves all fields and existing plugins", () => {
    const content = `{
      // Keep the user's normal configuration.
      "model": "provider/model",
      "mcp": { "search": { "enabled": true } },
      "plugin": ["existing-plugin",],
    }`
    const merged = JSON.parse(
      mergeOpenCodeConfigContent(content, new URL("file:///opt/opencode/plugin.js"), "fixed-id")
    ) as {
      model: string
      mcp: unknown
      plugin: unknown[]
    }

    expect(merged.model).toBe("provider/model")
    expect(merged.mcp).toEqual({ search: { enabled: true } })
    expect(merged.plugin).toEqual([
      "existing-plugin",
      ["file:///opt/opencode/plugin.js", { launchID: "fixed-id" }],
    ])
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
  ])("rejects $name input", ({ content, expected }) => {
    expect(() =>
      mergeOpenCodeConfigContent(content, "file:///opt/opencode/plugin.js", "launch-1")
    ).toThrow(expected)
  })

  it("requires a file URL and a safe launch ID", () => {
    expect(() =>
      mergeOpenCodeConfigContent("{}", "https://example.test/plugin.js", "launch-1")
    ).toThrow(LauncherConfigError)
    expect(() =>
      mergeOpenCodeConfigContent("{}", "file:///plugin.js", "bad/id")
    ).toThrow(/Launch ID/)
  })
})
