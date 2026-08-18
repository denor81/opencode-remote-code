import path from "node:path"
import type { RemoteConfig } from "./config.js"
import { isWithinRemoteRoot, normalizeRemotePath } from "./remote-path.js"

export class PathMapper {
  readonly mirrorBase: string
  readonly remoteRoot: string

  constructor(config: RemoteConfig) {
    this.mirrorBase = config.mirrorRoot
    this.remoteRoot = path.posix.normalize(config.remoteWorkdir)
  }

  /** Convert a remote absolute path to a collision-free local mirror path. */
  toLocal(remotePath: string): string {
    const normalized = this.normalizeAbsolute(remotePath)
    const relative = this.isWithinWorkspace(normalized)
      ? path.posix.relative(this.remoteRoot, normalized)
      : normalized.replace(/^\/+/, "")
    const scope = this.isWithinWorkspace(normalized) ? "workspace" : "external"
    const local = path.join(this.mirrorBase, scope, ...relative.split("/").filter(Boolean))
    return this.assertWithinMirror(local)
  }

  /** Convert a local mirror path back to its remote absolute path. */
  toRemote(localPath: string): string {
    const resolved = this.assertWithinMirror(localPath)
    const relative = path.relative(path.resolve(this.mirrorBase), resolved)
    const [scope, ...parts] = relative.split(path.sep)
    if (scope === "workspace") {
      return path.posix.join(this.remoteRoot, ...parts)
    }
    if (scope === "external") {
      return path.posix.join("/", ...parts)
    }
    throw new Error(`Remote Code: local path ${JSON.stringify(localPath)} has no remote mapping`)
  }

  isWithinWorkspace(remotePath: string): boolean {
    return isWithinRemoteRoot(this.remoteRoot, remotePath)
  }

  manifestPath(): string {
    return path.join(this.mirrorBase, "manifest.json")
  }

  private normalizeAbsolute(remotePath: string): string {
    const normalized = normalizeRemotePath(this.remoteRoot, remotePath)
    if (!path.posix.isAbsolute(normalized)) {
      throw new Error(`Remote Code: path ${JSON.stringify(remotePath)} must be absolute`)
    }
    return normalized
  }

  private assertWithinMirror(localPath: string): string {
    const resolved = path.resolve(localPath)
    const base = path.resolve(this.mirrorBase)
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error(
        `Remote Code: resolved local path ${JSON.stringify(resolved)} escapes mirror base ${JSON.stringify(base)}`
      )
    }
    return resolved
  }
}
