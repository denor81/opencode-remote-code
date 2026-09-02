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
  symlink,
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
  RemoteFileSizeLimitError,
  SyncEngine,
  type SyncTransaction,
} from "../../src/sync-engine.js"
import { createReadTool } from "../../src/tools/read.js"
import { createEditTool } from "../../src/tools/edit.js"
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
  it("rejects an aborted queued transaction promptly without admitting it or a successor", async () => {
    const pool = await createRemotePool()
    const fixture = await createEngine(pool)
    const activeEntered = deferred()
    const releaseActive = deferred()
    const successorEntered = deferred()
    const order: string[] = []
    const active = fixture.engine.transaction(async () => {
      order.push("active")
      activeEntered.resolve()
      await releaseActive.promise
    })
    await activeEntered.promise

    const controller = new AbortController()
    const canceled = fixture.engine.transaction(async () => {
      order.push("canceled")
      await mkdir(path.dirname(fixture.mapper.toLocal("/workspace/should-not-exist.txt")), {
        recursive: true,
      })
      await writeFile(
        fixture.mapper.toLocal("/workspace/should-not-exist.txt"),
        "unexpected local side effect\n"
      )
      await pool.exec("mkdir -p /workspace/should-not-exist")
    }, controller.signal)
    const successor = fixture.engine.transaction(async () => {
      order.push("successor")
      successorEntered.resolve()
    })

    controller.abort()
    const promptResult = await Promise.race([
      canceled.then(
        () => "resolved",
        (error: unknown) => (error as Error).name
      ),
      delay(100).then(() => "timed out"),
    ])

    expect(promptResult).toBe("AbortError")
    expect(order).toEqual(["active"])
    expect(pool.commands).toEqual([])
    await expect(stat(fixture.mapper.toLocal("/workspace/should-not-exist.txt"))).rejects.toThrow()

    releaseActive.resolve()
    await active
    await successorEntered.promise
    await successor
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" })
    expect(order).toEqual(["active", "successor"])
  })

  it("passes each file tool AbortSignal into transaction admission", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/tool-signal.txt", "before\n")
    const fixture = await createEngine(pool)
    const controller = new AbortController()
    const ctx = toolContext(async () => {}, "signal-session", controller.signal)
    const observed: Array<AbortSignal | undefined> = []
    const stop = new Error("stop at transaction admission")
    fixture.engine.transaction = (async (
      _operation: (transaction: SyncTransaction) => Promise<unknown>,
      signal?: AbortSignal
    ) => {
      observed.push(signal)
      throw stop
    }) as typeof fixture.engine.transaction

    const calls = [
      () =>
        createReadTool(fixture.mapper, fixture.engine, pool, fixture.resolver).execute(
          { filePath: "/workspace/tool-signal.txt" },
          ctx
        ),
      () =>
        createWriteTool(fixture.mapper, fixture.engine, fixture.resolver).execute(
          { filePath: "/workspace/tool-signal.txt", content: "after\n" },
          ctx
        ),
      () =>
        createEditTool(fixture.mapper, fixture.engine, fixture.resolver).execute(
          { filePath: "/workspace/tool-signal.txt", oldString: "before", newString: "after" },
          ctx
        ),
      () =>
        createPatchTool(
          config(fixture.mapper.mirrorBase),
          fixture.mapper,
          fixture.engine,
          fixture.resolver
        ).execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Update File: tool-signal.txt",
              "@@",
              "-before",
              "+after",
              "*** End Patch",
            ].join("\n"),
          },
          ctx
        ),
    ]

    for (const call of calls) {
      await expect(call()).rejects.toBe(stop)
    }
    expect(observed).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
    ])
  })

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
      "/workspace/b.txt",
    ])
    expect(pool.uploads).toHaveLength(1)
    expect(pool.uploads[0]).toMatch(/^\/workspace\/\.b\.txt\.opencode-[a-f0-9]+\.tmp$/)
    expect(pool.uploads[0]).not.toContain("a.txt")
    expect((await pool.statRemote("/workspace/b.txt")).mode & 0o777).toBe(0o640)
  })

  it("rejects a bounded pull before moving oversized content into the mirror", async () => {
    const remotePath = "/workspace/oversized.bin"
    const pool = await createRemotePool()
    await pool.writeRemote(remotePath, Buffer.alloc(17))
    const fixture = await createEngine(pool)

    await expect(
      fixture.engine.pull(remotePath, new AbortController().signal, 16)
    ).rejects.toMatchObject({
      code: "REMOTE_FILE_SIZE_LIMIT",
      remotePath,
      maxBytes: 16,
      actualBytes: 17,
    } satisfies Partial<RemoteFileSizeLimitError>)

    await expect(stat(fixture.mapper.toLocal(remotePath))).rejects.toThrow()
    expect(pool.downloads).toEqual([remotePath])
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

  it("rejects a missing component that becomes a symlink while waiting for admission", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/outside/anchor.txt", "outside anchor\n")
    const fixture = await createEngine(pool)
    const activeEntered = deferred()
    const releaseActive = deferred()
    const active = fixture.engine.transaction(async () => {
      activeEntered.resolve()
      await releaseActive.promise
    })
    await activeEntered.promise

    const write = createWriteTool(fixture.mapper, fixture.engine, fixture.resolver).execute(
      { filePath: "/workspace/new-parent/target.txt", content: "must not escape\n" },
      toolContext()
    )
    await waitForCommand(pool, "realpath -e -- /workspace")
    await pool.symlinkRemote("/workspace/new-parent", "/outside")
    const remoteActivityAtAdmission = {
      commands: pool.commands.length,
      downloads: pool.downloadAttempts.length,
      uploads: pool.uploads.length,
    }

    releaseActive.resolve()
    await active
    const error = await write.catch((value: unknown) => value)

    expect(error).toMatchObject({
      code: "REMOTE_PATH_CHANGED",
      expectedPath: "/workspace/new-parent/target.txt",
      actualPath: "/outside/target.txt",
    })
    expect(pool.downloadAttempts).toHaveLength(remoteActivityAtAdmission.downloads)
    expect(pool.uploads).toHaveLength(remoteActivityAtAdmission.uploads)
    expect(pool.commands.slice(remoteActivityAtAdmission.commands)).toEqual([
      "realpath -e -- /workspace/new-parent/target.txt",
      "realpath -e -- /workspace/new-parent",
    ])
    await expect(pool.statRemote("/outside/target.txt")).rejects.toThrow()
  })

  it("revalidates the original canonical intent again at final commit", async () => {
    const pool = await createRemotePool()
    await pool.writeRemote("/workspace/first/target.txt", "first baseline\n")
    await pool.writeRemote("/workspace/second/target.txt", "second baseline\n")
    await pool.symlinkRemote("/workspace/link", "/workspace/first")
    const fixture = await createEngine(pool)
    pool.afterNextUpload = async () => {
      await pool.replaceSymlinkRemote("/workspace/link", "/workspace/second")
    }

    const error = await createWriteTool(
      fixture.mapper,
      fixture.engine,
      fixture.resolver
    ).execute(
      { filePath: "/workspace/link/target.txt", content: "our replacement\n" },
      toolContext()
    ).catch((value: unknown) => value)

    expect(error).toMatchObject({
      code: "REMOTE_PATH_CHANGED",
      expectedPath: "/workspace/first/target.txt",
      actualPath: "/workspace/second/target.txt",
    })
    expect(await pool.readRemote("/workspace/first/target.txt")).toBe("first baseline\n")
    expect(await pool.readRemote("/workspace/second/target.txt")).toBe("second baseline\n")
    expect(pool.commands.filter((command) => command.startsWith("mv "))).toEqual([])
    expect(await pool.listRemote("/workspace/first")).toEqual(["target.txt"])
  })

  it("rejects a stale same-path writer from an independent engine", async () => {
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

  it("precreates the upload sibling with mode 0600 before SFTP writes it", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/private-temp.txt"
    await pool.writeRemote(remotePath, "before\n", 0o664)
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    let observedMode: number | undefined
    pool.beforeNextUpload = async () => {
      const remoteTemp = pool.uploads.at(-1)
      if (!remoteTemp) throw new Error("Expected a remote upload path")
      observedMode = (await pool.statRemote(remoteTemp)).mode & 0o777
    }

    await fixture.engine.push(remotePath)

    expect(observedMode).toBe(0o600)
    expect((await pool.statRemote(remotePath)).mode & 0o777).toBe(0o664)
  })

  it("does not delete an unconfirmed temp when creation transport throws before execution", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/temp-throw-before.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    pool.throwBeforeNextTempCreate = true
    pool.beforeNextTempCreate = (remoteTemp) =>
      pool.writeRemote(remoteTemp, "foreign before execution\n", 0o640)

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)
    const remoteTemp = pool.tempCreateAttempts[0]

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REMOTE_ARTIFACT_CLEANUP_FAILED",
          artifactPaths: [remoteTemp],
        }),
      ])
    )
    expect(flattenErrorMessages(error)).toContain("injected temp creation throw before execution")
    expect(flattenErrorMessages(error)).toContain(remoteTemp)
    expect(pool.commands).not.toContain(`rm -f -- ${remoteTemp}`)
    expect(await pool.readRemote(remoteTemp)).toBe("foreign before execution\n")
    expect((await pool.statRemote(remoteTemp)).mode & 0o777).toBe(0o640)
    expect(await pool.readRemote(remotePath)).toBe("before\n")
  })

  it("reports but does not delete an unconfirmed temp when creation transport throws after execution", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/temp-throw-after.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    pool.throwAfterNextTempCreate = true

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)
    const remoteTemp = pool.tempCreateAttempts[0]

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REMOTE_ARTIFACT_CLEANUP_FAILED",
          artifactPaths: [remoteTemp],
        }),
      ])
    )
    expect(flattenErrorMessages(error)).toContain("injected temp creation throw after execution")
    expect(flattenErrorMessages(error)).toContain(remoteTemp)
    expect(pool.commands).not.toContain(`rm -f -- ${remoteTemp}`)
    expect(await pool.readRemote(remoteTemp)).toBe("")
    expect((await pool.statRemote(remoteTemp)).mode & 0o777).toBe(0o600)
    expect(await pool.readRemote(remotePath)).toBe("before\n")
  })

  it("does not delete a foreign temp after a confirmed creation collision", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/temp-collision.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    pool.beforeNextTempCreate = (remoteTemp) =>
      pool.writeRemote(remoteTemp, "foreign temp\n", 0o640)

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)
    const remoteTemp = pool.tempCreateAttempts[0]

    expect(flattenErrorMessages(error)).toContain("create private remote sibling")
    expect(pool.commands).not.toContain(`rm -f -- ${remoteTemp}`)
    expect(await pool.readRemote(remoteTemp)).toBe("foreign temp\n")
    expect((await pool.statRemote(remoteTemp)).mode & 0o777).toBe(0o640)
    expect(await pool.readRemote(remotePath)).toBe("before\n")
  })

  it("uses the mode from final validation after a concurrent chmod", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/final-mode.txt"
    await pool.writeRemote(remotePath, "before\n", 0o640)
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    pool.afterNextUpload = () => pool.chmodRemote(remotePath, 0o600)

    await fixture.engine.push(remotePath)

    expect(await pool.readRemote(remotePath)).toBe("after\n")
    expect((await pool.statRemote(remotePath)).mode & 0o777).toBe(0o600)
  })

  it("uses no-target-directory replacement and rejects a destination directory", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/directory-target"
    await pool.mkdirRemote("/workspace")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "must remain a file operation\n")
    pool.beforeNextMove = () => pool.mkdirRemote(remotePath)

    await expect(fixture.engine.push(remotePath)).rejects.toThrow(
      /replace remote file|directory target/
    )

    expect((await pool.statRemote(remotePath)).isDirectory()).toBe(true)
    expect(await pool.listRemote(remotePath)).toEqual([])
    expect(pool.commands.some((command) => command.startsWith("mv -fT -- "))).toBe(true)
  })

  it("validates a stale baseline before recreating a removed parent", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/removed-parent/target.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    await pool.removeRemote("/workspace/removed-parent")

    await expect(fixture.engine.push(remotePath)).rejects.toBeInstanceOf(
      RemoteFileConflict
    )

    await expect(pool.statRemote("/workspace/removed-parent")).rejects.toThrow()
    expect(pool.uploads).toEqual([])
  })

  it("removes only newly created empty parents after a failed upload", async () => {
    const pool = await createRemotePool()
    await pool.mkdirRemote("/workspace")
    const remotePath = "/workspace/new/nested/target.txt"
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "new content\n")
    pool.failNextUpload = true

    await expect(fixture.engine.push(remotePath)).rejects.toThrow(
      /injected upload failure/
    )

    expect((await pool.statRemote("/workspace")).isDirectory()).toBe(true)
    await expect(pool.statRemote("/workspace/new")).rejects.toThrow()
    expect(pool.uploads).toHaveLength(1)
  })

  it("cleans its uploaded temp and lock when the child aborts before final validation", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/child-aborted/target.txt"
    const originalContent = "original destination\n"
    const replacementContent = "aborted replacement\n"
    await pool.writeRemote(remotePath, originalContent)
    pool.reportRemoteModes = false
    const fixture = await createEngine(pool)
    const controller = new AbortController()
    const lockPath = remoteLockPath(remotePath)
    let uploadedTemp = ""

    pool.afterNextUpload = async () => {
      const tempPath = pool.uploads.at(-1)
      if (!tempPath) throw new Error("Expected an uploaded sibling temporary")
      uploadedTemp = tempPath
      expect(await pool.readRemote(tempPath)).toBe(replacementContent)
      expect((await pool.statRemote(lockPath)).isDirectory()).toBe(true)
      expect(await pool.readRemote(remotePath)).toBe(originalContent)
      controller.abort(new Error("abort after upload"))
    }

    const write = createWriteTool(fixture.mapper, fixture.engine, fixture.resolver).execute(
      { filePath: remotePath, content: replacementContent },
      toolContext(async () => {}, "child-session-aborted", controller.signal)
    )

    await expect(write).rejects.toMatchObject({ name: "AbortError" })

    expect(controller.signal.aborted).toBe(true)
    expect(uploadedTemp).toMatch(
      /^\/workspace\/child-aborted\/\.target\.txt\.opencode-[a-f0-9]{24}\.tmp$/
    )
    expect(pool.uploads).toEqual([uploadedTemp])
    expect(pool.uploadRecords).toHaveLength(1)
    expect(pool.uploadRecords[0]?.content.toString("utf8")).toBe(replacementContent)
    expect(pool.downloadAttempts.filter((value) => value === remotePath)).toHaveLength(3)
    expect(pool.commands.filter((command) => command.startsWith("mv "))).toEqual([])
    expect(pool.commands.filter((command) => command === `rm -f -- ${uploadedTemp}`)).toHaveLength(1)
    expect(
      pool.commands.filter(
        (command) =>
          command.startsWith("if [ \"$(cat --") &&
          command.includes(`rmdir -- ${lockPath}`)
      )
    ).toHaveLength(1)
    expect(await pool.readRemote(remotePath)).toBe(originalContent)
    expect(await pool.listRemote("/workspace/child-aborted")).toEqual(["target.txt"])
    expect(await readFile(fixture.mapper.toLocal(remotePath), "utf8")).toBe(
      replacementContent
    )
    expect(await listLocalSyncArtifacts(fixture.mapper.mirrorBase)).toEqual([])
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
    expect(await pool.listRemote("/workspace")).toEqual(["one.txt", "two.txt"])
    expect(await listLocalSyncArtifacts(fixture.mapper.mirrorBase)).toEqual([])
  })

  it("reports committed and failed paths after a second-file upload failure without rollback", async () => {
    const pool = await createRemotePool()
    const firstPath = "/workspace/a-first.txt"
    const secondPath = "/workspace/b-second.txt"
    await pool.writeRemote(firstPath, "first before\n")
    await pool.writeRemote(secondPath, "second before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(firstPath)
    await fixture.engine.pull(secondPath)
    await writeFile(fixture.mapper.toLocal(firstPath), "first after\n")
    await writeFile(fixture.mapper.toLocal(secondPath), "second after\n")
    pool.failUploadNumber = 2

    const error = await fixture.engine
      .pushMany([secondPath, firstPath])
      .catch((value: unknown) => value)

    expect(error).toMatchObject({
      name: "SyncPartialCommitError",
      code: "SYNC_PARTIAL_COMMIT",
      committedPaths: [firstPath],
      failedPaths: [secondPath],
      uncertainPaths: [],
      unattemptedPaths: [],
    })
    expect(flattenErrorMessages(error)).toContain("injected upload failure")
    expect(await pool.readRemote(firstPath)).toBe("first after\n")
    expect(await pool.readRemote(secondPath)).toBe("second before\n")
    expect(pool.uploads).toHaveLength(2)
  })

  it("reports an uncertain second path when rename transport fails after dispatch", async () => {
    const pool = await createRemotePool()
    const firstPath = "/workspace/a-certain.txt"
    const secondPath = "/workspace/b-uncertain.txt"
    await pool.writeRemote(firstPath, "first before\n")
    await pool.writeRemote(secondPath, "second before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(firstPath)
    await fixture.engine.pull(secondPath)
    await writeFile(fixture.mapper.toLocal(firstPath), "first after\n")
    await writeFile(fixture.mapper.toLocal(secondPath), "second after\n")
    pool.throwAfterMoveNumber = 2

    const error = await fixture.engine
      .pushMany([secondPath, firstPath])
      .catch((value: unknown) => value)

    expect(error).toMatchObject({
      name: "SyncPartialCommitError",
      code: "SYNC_PARTIAL_COMMIT",
      committedPaths: [firstPath],
      failedPaths: [],
      uncertainPaths: [secondPath],
      unattemptedPaths: [],
    })
    expect(flattenErrorMessages(error)).toContain("injected uncertain rename")
    expect(await pool.readRemote(firstPath)).toBe("first after\n")
    expect(await pool.readRemote(secondPath)).toBe("second after\n")
    expect(pool.moveCount).toBe(2)
  })

  it("serializes distinct child writes through one shared operation boundary", async () => {
    const pool = await createRemotePool()
    const firstPath = "/workspace/child-alpha/first.txt"
    const secondPath = "/workspace/child-beta/second.txt"
    const firstContent = "alpha child only\n"
    const secondContent = "beta child only\n"
    await pool.writeRemote(firstPath, "alpha before\n")
    await pool.writeRemote(secondPath, "beta before\n")
    const fixture = await createEngine(pool)
    const firstMayFinish = deferred()
    const firstOwnsTransaction = deferred()
    const secondTransactionRequested = deferred()
    const originalTransaction = fixture.engine.transaction.bind(fixture.engine)
    let transactionRequests = 0
    let secondEnteredTransaction = false
    fixture.engine.transaction = <T>(
      operation: (transaction: SyncTransaction) => Promise<T>,
      signal?: AbortSignal,
      mutationPaths = []
    ): Promise<T> => {
      const requestNumber = ++transactionRequests
      if (requestNumber === 2) secondTransactionRequested.resolve()
      return originalTransaction(async (transaction) => {
        if (requestNumber === 2) secondEnteredTransaction = true
        return operation(transaction)
      }, signal, mutationPaths)
    }

    const permissionScopes: Array<{ sessionID: string; remotePath: unknown }> = []
    const firstContext = toolContext(async (input) => {
      permissionScopes.push({
        sessionID: "child-session-alpha",
        remotePath: input.metadata.remotePath,
      })
      firstOwnsTransaction.resolve()
      await firstMayFinish.promise
    }, "child-session-alpha")
    const secondContext = toolContext(async (input) => {
      permissionScopes.push({
        sessionID: "child-session-beta",
        remotePath: input.metadata.remotePath,
      })
    }, "child-session-beta")
    const writeTool = createWriteTool(fixture.mapper, fixture.engine, fixture.resolver)

    const first = writeTool.execute(
      { filePath: firstPath, content: firstContent },
      firstContext
    )
    await firstOwnsTransaction.promise

    const second = writeTool.execute(
      { filePath: secondPath, content: secondContent },
      secondContext
    )
    await secondTransactionRequested.promise

    expect(firstContext.sessionID).not.toBe(secondContext.sessionID)
    expect(transactionRequests).toBe(2)
    expect(secondEnteredTransaction).toBe(false)
    expect(pool.downloads).toEqual([firstPath])
    expect(pool.uploads).toEqual([])
    await expect(stat(fixture.mapper.toLocal(secondPath))).rejects.toThrow()

    firstMayFinish.resolve()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)

    expect(secondEnteredTransaction).toBe(true)
    expect(permissionScopes).toEqual([
      { sessionID: "child-session-alpha", remotePath: firstPath },
      { sessionID: "child-session-beta", remotePath: secondPath },
    ])
    expect(await pool.readRemote(firstPath)).toBe(firstContent)
    expect(await pool.readRemote(secondPath)).toBe(secondContent)
    expect(pool.uploadRecords).toHaveLength(2)
    expect(pool.uploadRecords[0]?.remotePath).toMatch(
      /^\/workspace\/child-alpha\/\.first\.txt\.opencode-[a-f0-9]{24}\.tmp$/
    )
    expect(pool.uploadRecords[0]?.content.toString("utf8")).toBe(firstContent)
    expect(pool.uploadRecords[1]?.remotePath).toMatch(
      /^\/workspace\/child-beta\/\.second\.txt\.opencode-[a-f0-9]{24}\.tmp$/
    )
    expect(pool.uploadRecords[1]?.content.toString("utf8")).toBe(secondContent)

    const savedManifest = JSON.parse(
      await readFile(fixture.mapper.manifestPath(), "utf8")
    ) as { remote_root: string; files: Record<string, string> }
    expect(savedManifest).toEqual({
      remote_root: "/workspace",
      files: {
        [firstPath]: "workspace/child-alpha/first.txt",
        [secondPath]: "workspace/child-beta/second.txt",
      },
    })

    const uploadCount = pool.uploads.length
    await expect(fixture.engine.pushMany([secondPath, firstPath])).resolves.toBeUndefined()
    expect(pool.uploads).toHaveLength(uploadCount)
    expect(await listLocalSyncArtifacts(fixture.mapper.mirrorBase)).toEqual([])
    expect(await pool.listRemote("/workspace/child-alpha")).toEqual(["first.txt"])
    expect(await pool.listRemote("/workspace/child-beta")).toEqual(["second.txt"])
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
    await pool.writeRemote(`${lockPath}/owner`, "unknown-owner", 0o600)
    pool.commands.length = 0
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
    expect(await pool.readRemote(`${lockPath}/owner`)).toBe("unknown-owner")
    expect((await pool.statRemote(lockPath)).isDirectory()).toBe(true)
    expect(pool.commands.some((command) => command.includes("cat --"))).toBe(false)
    expect(await pool.listRemote("/workspace")).toEqual(
      [path.posix.basename(lockPath), "locked.txt"].sort()
    )
    expect(await listLocalSyncArtifacts(fixture.mapper.mirrorBase)).toEqual([])
  })

  it("stores a private cryptographic owner token in every acquired lock", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/owned-lock.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    const lockPath = remoteLockPath(remotePath)
    let ownerToken = ""
    pool.beforeNextUpload = async () => {
      ownerToken = await pool.readRemote(`${lockPath}/owner`)
      expect((await pool.statRemote(`${lockPath}/owner`)).mode & 0o777).toBe(0o600)
    }

    await fixture.engine.push(remotePath)

    expect(ownerToken).toMatch(/^[a-f0-9]{64}$/)
    await expect(pool.statRemote(lockPath)).rejects.toThrow()
  })

  it("conditionally removes only its token after an uncertain lock acquisition", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/uncertain-lock.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    const lockPath = remoteLockPath(remotePath)
    pool.throwAfterNextLockOwnerWrite = true

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)

    expect(String(error)).toContain("injected uncertain lock acquisition")
    expect(pool.commands.some((command) => command.includes("cat --") && command.includes(lockPath))).toBe(true)
    await expect(pool.statRemote(lockPath)).rejects.toThrow()
    expect(pool.uploads).toEqual([])
  })

  it("self-cleans an empty lock after a returned owner-write failure", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/owner-write-cleaned.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    const lockPath = remoteLockPath(remotePath)
    pool.nextLockOwnerWriteFailureCleanup = "succeed"

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(RemoteFileLockError)
    expect(error).not.toBeInstanceOf(AggregateError)
    expect(flattenErrorMessages(error)).toContain("injected lock owner write failure")
    await expect(pool.statRemote(lockPath)).rejects.toThrow()
    expect(pool.commands.some((command) => command.includes("cat --"))).toBe(false)
    expect(pool.uploads).toEqual([])
  })

  it("reports an owned lock artifact when owner-write self-clean fails", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/owner-write-cleanup-failed.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    const lockPath = remoteLockPath(remotePath)
    pool.nextLockOwnerWriteFailureCleanup = "fail"

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REMOTE_ARTIFACT_CLEANUP_FAILED",
          artifactPaths: [lockPath],
        }),
      ])
    )
    expect(flattenErrorMessages(error)).toContain("injected lock owner write failure")
    expect(flattenErrorMessages(error)).toContain(lockPath)
    expect((await pool.statRemote(lockPath)).isDirectory()).toBe(true)
    expect(pool.commands.some((command) => command.includes("cat --"))).toBe(false)
    expect(pool.uploads).toEqual([])
  })

  it("reports unresolved ownership when lock transport throws before owner write", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/lock-throw-before-owner.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    const lockPath = remoteLockPath(remotePath)
    pool.throwBeforeNextLockOwnerWrite = true

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REMOTE_ARTIFACT_CLEANUP_FAILED",
          artifactPaths: [lockPath],
        }),
      ])
    )
    expect(flattenErrorMessages(error)).toContain("injected lock throw before owner write")
    expect(flattenErrorMessages(error)).toContain(lockPath)
    expect((await pool.statRemote(lockPath)).isDirectory()).toBe(true)
    await expect(pool.statRemote(`${lockPath}/owner`)).rejects.toThrow()
    expect(pool.commands.some((command) => command.includes("cat --"))).toBe(true)
    expect(pool.uploads).toEqual([])
  })

  it("never releases a replacement lock with another owner's token", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/replaced-lock.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    const lockPath = remoteLockPath(remotePath)
    const replacementToken = "b".repeat(64)
    pool.beforeNextLockRelease = async () => {
      await pool.removeRemote(lockPath)
      await pool.mkdirRemote(lockPath)
      await pool.writeRemote(`${lockPath}/owner`, replacementToken, 0o600)
    }

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)

    expect(String(error)).toContain(lockPath)
    expect(await pool.readRemote(`${lockPath}/owner`)).toBe(replacementToken)
    expect((await pool.statRemote(lockPath)).isDirectory()).toBe(true)
    expect(await pool.readRemote(remotePath)).toBe("after\n")
  })

  it("aggregates temp cleanup failure with the primary upload failure and artifact path", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/temp-cleanup.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    pool.failNextUpload = true
    pool.failNextTempCleanup = true

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)
    const remoteTemp = pool.uploads[0]

    expect(error).toBeInstanceOf(AggregateError)
    expect(flattenErrorMessages(error)).toContain("injected upload failure")
    expect(flattenErrorMessages(error)).toContain(remoteTemp)
    expect(await pool.readRemote(remoteTemp)).toBe("partial upload")
  })

  it("aggregates lock release failure with a primary mutation failure", async () => {
    const pool = await createRemotePool()
    const remotePath = "/workspace/lock-cleanup.txt"
    await pool.writeRemote(remotePath, "before\n")
    const fixture = await createEngine(pool)
    await fixture.engine.pull(remotePath)
    await writeFile(fixture.mapper.toLocal(remotePath), "after\n")
    pool.failNextUpload = true
    pool.failNextLockRelease = true
    const lockPath = remoteLockPath(remotePath)

    const error = await fixture.engine.push(remotePath).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    const messages = flattenErrorMessages(error)
    expect(messages).toContain("injected upload failure")
    expect(messages).toContain(lockPath)
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
    const lockCommands = pool.commands.filter((command) =>
      command.includes(".opencode-lock-")
    )
    expect(lockCommands).toHaveLength(4)
    expect(lockCommands[0]).toMatch(new RegExp(`^if mkdir -- ${escapeRegex(firstLock)} .*`))
    expect(lockCommands[1]).toMatch(new RegExp(`^if mkdir -- ${escapeRegex(secondLock)} .*`))
    expect(lockCommands[2]).toContain(`rmdir -- ${secondLock}`)
    expect(lockCommands[3]).toContain(`rmdir -- ${firstLock}`)
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
    expect((await pool.statRemote("/workspace/added.txt")).mode & 0o777).toBe(0o600)
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
  readonly downloadAttempts: string[] = []
  readonly downloads: string[] = []
  readonly uploads: string[] = []
  readonly uploadRecords: Array<{ remotePath: string; content: Buffer }> = []
  readonly commands: string[] = []
  readonly tempCreateAttempts: string[] = []
  failNextUpload = false
  failUploadNumber: number | undefined
  failNextTempCleanup = false
  failNextLockRelease = false
  throwBeforeNextTempCreate = false
  throwAfterNextTempCreate = false
  beforeNextTempCreate: ((remoteTemp: string) => Promise<void>) | undefined
  nextLockOwnerWriteFailureCleanup: "succeed" | "fail" | undefined
  throwBeforeNextLockOwnerWrite = false
  throwAfterNextLockOwnerWrite = false
  throwAfterMoveNumber: number | undefined
  moveCount = 0
  reportRemoteModes = true
  nextDownloadError: Error | undefined
  beforeNextUpload: (() => Promise<void>) | undefined
  afterNextUpload: (() => Promise<void>) | undefined
  beforeNextMove: (() => Promise<void>) | undefined
  beforeNextLockRelease: (() => Promise<void>) | undefined

  constructor(private readonly root: string) {}

  async download(
    remotePath: string,
    localPath: string,
    options: SftpTransferOptions = {}
  ): Promise<void> {
    this.downloadAttempts.push(remotePath)
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
    this.uploadRecords.push({ remotePath, content: await readFile(localPath) })
    const destination = this.localRemotePath(remotePath)
    if (this.beforeNextUpload) {
      const beforeUpload = this.beforeNextUpload
      this.beforeNextUpload = undefined
      await beforeUpload()
    }
    if (this.failNextUpload || this.uploads.length === this.failUploadNumber) {
      this.failNextUpload = false
      await writeFile(destination, "partial upload")
      throw new Error("injected upload failure")
    }
    const destinationExists = await stat(destination).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      }
    )
    if (destinationExists) {
      await writeFile(destination, await readFile(localPath))
    } else {
      await copyFile(localPath, destination)
    }
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

    const imageProbeMatch = command.match(
      /^size=\$\(stat -c %s -- (\S+)\) \|\| exit \$\?; printf '%s\\n' "\$size"; dd bs=12 count=1 if=\1 2>\/dev\/null \| od -An -v -tx1 2>\/dev\/null \|\| :$/
    )
    if (imageProbeMatch) {
      try {
        const content = await readFile(this.localRemotePath(imageProbeMatch[1]))
        const octets = Array.from(content.subarray(0, 12), (byte) =>
          byte.toString(16).padStart(2, "0")
        )
        return commandResult(`${content.byteLength}\n${octets.join(" ")}\n`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return commandResult("", "stat: No such file or directory\n", 1)
        }
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
      if (!this.reportRemoteModes) return commandResult("", "", 1)
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

    const trackedMkdirMatch = command.match(
      /^if mkdir -- (\S+) 2>\/dev\/null; then printf CREATED; elif \[ -d \1 \]; then printf EXISTS; else exit 1; fi$/
    )
    if (trackedMkdirMatch) {
      try {
        await mkdir(this.localRemotePath(trackedMkdirMatch[1]))
        return commandResult("CREATED")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EEXIST") {
          const info = await stat(this.localRemotePath(trackedMkdirMatch[1])).catch(() => undefined)
          if (info?.isDirectory()) return commandResult("EXISTS")
        }
        return commandResult("", `mkdir: ${code ?? "failed"}\n`, 1)
      }
    }

    const lockAcquireMatch = command.match(
      /^if mkdir -- (\S+) 2>\/dev\/null; then if \(umask 077; set -C; printf %s ([a-f0-9]{64}) > (\S+)\); then exit 0; fi; if rmdir -- \1 2>\/dev\/null; then exit 76; else exit 77; fi; elif \[ -e \1 \]; then exit 75; else exit 78; fi$/
    )
    if (lockAcquireMatch) {
      const [, lockPath, token, ownerPath] = lockAcquireMatch
      try {
        await mkdir(this.localRemotePath(lockPath))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return commandResult(
          "",
          code === "EEXIST" ? "lock path already exists\n" : `mkdir: ${code ?? "failed"}\n`,
          code === "EEXIST" ? 75 : 78
        )
      }
      if (this.throwBeforeNextLockOwnerWrite) {
        this.throwBeforeNextLockOwnerWrite = false
        throw new Error("injected lock throw before owner write")
      }
      if (this.nextLockOwnerWriteFailureCleanup) {
        const cleanup = this.nextLockOwnerWriteFailureCleanup
        this.nextLockOwnerWriteFailureCleanup = undefined
        if (cleanup === "fail") {
          await writeFile(this.localRemotePath(ownerPath), "partial", {
            flag: "wx",
            mode: 0o600,
          })
        }
        try {
          await rmdir(this.localRemotePath(lockPath))
          return commandResult("", "injected lock owner write failure\n", 76)
        } catch {
          return commandResult("", "injected lock owner write failure\n", 77)
        }
      }
      await writeFile(this.localRemotePath(ownerPath), token, { flag: "wx", mode: 0o600 })
      if (this.throwAfterNextLockOwnerWrite) {
        this.throwAfterNextLockOwnerWrite = false
        throw new Error("injected uncertain lock acquisition after owner write")
      }
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

    const lockReleaseMatch = command.match(
      /^if \[ "\$\(cat -- (\S+) 2>\/dev\/null\)" = ([a-f0-9]{64}) \]; then rm -f -- \1 && rmdir -- (\S+); else exit 73; fi$/
    )
    if (lockReleaseMatch) {
      const [, ownerPath, token, lockPath] = lockReleaseMatch
      if (this.beforeNextLockRelease) {
        const beforeRelease = this.beforeNextLockRelease
        this.beforeNextLockRelease = undefined
        await beforeRelease()
      }
      if (this.failNextLockRelease) {
        this.failNextLockRelease = false
        return commandResult("", "injected lock release failure\n", 1)
      }
      const actual = await readFile(this.localRemotePath(ownerPath), "utf8").catch(() => "")
      if (actual !== token) return commandResult("", "lock owner token mismatch\n", 73)
      await unlink(this.localRemotePath(ownerPath))
      try {
        await rmdir(this.localRemotePath(lockPath))
        return commandResult()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return commandResult("", `rmdir: ${code ?? "failed"}\n`, 1)
      }
    }

    const rmdirMatch = command.match(/^rmdir(?: --)? (\S+)$/)
    if (rmdirMatch) {
      if (this.beforeNextLockRelease && rmdirMatch[1].includes(".opencode-lock-")) {
        const beforeRelease = this.beforeNextLockRelease
        this.beforeNextLockRelease = undefined
        await beforeRelease()
      }
      if (this.failNextLockRelease && rmdirMatch[1].includes(".opencode-lock-")) {
        this.failNextLockRelease = false
        return commandResult("", "injected lock release failure\n", 1)
      }
      try {
        await rmdir(this.localRemotePath(rmdirMatch[1]))
        return commandResult()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return commandResult("", `rmdir: ${code ?? "failed"}\n`, 1)
      }
    }

    const privateTempMatch = command.match(
      /^if \(umask 077; set -C; : > (\S+)\); then if chmod 600 -- \1; then exit 0; else exit 79; fi; else exit 74; fi$/
    )
    if (privateTempMatch) {
      const remoteTemp = privateTempMatch[1]
      this.tempCreateAttempts.push(remoteTemp)
      if (this.beforeNextTempCreate) {
        const beforeCreate = this.beforeNextTempCreate
        this.beforeNextTempCreate = undefined
        await beforeCreate(remoteTemp)
      }
      if (this.throwBeforeNextTempCreate) {
        this.throwBeforeNextTempCreate = false
        throw new Error("injected temp creation throw before execution")
      }
      try {
        await writeFile(this.localRemotePath(remoteTemp), "", {
          flag: "wx",
          mode: 0o600,
        })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return commandResult("", `create temp: ${code ?? "failed"}\n`, 74)
      }
      try {
        await chmod(this.localRemotePath(remoteTemp), 0o600)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return commandResult("", `chmod temp: ${code ?? "failed"}\n`, 79)
      }
      if (this.throwAfterNextTempCreate) {
        this.throwAfterNextTempCreate = false
        throw new Error("injected temp creation throw after execution")
      }
      return commandResult()
    }

    const chmodMatch = command.match(/^chmod ([0-7]{3,4})(?: --)? (\S+)$/)
    if (chmodMatch) {
      await chmod(this.localRemotePath(chmodMatch[2]), Number.parseInt(chmodMatch[1], 8))
      return commandResult()
    }

    const moveMatch = command.match(/^mv -f(T)?(?: --)? (\S+) (\S+)$/)
    if (moveMatch) {
      if (this.beforeNextMove) {
        const beforeMove = this.beforeNextMove
        this.beforeNextMove = undefined
        await beforeMove()
      }
      this.moveCount++
      const noTargetDirectory = moveMatch[1] === "T"
      const sourcePath = this.localRemotePath(moveMatch[2])
      const destinationPath = this.localRemotePath(moveMatch[3])
      const destinationInfo = await stat(destinationPath).catch(() => undefined)
      if (destinationInfo?.isDirectory()) {
        if (noTargetDirectory) {
          return commandResult("", "mv: cannot overwrite directory target\n", 1)
        }
        await rename(sourcePath, path.join(destinationPath, path.basename(sourcePath)))
      } else {
        await rename(sourcePath, destinationPath)
      }
      if (this.moveCount === this.throwAfterMoveNumber) {
        throw new Error("injected uncertain rename")
      }
      return commandResult()
    }

    const removeMatch = command.match(/^rm -f(?: --)? (\S+)$/)
    if (removeMatch) {
      if (this.failNextTempCleanup && removeMatch[1].includes(".opencode-")) {
        this.failNextTempCleanup = false
        return commandResult("", "injected temp cleanup failure\n", 1)
      }
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

  async chmodRemote(remotePath: string, mode: number): Promise<void> {
    await chmod(this.localRemotePath(remotePath), mode)
  }

  async mkdirRemote(remotePath: string): Promise<void> {
    await mkdir(this.localRemotePath(remotePath), { recursive: true })
  }

  async removeRemote(remotePath: string): Promise<void> {
    await rm(this.localRemotePath(remotePath), { recursive: true, force: true })
  }

  async symlinkRemote(linkPath: string, targetPath: string): Promise<void> {
    const localLink = this.localRemotePath(linkPath)
    await mkdir(path.dirname(localLink), { recursive: true })
    await symlink(this.localRemotePath(targetPath), localLink)
  }

  async replaceSymlinkRemote(linkPath: string, targetPath: string): Promise<void> {
    await unlink(this.localRemotePath(linkPath))
    await this.symlinkRemote(linkPath, targetPath)
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

function toolContext(
  ask: ToolContext["ask"] = async () => {},
  sessionID = "session",
  abort = new AbortController().signal
): ToolContext {
  return {
    sessionID,
    messageID: `${sessionID}-message`,
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort,
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

async function listLocalSyncArtifacts(root: string): Promise<string[]> {
  const artifacts: string[] = []

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (
        entry.name.startsWith(".pull-") ||
        entry.name.startsWith(".upload-") ||
        entry.name.startsWith(".validate-")
      ) {
        artifacts.push(path.relative(root, entryPath))
      }
      if (entry.isDirectory()) await visit(entryPath)
    }
  }

  await visit(root)
  return artifacts.sort()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
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

async function waitForCommand(pool: FakeRemotePool, command: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (pool.commands.includes(command)) return
    await delay(10)
  }
  throw new Error(`Timed out waiting for remote command: ${command}`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function flattenErrorMessages(error: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown): void => {
    if (seen.has(value)) return
    seen.add(value)
    if (value instanceof Error) {
      messages.push(value.message)
      if (value instanceof AggregateError) {
        for (const nested of value.errors) visit(nested)
      }
      visit(value.cause)
    } else if (value !== undefined) {
      messages.push(String(value))
    }
  }
  visit(error)
  return messages.join("\n")
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
