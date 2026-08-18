import type { ToolContext } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { publishToolMetadata } from "../../src/opencode-metadata.js"

const update: Parameters<ToolContext["metadata"]>[0] = {
  title: "Streaming remote command",
  metadata: { output: "first chunk" },
}

describe("publishToolMetadata", () => {
  it("runs the Effect returned by the legacy metadata adapter exactly once", async () => {
    const effectWork = vi.fn()
    const metadata: ToolContext["metadata"] = vi.fn(() =>
      Effect.sync(() => {
        effectWork()
      })
    )

    await publishToolMetadata({ metadata }, update)

    expect(metadata).toHaveBeenCalledOnce()
    expect(metadata).toHaveBeenCalledWith(update)
    expect(effectWork).toHaveBeenCalledOnce()
  })

  it("does not duplicate an update performed by a void-returning host", async () => {
    const appliedUpdate = vi.fn()
    const metadata: ToolContext["metadata"] = vi.fn((input) => {
      appliedUpdate(input)
    })

    await publishToolMetadata({ metadata }, update)

    expect(metadata).toHaveBeenCalledOnce()
    expect(metadata).toHaveBeenCalledWith(update)
    expect(appliedUpdate).toHaveBeenCalledOnce()
    expect(appliedUpdate).toHaveBeenCalledWith(update)
  })

  it("rejects with a failure from the returned Effect", async () => {
    const failure = new Error("metadata publication failed")
    const metadata: ToolContext["metadata"] = vi.fn(() => Effect.fail(failure))

    await expect(publishToolMetadata({ metadata }, update)).rejects.toBe(failure)
    expect(metadata).toHaveBeenCalledOnce()
  })
})
