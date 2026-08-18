import { readFile } from "node:fs/promises"

export interface PackageMetadata {
  version: string
  testedOpenCodeVersion: string
}

const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

export async function readPackageMetadata(): Promise<PackageMetadata> {
  const packageFile = new URL("../package.json", import.meta.url)
  const parsed = JSON.parse(await readFile(packageFile, "utf8")) as {
    version?: unknown
    dependencies?: Record<string, unknown>
  }
  if (typeof parsed.version !== "string") {
    throw new Error("Package version is missing")
  }

  const testedOpenCodeVersion = parsed.dependencies?.["@opencode-ai/plugin"]
  if (
    typeof testedOpenCodeVersion !== "string" ||
    !EXACT_VERSION.test(testedOpenCodeVersion)
  ) {
    throw new Error("@opencode-ai/plugin must use an exact tested version")
  }

  return { version: parsed.version, testedOpenCodeVersion }
}
