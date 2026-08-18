import { createHash } from "node:crypto"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolContext } from "@opencode-ai/plugin"
import { afterEach, describe, expect, it } from "vitest"
import type { RemoteConfig } from "../../src/config.js"
import { ManifestManager } from "../../src/manifest.js"
import { PathMapper } from "../../src/path-mapper.js"
import { RemotePathResolver } from "../../src/remote-path-resolver.js"
import type { SSHPool } from "../../src/ssh-pool.js"
import type { ExecOptions, RemoteCommandResult } from "../../src/ssh/client.js"
import {
  DEFAULT_SFTP_TIMEOUT_MS,
  SftpClient,
  SftpFileNotFoundError,
  type SftpClientOptions,
  type SftpTransferOptions,
} from "../../src/ssh/sftp.js"
import {
  RemoteFileConflict,
  RemoteFileLockError,
  SyncEngine,
} from "../../src/sync-engine.js"
import { createReadTool } from "../../src/tools/read.js"
import { createPatchTool } from "../../src/tools/patch.js"
import { createWriteTool } from "../../src/tools/write.js"

const fakeSftp = fileURLToPath(new URL("../fixtures/bin/sftp", import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("SyncEngine", () => {
  it("never uploads A after reading A and writing B", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/a.txt", "A remains remote\n")
    await pool.writeRemote("/workspace/b.txt", "B before\n", 0o640)
    const fixture = await createEngine(pool)
    const ctx = toolContext()

    await createReadTool(fixture.mapper, fixture.engine, pool, fixture.resolver).execute(
      { filePath: "/workspace/a.txt" },
      ctx
    )
    pool.downloads.length = 0
    pool.uploads.length = 0

    await createWriteTool(fixture.mapper, fixture.engine, fixture.resolver).execute(
      { filePath: "/workspace/b.txt", content: "B after\n" },
      ctx
    )

    expect(await pool.readRemote("/workspace/a.txt")).toBe("A remains remote\n")
    expect(await pool.readRemote("/workspace/b.txt")).toBe("B after\n")
    expect(pool.downloads).toEqual([
      "/workspace/b.txt",
      "/workspace/b.txt",
      "/workspace/b.txt",
    ])
    expect(pool.uploads).toHaveLength(1)
    expect(pool.uploads[0]).toMatch(/^\/workspace\/\.b\.txt\.opencode-[a-f0-9]+\.tmp$/)
    expect(pool.uploads[0]).not.toContain("a.txt")
    expect((await pool.statRemote("/workspace/b.txt")).mode & 0o777).toBe(0o640)
  })

  it("fresh write pulls existing content before its diff and preserves its BOM", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/bom.txt", Buffer.from("\ufeffold value\n"))
    const fixture = await createEngine(pool)
    let permission: Parameters<ToolContext["ask"]>[0] | undefined

    const result = await createWriteTool(
      fixture.mapper,
      fixture.engine,
      fixture.resolver
    ).execute(
      { filePath: "/workspace/bom.txt", content: "new value\n" },
      toolContext(async (input) => {
        permission = input
      })
    )

    expect(result).not.toBeTypeOf("string")
    expect(typeof result === "string" ? undefined : result.metadata).toMatchObject({
      exists: true,
    })
    expect(permission?.metadata.diff).toContain("-old value")
    expect(permission?.metadata.diff).toContain("+new value")
    expect(await pool.readRemote("/workspace/bom.txt")).toBe("\ufeffnew value\n")
  })

  it("throws RemoteFileConflict without replacing a second writer's content", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/shared.txt", "original\n")
    const first = await createEngine(pool)
    const second = await createEngine(pool)

    await first.engine.pull("/workspace/shared.txt")
    await second.engine.pull("/workspace/shared.txt")
    await writeFile(first.mapper.toLocal("/workspace/shared.txt"), "first writer\n")
    await writeFile(second.mapper.toLocal("/workspace/shared.txt"), "second writer\n")

    await first.engine.push("/workspace/shared.txt")
    const conflict = await second.engine
      .push("/workspace/shared.txt")
      .catch((error: unknown) => error)

    expect(conflict).toBeInstanceOf(RemoteFileConflict)
    expect(conflict).toMatchObject({
      code: "REMOTE_FILE_CONFLICT",
      remotePath: "/workspace/shared.txt",
    })
    expect(await pool.readRemote("/workspace/shared.txt")).toBe("first writer\n")
  })

  it("leaves the destination unchanged and removes a partial temp after upload failure", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/safe.txt", "safe destination\n")
    const fixture = await createEngine(pool)

    await fixture.engine.pull("/workspace/safe.txt")
    await writeFile(fixture.mapper.toLocal("/workspace/safe.txt"), "replacement\n")
    pool.uploads.length = 0
    pool.failNextUpload = true

    await expect(fixture.engine.push("/workspace/safe.txt")).rejects.toThrow(
      /injected upload failure/
    )

    expect(pool.uploads).toHaveLength(1)
    expect(await pool.readRemote("/workspace/safe.txt")).toBe("safe destination\n")
    expect(await pool.listRemote("/workspace")).toEqual(["safe.txt"])
  })

  it("preflights every pushMany baseline before the first upload", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/one.txt", "one remote\n")
    await pool.writeRemote("/workspace/two.txt", "two remote\n")
    const fixture = await createEngine(pool)

    await fixture.engine.pull("/workspace/one.txt")
    await fixture.engine.pull("/workspace/two.txt")
    await writeFile(fixture.mapper.toLocal("/workspace/one.txt"), "one local\n")
    await writeFile(fixture.mapper.toLocal("/workspace/two.txt"), "two local\n")
    await pool.writeRemote("/workspace/two.txt", "concurrent writer\n")
    pool.downloads.length = 0
    pool.uploads.length = 0

    await expect(
      fixture.engine.pushMany(["/workspace/one.txt", "/workspace/two.txt"])
    ).rejects.toBeInstanceOf(RemoteFileConflict)

    expect(pool.downloads).toEqual(["/workspace/one.txt", "/workspace/two.txt"])
    expect(pool.uploads).toEqual([])
    expect(await pool.readRemote("/workspace/one.txt")).toBe("one remote\n")
  })

  it("holds one transaction across local work without nested facade deadlocks", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/shared.txt", "before\n")
    const fixture = await createEngine(pool)
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve
    })

    const first = fixture.engine.transaction(async (transaction) => {
      await transaction.pull("/workspace/shared.txt")
      await writeFile(fixture.mapper.toLocal("/workspace/shared.txt"), "after\n")
      firstStarted()
      await firstCanFinish
      await transaction.push("/workspace/shared.txt")
    })
    await firstDidStart

    let secondEntered = false
    const second = fixture.engine.transaction(async (transaction) => {
      secondEntered = true
      await transaction.pull("/workspace/shared.txt")
      return readFile(fixture.mapper.toLocal("/workspace/shared.txt"), "utf8")
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondEntered).toBe(false)

    releaseFirst()
    await first
    await expect(second).resolves.toBe("after\n")
  })

  it("fails closed on a stale deterministic remote lock", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/locked.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    const lockPath = remoteLockPath(remotePath)
    await pool.exec(`mkdir ${lockPath}`)
    pool.uploads.length = 0

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(RemoteFileLockError)
    expect(error).toMatchObject({
      code: "REMOTE_FILE_LOCKED",
      remotePath,
      lockPath,
    })
    expect(pool.uploads).toEqual([])
    expect(await pool.readRemote(remotePath)).toBe("before\n")
    expect((await pool.statRemote(lockPath)).isDirectory()).toBe(true)
  })

  it("acquires sorted multi-file locks and releases them in reverse", async () => {
    const pool = await createRemotePool()
    const firstPath = "/workspace/a.txt"
    const secondPath = "/workspace/z.txt"
    await pool.writeRemote(firstPath, "a before\n")
    await pool.writeRemote(secondPath, "z before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(secondPath)
    await fixture.engine.pull(firstPath)
    await writeFile(fixture.mapper.toLocal(firstPath), "a after\n")
    await writeFile(fixture.mapper.toLocal(secondPath), "z after\n")
    pool.commands.length = 0

    await fixture.engine.pushMany([secondPath, firstPath])

    const firstLock = remoteLockPath(firstPath)
    const secondLock = remoteLockPath(secondPath)
    expect(
      pool.commands.filter(
        (command) => command.startsWith("mkdir /workspace/.opencode-lock-") || command.startsWith("rmdir ")
      )
    ).toEqual([
      `mkdir ${firstLock}`,
      `mkdir ${secondLock}`,
      `rmdir ${secondLock}`,
      `rmdir ${firstLock}`,
    ])
  })

  it("revalidates immediately before rename and keeps a racing writer's content", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/race.txt"
    await pool.writeRemote(remotePath, "baseline\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "our update\n")
    pool.afterNextUpload = () => pool.writeRemote(remotePath, "racing writer\n")

    await expect(fixture.engine.push(remotePath)).rejects.toBeInstanceOf(RemoteFileConflict)

    expect(await pool.readRemote(remotePath)).toBe("racing writer\n")
    expect(await pool.listRemote("/workspace")).toEqual(["race.txt"])
  })

  it("uploads an immutable snapshot rather than the mutable mirror", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/snapshot.txt"
    await pool.writeRemote(remotePath, "baseline\n")
    const fixture = await createEngine(pool)
    const localPath = fixture.mapper.toLocal(remotePath)
    await fixture.engine.pull(remotePath)
    await writeFile(localPath, "planned update\n")
    pool.beforeNextUpload = () => writeFile(localPath, "late mirror overwrite\n")

    await fixture.engine.push(remotePath)

    expect(await pool.readRemote(remotePath)).toBe("planned update\n")
    expect(await readFile(localPath, "utf8")).toBe("late mirror overwrite\n")
  })

  it("creates an empty mirror only for a typed remote ENOENT", async () => {
    const pool = await createRemotePool()
    const fixture = await createEngine(pool)

    await expect(fixture.engine.pull("/workspace/missing.txt")).resolves.toBe(false)
    expect(await readFile(fixture.mapper.toLocal("/workspace/missing.txt"), "utf8")).toBe("")

    pool.nextDownloadError = new Error("No such file or directory")
    await expect(fixture.engine.pull("/workspace/untyped.txt")).rejects.toThrow(
      /No such file or directory/
    )
    await expect(stat(fixture.mapper.toLocal("/workspace/untyped.txt"))).rejects.toThrow()
  })
})

describe("remote patch mutations", () => {
  it("returns structured per-file metadata for the OpenCode apply_patch renderer", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/existing.txt", "before\n")
    const fixture = await createEngine(pool)
    let permission: Parameters<ToolContext["ask"]>[0] | undefined

    const result = await createPatchTool(
      config(fixture.mapper.mirrorBase),
      fixture.mapper,
      fixture.engine,
      fixture.resolver
    ).execute(
      {
        patchText: [
          "*** Begin Patch",
          "*** Add File: added.txt",
          "+first",
          "+second",
          "*** Update File: existing.txt",
          "@@",
          "-before",
          "+after",
          "*** End Patch",
        ].join("\n"),
      },
      toolContext(async (input) => {
        permission = input
      })
    )

    if (typeof result === "string") throw new Error("Expected a structured tool result")
    expect(result.metadata).toMatchObject({
      executor: "ssh",
      remotePaths: ["/workspace/added.txt", "/workspace/existing.txt"],
      files: [
        {
          type: "add",
          relativePath: "added.txt",
          filePath: "/workspace/added.txt",
          additions: 2,
          deletions: 0,
        },
        {
          type: "update",
          relativePath: "existing.txt",
          filePath: "/workspace/existing.txt",
          additions: 1,
          deletions: 1,
        },
      ],
    })
    const files = result.metadata?.files as Array<{ patch: string }>
    expect(files[0]?.patch).toContain("--- /dev/null")
    expect(files[0]?.patch).toContain("+++ /workspace/added.txt")
    expect(files[1]?.patch).toContain("-before")
    expect(files[1]?.patch).toContain("+after")
    expect(permission?.metadata).toMatchObject({
      executor: "ssh",
      filepath: "/workspace/added.txt, /workspace/existing.txt",
      files: result.metadata?.files,
    })
  })

  it("keeps add intent in the computed diff and creates only a missing path", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/existing.txt", "anchor\n")
    const fixture = await createEngine(pool)
    let permission: Parameters<ToolContext["ask"]>[0] | undefined

    await createPatchTool(
      config(fixture.mapper.mirrorBase),
      fixture.mapper,
      fixture.engine,
      fixture.resolver
    ).execute(
      {
        patchText: [
          "*** Begin Patch",
          "*** Add File: added.txt",
          "+first",
          "+second",
          "*** End Patch",
        ].join("\n"),
      },
      toolContext(async (input) => {
        permission = input
      })
    )

    expect(permission?.metadata.diff).toContain("--- /dev/null")
    expect(permission?.metadata.diff).toContain("+++ /workspace/added.txt")
    expect(permission?.metadata.diff).toContain("+first")
    expect(permission?.metadata.diff).toContain("+second")
    expect(await pool.readRemote("/workspace/added.txt")).toBe("first\nsecond")
  })

  it("pulls sorted paths and asks with every computed diff before writing mirrors", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/z.txt", "z before\n")
    await pool.writeRemote("/workspace/a.txt", "a before\n")
    const fixture = await createEngine(pool)
    let permission: Parameters<ToolContext["ask"]>[0] | undefined
    let downloadsAtPermission: string[] = []
    const patchText = [
      "*** Begin Patch",
      "*** Update File: z.txt",
      "@@",
      "-z before",
      "+z after",
      "*** Update File: a.txt",
      "@@",
      "-a before",
      "+a after",
      "*** End Patch",
    ].join("\n")

    await createPatchTool(
      config(fixture.mapper.mirrorBase),
      fixture.mapper,
      fixture.engine,
      fixture.resolver
    ).execute(
      { patchText },
      toolContext(async (input) => {
        permission = input
        downloadsAtPermission = [...pool.downloads]
        expect(await readFile(fixture.mapper.toLocal("/workspace/a.txt"), "utf8")).toBe(
          "a before\n"
        )
        expect(await readFile(fixture.mapper.toLocal("/workspace/z.txt"), "utf8")).toBe(
          "z before\n"
        )
      })
    )

    expect(downloadsAtPermission).toEqual(["/workspace/a.txt", "/workspace/z.txt"])
    expect(permission?.metadata.diff).toContain("--- /workspace/a.txt")
    expect(permission?.metadata.diff).toContain("-a before")
    expect(permission?.metadata.diff).toContain("+a after")
    expect(permission?.metadata.diff).toContain("-z before")
    expect(permission?.metadata.diff).toContain("+z after")
    expect(permission?.metadata.diff).not.toContain("*** Begin Patch")
    expect(await pool.readRemote("/workspace/a.txt")).toBe("a after\n")
    expect(await pool.readRemote("/workspace/z.txt")).toBe("z after\n")
  })

  it("rejects add-existing and update-missing plans before edit permission", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/existing.txt", "keep\n")
    const fixture = await createEngine(pool)
    let editPermissions = 0
    const ctx = toolContext(async (input) => {
      if (input.permission === "edit") editPermissions++
    })
    const tool = createPatchTool(
      config(fixture.mapper.mirrorBase),
      fixture.mapper,
      fixture.engine,
      fixture.resolver
    )

    await expect(
      tool.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Add File: existing.txt",
            "+replacement",
            "*** End Patch",
          ].join("\n"),
        },
        ctx
      )
    ).rejects.toThrow(/already exists/)
    await expect(
      tool.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: missing.txt",
            "@@",
            "-before",
            "+after",
            "*** End Patch",
          ].join("\n"),
        },
        ctx
      )
    ).rejects.toThrow(/update missing file/)

    expect(editPermissions).toBe(0)
    expect(await pool.readRemote("/workspace/existing.txt")).toBe("keep\n")
    await expect(pool.statRemote("/workspace/missing.txt")).rejects.toThrow()
  })

  it("rejects delete and move plans before any remote access", async () => {
    const pool = await createRemotePool()
    const fixture = await createEngine(pool)
    const tool = createPatchTool(
      config(fixture.mapper.mirrorBase),
      fixture.mapper,
      fixture.engine,
      fixture.resolver
    )

    await expect(
      tool.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Delete File: old.txt",
            "*** End Patch",
          ].join("\n"),
        },
        toolContext()
      )
    ).rejects.toThrow(/deletion is disabled/)
    expect(pool.commands).toEqual([])

    await expect(
      tool.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: old.txt",
            "*** Move to: new.txt",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
        },
        toolContext()
      )
    ).rejects.toThrow(/move is disabled/)
    expect(pool.commands).toEqual([])
  })
})

describe("SftpClient cancellation", () => {
  it("uses a finite default and reports a timed-out download without retrying", async () => {
    expect(DEFAULT_SFTP_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_SFTP_TIMEOUT_MS)).toBe(true)
    const fixture = await createSftpFixture({ FAKE_SFTP_DELAY_MS: "1000" })
    const client = fixture.client({ timeout: 500, killGraceMs: 20 })

    const download = client.download("/remote/file", path.join(fixture.directory, "download"))
    await waitForFile(fixture.logPath)
    const error = await download.catch((value: unknown) => value)

    expect(error).toMatchObject({
      name: "TimeoutError",
      operation: "download",
      result: { termination: "timeout" },
    })
    expect(await countLogLines(fixture.logPath)).toBe(1)
  })

  it("honors AbortSignal during upload without retrying", async () => {
    const fixture = await createSftpFixture({ FAKE_SFTP_DELAY_MS: "1000" })
    const localPath = path.join(fixture.directory, "upload")
    await writeFile(localPath, "content")
    const controller = new AbortController()
    const upload = fixture
      .client({ timeout: 5_000, killGraceMs: 20 })
      .upload(localPath, "/remote/file", { signal: controller.signal })
    await waitForFile(fixture.logPath)
    controller.abort(new Error("test abort"))

    const error = await upload.catch((value: unknown) => value)
    expect(error).toMatchObject({
      name: "AbortError",
      operation: "upload",
      result: { termination: "abort" },
    })
    expect(await countLogLines(fixture.logPath)).toBe(1)
  })

  it("converts only a proven remote missing diagnostic to typed ENOENT", async () => {
    const fixture = await createSftpFixture({
      FAKE_SFTP_EXIT_CODE: "1",
      FAKE_SFTP_STDERR: "remote open(\"/remote/missing\"): No such file or directory\n",
    })

    const error = await fixture
      .client()
      .download("/remote/missing", path.join(fixture.directory, "download"))
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(SftpFileNotFoundError)
    expect(error).toMatchObject({ code: "ENOENT", operation: "download" })
  })
})

class FakeRemotePool implements SSHPool {
  readonly downloads: string[] = []
  readonly uploads: string[] = []
  readonly commands: string[] = []
  failNextUpload = false
  nextDownloadError: Error | undefined
  beforeNextUpload: (() => Promise<void>) | undefined
  afterNextUpload: (() => Promise<void>) | undefined

  constructor(private readonly root: string) {}

  async download(
    remotePath: string,
    localPath: string,
    options: SftpTransferOptions = {}
  ): Promise<void> {
    throwIfAborted(options.signal)
    this.downloads.push(remotePath)
    if (this.nextDownloadError) {
      const error = this.nextDownloadError
      this.nextDownloadError = undefined
      throw error
    }
    try {
      await copyFile(this.localRemotePath(remotePath), localPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SftpFileNotFoundError(
          `Remote file not found: ${remotePath}`,
          "filesystem-fake"
        )
      }
      throw error
    }
  }

  async upload(
    localPath: string,
    remotePath: string,
    options: SftpTransferOptions = {}
  ): Promise<void> {
    throwIfAborted(options.signal)
    this.uploads.push(remotePath)
    const destination = this.localRemotePath(remotePath)
    await mkdir(path.dirname(destination), { recursive: true })
    if (this.beforeNextUpload) {
      const beforeUpload = this.beforeNextUpload
      this.beforeNextUpload = undefined
      await beforeUpload()
    }
    if (this.failNextUpload) {
      this.failNextUpload = false
      await writeFile(destination, "partial upload")
      throw new Error("injected upload failure")
    }
    await copyFile(localPath, destination)
    if (this.afterNextUpload) {
      const afterUpload = this.afterNextUpload
      this.afterNextUpload = undefined
      await afterUpload()
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<RemoteCommandResult> {
    throwIfAborted(options.signal)
    this.commands.push(command)

    const realpathMatch = command.match(/^realpath -e -- (\S+)$/)
    if (realpathMatch) {
      try {
        const resolved = await realpath(this.localRemotePath(realpathMatch[1]))
        const relative = path.relative(this.root, resolved)
        if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
          throw new Error(`Fake remote realpath escaped its root: ${resolved}`)
        }
        return commandResult(`/${relative.split(path.sep).filter(Boolean).join("/")}\n`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return commandResult("", "realpath: No such file or directory\n", 1)
        }
        throw error
      }
    }

    const typeMatch = command.match(
      /^if \[ -d (\S+) \]; then echo "DIR"; elif \[ -f \S+ \]; then echo "FILE"; else echo "MISSING"; fi$/
    )
    if (typeMatch) {
      try {
        const info = await stat(this.localRemotePath(typeMatch[1]))
        return commandResult(info.isDirectory() ? "DIR\n" : "FILE\n")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return commandResult("MISSING\n")
        throw error
      }
    }

    if (/^file -b \S+ 2>\/dev\/null \|\| echo "UNKNOWN"$/.test(command)) {
      return commandResult("ASCII text\n")
    }

    if (command.startsWith("dd bs=4096 count=1 if=")) {
      return commandResult("NO_NULL\n")
    }

    const statMatch = command.match(/^stat -c %a (\S+) 2>\/dev\/null$/)
    if (statMatch) {
      try {
        const info = await stat(this.localRemotePath(statMatch[1]))
        return commandResult(`${(info.mode & 0o7777).toString(8)}\n`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return commandResult("", "", 1)
        throw error
      }
    }

    const mkdirMatch = command.match(/^mkdir -p (\S+)$/)
    if (mkdirMatch) {
      await mkdir(this.localRemotePath(mkdirMatch[1]), { recursive: true })
      return commandResult()
    }

    const lockMkdirMatch = command.match(/^mkdir (\S+)$/)
    if (lockMkdirMatch) {
      try {
        await mkdir(this.localRemotePath(lockMkdirMatch[1]))
        return commandResult()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return commandResult("", `mkdir: ${code ?? "failed"}\n`, 1)
      }
    }

    const rmdirMatch = command.match(/^rmdir (\S+)$/)
    if (rmdirMatch) {
      try {
        await rmdir(this.localRemotePath(rmdirMatch[1]))
        return commandResult()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return commandResult("", `rmdir: ${code ?? "failed"}\n`, 1)
      }
    }

    const chmodMatch = command.match(/^chmod ([0-7]{3,4}) (\S+)$/)
    if (chmodMatch) {
      await chmod(this.localRemotePath(chmodMatch[2]), Number.parseInt(chmodMatch[1], 8))
      return commandResult()
    }

    const moveMatch = command.match(/^mv -f (\S+) (\S+)$/)
    if (moveMatch) {
      await rename(this.localRemotePath(moveMatch[1]), this.localRemotePath(moveMatch[2]))
      return commandResult()
    }

    const removeMatch = command.match(/^rm -f (\S+)$/)
    if (removeMatch) {
      await unlink(this.localRemotePath(removeMatch[1])).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      return commandResult()
    }

    throw new Error(`Unsupported fake remote command: ${command}`)
  }

  async close(): Promise<void> {}

  async writeRemote(remotePath: string, content: string | Uint8Array, mode?: number): Promise<void> {
    const localPath = this.localRemotePath(remotePath)
    await mkdir(path.dirname(localPath), { recursive: true })
    await writeFile(localPath, content)
    if (mode !== undefined) await chmod(localPath, mode)
  }

  readRemote(remotePath: string): Promise<string> {
    return readFile(this.localRemotePath(remotePath), "utf8")
  }

  statRemote(remotePath: string) {
    return stat(this.localRemotePath(remotePath))
  }

  listRemote(remotePath: string): Promise<string[]> {
    return readdir(this.localRemotePath(remotePath)).then((entries) => entries.sort())
  }

  private localRemotePath(remotePath: string): string {
    if (!path.posix.isAbsolute(remotePath)) throw new Error(`Remote path is not absolute: ${remotePath}`)
    return path.join(this.root, ...remotePath.split("/").filter(Boolean))
  }
}

async function createRemotePool(): Promise<FakeRemotePool> {
  const root = await trackedTempDirectory("sync-remote-")
  return new FakeRemotePool(root)
}

async function createEngine(pool: SSHPool): Promise<{
  engine: SyncEngine
  mapper: PathMapper
  resolver: RemotePathResolver
}> {
  const mirrorRoot = await trackedTempDirectory("sync-mirror-")
  const remoteConfig = config(mirrorRoot)
  const mapper = new PathMapper(remoteConfig)
  const manifest = new ManifestManager(mapper)
  return {
    engine: new SyncEngine(remoteConfig, mapper, manifest, pool),
    mapper,
    resolver: new RemotePathResolver(remoteConfig.remoteWorkdir, pool),
  }
}

function config(mirrorRoot: string): RemoteConfig {
  return {
    alias: "fixture-host",
    remoteWorkdir: "/workspace",
    controlSocket: "/tmp/opencode-ssh/runtime/control.sock",
    targetID: "a".repeat(64),
    launchID: "sync-engine-test",
    readyPath: "/tmp/opencode-ssh/state/ready.json",
    readyNonce: "fixture-ready-nonce-0123456789abcdef",
    runtimeDir: "/tmp/opencode-ssh/runtime",
    mirrorRoot,
    sshBinary: "ssh",
    sftpBinary: "sftp",
    active: true,
  }
}

function toolContext(ask: ToolContext["ask"] = async () => {}): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: new AbortController().signal,
    metadata: () => {},
    ask,
  }
}

function commandResult(
  stdout = "",
  stderr = "",
  exitCode = 0
): RemoteCommandResult {
  return {
    stdout,
    stderr,
    exitCode,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("aborted")
  error.name = "AbortError"
  throw error
}

function remoteLockPath(remotePath: string): string {
  const hash = createHash("sha256").update(remotePath, "utf8").digest("hex")
  return path.posix.join(path.posix.dirname(remotePath), `.opencode-lock-${hash}`)
}

interface SftpFixture {
  directory: string
  logPath: string
  client(options?: SftpClientOptions): SftpClient
}

async function createSftpFixture(extraEnv: NodeJS.ProcessEnv): Promise<SftpFixture> {
  const directory = await trackedTempDirectory("sync-sftp-")
  const logPath = path.join(directory, "sftp.jsonl")
  return {
    directory,
    logPath,
    client: (options = {}) =>
      new SftpClient("fixture-host", path.join(directory, "control.sock"), {
        ...options,
        sftpBinary: fakeSftp,
        env: {
          ...process.env,
          ...extraEnv,
          FAKE_SFTP_LOG: logPath,
        },
      }),
  }
}

async function trackedTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await stat(filePath).then(() => true, () => false)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

async function countLogLines(logPath: string): Promise<number> {
  return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).length
}
