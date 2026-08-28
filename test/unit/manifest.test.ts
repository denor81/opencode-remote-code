import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { RemoteConfig } from "../../src/config.js"
import {
  ManifestManager,
  type ManifestFileSystem,
} from "../../src/manifest.js"
import { PathMapper } from "../../src/path-mapper.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("ManifestManager", () => {
  it("stores collision-free scoped mappings through a private atomic sibling", async () => {
    const mapper = new PathMapper(config(await trackedTempDirectory("manifest-map-")))
    const manifest = new ManifestManager(mapper)

    expect(manifest.register("/workspace/etc/hosts")).toBe("workspace/etc/hosts")
    expect(manifest.register("/etc/hosts")).toBe("external/etc/hosts")
    await manifest.save()

    const saved = JSON.parse(await readFile(mapper.manifestPath(), "utf8")) as {
      remote_root: string
      files: Record<string, string>
    }
    expect(saved.files).toEqual({
      "/workspace/etc/hosts": "workspace/etc/hosts",
      "/etc/hosts": "external/etc/hosts",
    })
    expect((await stat(mapper.manifestPath())).mode & 0o777).toBe(0o600)
    expect(await readdir(mapper.mirrorBase)).toEqual(["manifest.json"])
  })

  it("serializes immutable concurrent snapshots so an older save cannot overwrite a newer one", async () => {
    const mapper = new PathMapper(config(await trackedTempDirectory("manifest-race-")))
    const firstWriteStarted = deferred()
    const releaseFirstWrite = deferred()
    let writeCount = 0
    const snapshots: string[] = []
    const temporaryPaths: string[] = []
    const writeOptions: Array<{ encoding: "utf8"; flag: "wx"; mode: number }> = []
    const renames: Array<[string, string]> = []
    const fileSystem = manifestFileSystem({
      async writeFile(filePath, data, options) {
        writeCount++
        snapshots.push(data)
        temporaryPaths.push(filePath)
        writeOptions.push(options)
        if (writeCount === 1) {
          firstWriteStarted.resolve()
          await releaseFirstWrite.promise
        }
        await writeFile(filePath, data, options)
      },
      async rename(source, destination) {
        renames.push([source, destination])
        await rename(source, destination)
      },
    })
    const manifest = new ManifestManager(mapper, fileSystem)

    manifest.register("/workspace/first.txt")
    const olderSave = manifest.save()
    await within(firstWriteStarted.promise, 500, "first manifest write")

    manifest.register("/workspace/second.txt")
    const newerSave = manifest.save()
    await Promise.resolve()
    expect(writeCount).toBe(1)

    releaseFirstWrite.resolve()
    await Promise.all([olderSave, newerSave])

    expect(writeCount).toBe(2)
    expect(
      snapshots.map((snapshot) =>
        Object.keys((JSON.parse(snapshot) as { files: Record<string, string> }).files)
      )
    ).toEqual([
      ["/workspace/first.txt"],
      ["/workspace/first.txt", "/workspace/second.txt"],
    ])
    expect(temporaryPaths).toHaveLength(2)
    expect(temporaryPaths.every((filePath) => filePath !== mapper.manifestPath())).toBe(true)
    expect(writeOptions).toEqual([
      { encoding: "utf8", flag: "wx", mode: 0o600 },
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ])
    expect(renames).toEqual(
      temporaryPaths.map((filePath) => [filePath, mapper.manifestPath()])
    )
    const saved = JSON.parse(await readFile(mapper.manifestPath(), "utf8")) as {
      files: Record<string, string>
    }
    expect(saved.files).toEqual({
      "/workspace/first.txt": "workspace/first.txt",
      "/workspace/second.txt": "workspace/second.txt",
    })
    expect(await readdir(mapper.mirrorBase)).toEqual(["manifest.json"])
  })

  it("does not let an older completion mark a newer generation clean", async () => {
    const mapper = new PathMapper(config(await trackedTempDirectory("manifest-generation-")))
    const firstWriteStarted = deferred()
    const releaseFirstWrite = deferred()
    let writeCount = 0
    const fileSystem = manifestFileSystem({
      async writeFile(filePath, data, options) {
        writeCount++
        if (writeCount === 1) {
          firstWriteStarted.resolve()
          await releaseFirstWrite.promise
        }
        await writeFile(filePath, data, options)
      },
    })
    const manifest = new ManifestManager(mapper, fileSystem)

    manifest.register("/workspace/first.txt")
    const olderSave = manifest.save()
    await within(firstWriteStarted.promise, 500, "first manifest write")
    manifest.register("/workspace/second.txt")
    releaseFirstWrite.resolve()
    await olderSave

    await manifest.save()

    expect(writeCount).toBe(2)
    const saved = JSON.parse(await readFile(mapper.manifestPath(), "utf8")) as {
      files: Record<string, string>
    }
    expect(Object.keys(saved.files).sort()).toEqual([
      "/workspace/first.txt",
      "/workspace/second.txt",
    ])
  })
})

function manifestFileSystem(
  overrides: Partial<ManifestFileSystem>
): ManifestFileSystem {
  return {
    readFile: (filePath) => readFile(filePath, "utf8"),
    mkdir: async (directory) => {
      await mkdir(directory, { recursive: true })
    },
    writeFile: (filePath, data, options) => writeFile(filePath, data, options),
    rename,
    rm: async (filePath) => {
      await rm(filePath, { force: true })
    },
    ...overrides,
  }
}

function config(mirrorRoot: string): RemoteConfig {
  return {
    alias: "fixture-host",
    remoteWorkdir: "/workspace",
    controlSocket: "/tmp/opencode-ssh/runtime/control.sock",
    targetID: "a".repeat(64),
    launchID: "manifest-test",
    readyPath: "/tmp/opencode-ssh/state/ready.json",
    readyNonce: "fixture-ready-nonce-0123456789abcdef",
    runtimeDir: "/tmp/opencode-ssh/runtime",
    mirrorRoot,
    sshBinary: "ssh",
    sftpBinary: "sftp",
    active: true,
  }
}

async function trackedTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
