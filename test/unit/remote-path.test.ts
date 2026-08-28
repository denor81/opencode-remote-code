import type { ToolContext } from "@opencode-ai/plugin"
import { describe, expect, it, vi } from "vitest"
import {
  isWithinRemoteRoot,
  normalizeRemotePath,
  requestExternalDirectory,
} from "../../src/remote-path.js"

describe("remote path normalization", () => {
  it("normalizes relative and absolute POSIX paths against the remote root", () => {
    expect(normalizeRemotePath("/srv/app", "src/../README.md")).toBe(
      "/srv/app/README.md"
    )
    expect(normalizeRemotePath("/srv/app", "/var//log/../tmp/file")).toBe(
      "/var/tmp/file"
    )
    expect(normalizeRemotePath("/srv/app/../canonical", "./nested/..")).toBe(
      "/srv/canonical"
    )
    expect(normalizeRemotePath("/srv/app", "")).toBe("/srv/app")
    for (const control of ["\0", "\n", "\t", "\u007f", "\u0080"]) {
      expect(() => normalizeRemotePath("/srv/app", `bad${control}path`)).toThrow(
        /without control characters/
      )
    }
  })

  it("uses path-segment containment after normalization", () => {
    expect(isWithinRemoteRoot("/srv/other/../app", "/srv/app")).toBe(true)
    expect(isWithinRemoteRoot("/srv/app", "/srv/app/src/../README.md")).toBe(true)
    expect(isWithinRemoteRoot("/srv/app", "/srv/application/file")).toBe(false)
    expect(isWithinRemoteRoot("/srv/app", "/srv/app/../../etc/passwd")).toBe(false)
  })
})

describe("external directory permission", () => {
  it("requests permission for a normalized path outside the workspace", async () => {
    const ask = vi.fn(async () => undefined)
    const context = { ask } as unknown as ToolContext
    const outside = normalizeRemotePath("/srv/app", "../shared/file.txt")

    await requestExternalDirectory(context, "/srv/app", outside)

    expect(ask).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledWith({
      permission: "external_directory",
      patterns: ["/srv/shared/file.txt"],
      always: [],
      metadata: {
        executor: "ssh",
        remoteWorkspace: "/srv/app",
      },
    })
  })

  it("never requests external permission when the remote workspace is root", async () => {
    const ask = vi.fn(async () => undefined)
    const context = { ask } as unknown as ToolContext

    await requestExternalDirectory(context, "/", "/etc/passwd")
    await requestExternalDirectory(context, "/", "../../var/log")
    await requestExternalDirectory(context, "/", "/")

    expect(ask).not.toHaveBeenCalled()
  })
})
