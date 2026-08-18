import { createHash } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  MAX_SOCKET_PATH_BYTES,
  computeTargetID,
  createLaunchPaths,
  createRuntimePaths,
  resolveRuntimePaths,
} from "../../src/runtime-paths.js"

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-runtime-paths-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("computeTargetID", () => {
  it("hashes alias, a NUL delimiter, and canonical workdir", () => {
    const expected = createHash("sha256").update("staging\0/srv/app").digest("hex")
    expect(computeTargetID("staging", "/srv/app")).toBe(expected)
    expect(computeTargetID("staging", "/srv/app")).toHaveLength(64)
  })
})

describe("runtime paths", () => {
  it("creates stable target paths and launch-specific paths", async () => {
    const root = await temporaryRoot()
    const common = {
      alias: "staging",
      canonicalWorkdir: "/srv/app with spaces",
      env: {
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_RUNTIME_DIR: path.join(root, "run"),
      },
      homeDir: path.join(root, "home"),
      tmpDir: path.join(root, "tmp"),
      uid: 1234,
    }

    const first = await createRuntimePaths({ ...common, launchID: "launch-one" })
    const second = await createRuntimePaths({ ...common, launchID: "launch-two" })

    expect(first.targetID).toBe(second.targetID)
    expect(first.workspaceDir).toBe(second.workspaceDir)
    expect(first.cacheDir).toBe(second.cacheDir)
    expect(first.mirrorDir).toBe(path.join(first.cacheDir, "mirror", "launch-one"))
    expect(first.mirrorDir).not.toBe(second.mirrorDir)
    expect(first.socketPath).not.toBe(second.socketPath)
    expect(first.readyPath).not.toBe(second.readyPath)
    expect(first.readyPath).toBe(path.join(first.stateDir, "plugin-ready-launch-one.json"))
    expect(first.socketPath).toBe(path.join(root, "run", "opencode-ssh-1234", "launch-one.sock"))

    for (const directory of [
      first.stateRoot,
      first.stateDir,
      first.workspaceDir,
      first.cacheRoot,
      first.cacheDir,
      first.mirrorDir,
      first.runtimeDir,
    ]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    }
  })

  it("uses /tmp-compatible fallback paths when XDG_RUNTIME_DIR is too long", async () => {
    const root = await temporaryRoot()
    const fallback = path.join(root, "r")
    const paths = await createLaunchPaths({
      launchID: "fixed-launch",
      env: { XDG_RUNTIME_DIR: path.join(root, "x".repeat(120)) },
      tmpDir: fallback,
      uid: 99,
    })

    expect(paths.runtimeDir).toBe(path.join(fallback, "opencode-ssh-99"))
    expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES)
    expect((await stat(paths.runtimeDir)).mode & 0o777).toBe(0o700)
  })

  it("hashes an unusually long launch ID for a short socket filename", async () => {
    const root = await temporaryRoot()
    const launchID = `launch-${"x".repeat(110)}`
    const paths = await createLaunchPaths({
      launchID,
      env: {},
      tmpDir: path.join(root, "r"),
      uid: 7,
    })

    expect(path.basename(paths.socketPath)).not.toContain(launchID)
    expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES)
  })

  it("accepts the canonical root workdir and supports deterministic launch IDs", () => {
    const paths = resolveRuntimePaths({
      alias: "host",
      canonicalWorkdir: "/",
      launchID: "test-launch",
      env: {},
      homeDir: "/home/tester",
      tmpDir: "/tmp",
      uid: 1,
    })
    expect(paths.launchID).toBe("test-launch")
    expect(paths.workspaceDir).toContain(paths.targetID)
  })

  it("rejects unsafe target and launch values", () => {
    expect(() => computeTargetID("bad host", "/srv/app")).toThrow(/alias/)
    expect(() => computeTargetID("host", "srv/app")).toThrow(/absolute POSIX/)
    expect(() =>
      resolveRuntimePaths({
        alias: "host",
        canonicalWorkdir: "/srv/app\nother",
        launchID: "launch",
        env: {},
        homeDir: "/home/tester",
      })
    ).toThrow(/absolute POSIX/)
    expect(() =>
      resolveRuntimePaths({
        alias: "host",
        canonicalWorkdir: "/srv/app",
        launchID: "bad/id",
        env: {},
        homeDir: "/home/tester",
      })
    ).toThrow(/launch ID/)
  })
})
