import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  PROBE_ENV,
  PROBE_PROTOCOL,
  activateCompatibilityProbe,
} from "../../src/opencode-probe.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("OpenCode loader probe", () => {
  it("activates only for the matching private tuple and writes a private marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const token = "a".repeat(64)
    const resultPath = path.join(root, "result.json")
    const env = {
      [PROBE_ENV.token]: token,
      [PROBE_ENV.resultPath]: resultPath,
    }

    expect(activateCompatibilityProbe({}, env)).toBeNull()
    const hooks = activateCompatibilityProbe({ compatibilityProbe: token }, env)

    expect(hooks?.config).toEqual(expect.any(Function))
    await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" })
    await hooks?.config?.({} as never)
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
      protocol: PROBE_PROTOCOL,
      token,
    })
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600)
  })

  it("does not activate with a mismatched tuple token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-probe-unit-"))
    temporaryRoots.push(root)
    const resultPath = path.join(root, "result.json")

    expect(
      activateCompatibilityProbe(
        { compatibilityProbe: "b".repeat(64) },
        {
          [PROBE_ENV.token]: "a".repeat(64),
          [PROBE_ENV.resultPath]: resultPath,
        }
      )
    ).toBeNull()
    await expect(stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
