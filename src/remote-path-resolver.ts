import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  assertValidRemotePath,
  isWithinRemoteRoot,
  normalizeRemotePath,
  requestExternalDirectory,
} from "./remote-path.js"
import { quoteShell } from "./shell-quote.js"
import type { SSHPool } from "./ssh-pool.js"

export const REMOTE_REALPATH_TIMEOUT_MS = 10_000

export interface ResolvedMutationPath {
  readonly remotePath: string
  revalidate(signal: AbortSignal): Promise<void>
}

export class RemotePathChangedError extends Error {
  readonly code = "REMOTE_PATH_CHANGED"

  constructor(
    readonly expectedPath: string,
    readonly actualPath: string | undefined,
    options?: ErrorOptions
  ) {
    super(
      `Remote path changed after authorization: expected ${expectedPath}, found ${
        actualPath ?? "no resolvable target or parent"
      }`,
      options
    )
    this.name = "RemotePathChangedError"
  }
}

class MutationPathUnavailableError extends Error {}

export class RemotePathResolver {
  readonly remoteRoot: string

  constructor(remoteRoot: string, private readonly sshPool: SSHPool) {
    assertValidRemotePath(remoteRoot, "Remote workspace")
    if (!path.posix.isAbsolute(remoteRoot)) {
      throw new Error("Remote workspace must be an absolute POSIX path")
    }
    this.remoteRoot = normalizeRemotePath("/", remoteRoot)
  }

  async resolveExisting(input: string, ctx: ToolContext): Promise<string> {
    const { lexical, externalAuthorized } = await this.prepare(input, ctx)
    const canonical = await this.tryRealpath(lexical, ctx.abort)
    if (canonical === undefined) {
      throw new Error(`Remote path does not exist or cannot be resolved: ${lexical}`)
    }
    if (!externalAuthorized || canonical !== lexical) {
      await requestExternalDirectory(ctx, this.remoteRoot, canonical)
    }
    return canonical
  }

  async revalidateExisting(remotePath: string, signal: AbortSignal): Promise<void> {
    const actual = await this.tryRealpath(remotePath, signal)
    if (actual !== remotePath) {
      throw new RemotePathChangedError(remotePath, actual)
    }
  }

  async resolveMutation(
    input: string,
    ctx: ToolContext
  ): Promise<ResolvedMutationPath> {
    const { lexical, externalAuthorized } = await this.prepare(input, ctx)
    const canonical = await this.resolveMutationCanonical(lexical, ctx.abort)
    if (!externalAuthorized || canonical !== lexical) {
      await requestExternalDirectory(ctx, this.remoteRoot, canonical)
    }

    return Object.freeze({
      remotePath: canonical,
      revalidate: async (signal: AbortSignal) => {
        let actual: string | undefined
        try {
          actual = await this.resolveMutationCanonical(lexical, signal)
        } catch (cause) {
          if (cause instanceof MutationPathUnavailableError) {
            throw new RemotePathChangedError(canonical, undefined, { cause })
          }
          throw cause
        }
        if (actual !== canonical) {
          throw new RemotePathChangedError(canonical, actual)
        }
      },
    })
  }

  private async resolveMutationCanonical(
    lexical: string,
    signal: AbortSignal
  ): Promise<string> {
    let candidate = lexical
    const missing: string[] = []

    while (true) {
      const canonicalAncestor = await this.tryRealpath(candidate, signal)
      if (canonicalAncestor !== undefined) {
        const canonical = path.posix.join(canonicalAncestor, ...missing)
        if (normalizeRemotePath("/", canonical) !== canonical) {
          throw new Error(`Remote path resolution produced a non-canonical path: ${canonical}`)
        }
        return canonical
      }

      if (candidate === "/") {
        throw new MutationPathUnavailableError(
          `No existing remote ancestor could be resolved for: ${lexical}`
        )
      }

      const component = path.posix.basename(candidate)
      if (component === "." || component === ".." || component.includes("/")) {
        throw new Error(`Remote path has an invalid missing component: ${component}`)
      }
      missing.unshift(component)
      candidate = path.posix.dirname(candidate)
    }
  }

  private async prepare(
    input: string,
    ctx: ToolContext
  ): Promise<{ lexical: string; externalAuthorized: boolean }> {
    const lexical = normalizeRemotePath(this.remoteRoot, input)
    // Consent must precede even the realpath probe for a lexical external path.
    const externalAuthorized = !isWithinRemoteRoot(this.remoteRoot, lexical)
    if (externalAuthorized) {
      await requestExternalDirectory(ctx, this.remoteRoot, lexical)
    }
    return { lexical, externalAuthorized }
  }

  private async tryRealpath(
    candidate: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const result = await this.sshPool.exec(
      `realpath -e -- ${quoteShell(candidate)}`,
      { timeout: REMOTE_REALPATH_TIMEOUT_MS, signal }
    )
    if (result.exitCode !== 0) return undefined
    if (result.stdoutTruncated) {
      throw new Error(`Remote realpath output was truncated for: ${candidate}`)
    }

    const canonical = result.stdout.endsWith("\n")
      ? result.stdout.slice(0, -1)
      : result.stdout
    assertValidRemotePath(canonical, "Remote realpath result")
    if (!canonical || !path.posix.isAbsolute(canonical)) {
      throw new Error(`Remote realpath returned an invalid absolute path for: ${candidate}`)
    }
    if (normalizeRemotePath("/", canonical) !== canonical) {
      throw new Error(`Remote realpath returned a non-canonical path for: ${candidate}`)
    }
    return canonical
  }
}
