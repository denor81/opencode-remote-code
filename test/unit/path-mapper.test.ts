import path from "node:path"
import { describe, expect, it } from "vitest"
import type { RemoteConfig } from "../../src/config.js"
import { PathMapper } from "../../src/path-mapper.js"

describe("PathMapper", () => {
  it("normalizes remote paths and round-trips workspace mappings", () => {
    const mapper = new PathMapper(config("/srv/other/../app", "/tmp/path-mapper/mirror"))
    const relative = mapper.toLocal("src/../README.md")
    const absolute = mapper.toLocal("/srv/app/docs/../README.md")

    expect(mapper.remoteRoot).toBe("/srv/app")
    expect(relative).toBe(path.join(mapper.mirrorBase, "workspace", "README.md"))
    expect(absolute).toBe(relative)
    expect(mapper.toRemote(relative)).toBe("/srv/app/README.md")
    expect(mapper.isWithinWorkspace("/srv/app/../app/README.md")).toBe(true)
    expect(mapper.isWithinWorkspace("/srv/application/README.md")).toBe(false)
  })

  it("keeps same-suffix inside and outside paths collision-free", () => {
    const mapper = new PathMapper(config("/srv/app", "/tmp/path-mapper/collisions"))
    const inside = mapper.toLocal("/srv/app/etc/hosts")
    const outside = mapper.toLocal("/etc/hosts")

    expect(inside).toBe(path.join(mapper.mirrorBase, "workspace", "etc", "hosts"))
    expect(outside).toBe(path.join(mapper.mirrorBase, "external", "etc", "hosts"))
    expect(inside).not.toBe(outside)
    expect(mapper.toRemote(inside)).toBe("/srv/app/etc/hosts")
    expect(mapper.toRemote(outside)).toBe("/etc/hosts")
  })

  it("maps workspace and filesystem roots without ambiguity", () => {
    const mapper = new PathMapper(config("/srv/app", "/tmp/path-mapper/roots"))
    const workspaceRoot = mapper.toLocal("/srv/app")
    const externalRoot = mapper.toLocal("/")

    expect(workspaceRoot).toBe(path.join(mapper.mirrorBase, "workspace"))
    expect(externalRoot).toBe(path.join(mapper.mirrorBase, "external"))
    expect(mapper.toRemote(workspaceRoot)).toBe("/srv/app")
    expect(mapper.toRemote(externalRoot)).toBe("/")

    const rootMapper = new PathMapper(config("/", "/tmp/path-mapper/root-workspace"))
    expect(rootMapper.toLocal("/")).toBe(path.join(rootMapper.mirrorBase, "workspace"))
    expect(rootMapper.toLocal("/etc/hosts")).toBe(
      path.join(rootMapper.mirrorBase, "workspace", "etc", "hosts")
    )
    expect(rootMapper.toRemote(rootMapper.toLocal("/"))).toBe("/")
    expect(rootMapper.isWithinWorkspace("/any/normalized/../path")).toBe(true)
  })
})

function config(remoteWorkdir: string, mirrorRoot: string): RemoteConfig {
  return {
    alias: "fixture-host",
    remoteWorkdir,
    controlSocket: "/tmp/opencode-ssh/runtime/control.sock",
    targetID: "a".repeat(64),
    launchID: "path-mapper-test",
    readyPath: "/tmp/opencode-ssh/state/ready.json",
    readyNonce: "fixture-ready-nonce-0123456789abcdef",
    runtimeDir: "/tmp/opencode-ssh/runtime",
    mirrorRoot,
    sshBinary: "ssh",
    sftpBinary: "sftp",
    active: true,
  }
}
