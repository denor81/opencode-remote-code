import { describe, expect, it } from "vitest"
import { replaceContent } from "../../src/tools/edit.js"

describe("OpenCode 1.18.18 edit matching", () => {
  it("rejects matching anchors with unrelated middle content", () => {
    const content = [
      "function configure() {",
      "  productionDatabase.dropEverything()",
      "}",
    ].join("\n")
    const stale = [
      "function configure() {",
      "  logger.info('safe setup')",
      "}",
    ].join("\n")

    expect(() => replaceContent(content, stale, "replacement")).toThrow(
      /Could not find oldString/
    )
    expect(content).toContain("productionDatabase")
  })

  it("does not consume an inserted line between otherwise matching anchors", () => {
    const content = ["start", "safe", "danger", "end"].join("\n")
    const stale = ["start", "safe", "end"].join("\n")

    expect(() => replaceContent(content, stale, "replacement")).toThrow(
      /Could not find oldString/
    )
  })

  it("requires every nonempty middle context line to match", () => {
    const content = ["start", "safe", "danger", "end"].join("\n")
    const stale = ["start", "safe", "unrelated", "end"].join("\n")

    expect(() => replaceContent(content, stale, "replacement")).toThrow(
      /Could not find oldString/
    )
  })

  it("keeps exact unique and replaceAll behavior", () => {
    expect(replaceContent("one\ntwo\n", "two", "three")).toBe("one\nthree\n")
    expect(replaceContent("x x x", "x", "$value", true)).toBe(
      "$value $value $value"
    )
  })

  it("rejects a disproportionately larger fuzzy span", () => {
    const content = ["start", "a", "b", "c", "d", "e", "end"].join("\n")
    const stale = ["start", "a", "end"].join("\n")
    expect(() => replaceContent(content, stale, "replacement")).toThrow()
  })
})
