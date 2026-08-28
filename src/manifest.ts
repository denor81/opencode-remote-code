import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { PathMapper } from "./path-mapper.js"

export interface Manifest {
  remote_root: string
  files: Record<string, string>
}

export interface ManifestFileSystem {
  readFile(filePath: string): Promise<string>
  mkdir(directory: string): Promise<void>
  writeFile(
    filePath: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number }
  ): Promise<void>
  rename(source: string, destination: string): Promise<void>
  rm(filePath: string): Promise<void>
}

const defaultFileSystem: ManifestFileSystem = {
  readFile: (filePath) => fs.readFile(filePath, "utf8"),
  mkdir: async (directory) => {
    await fs.mkdir(directory, { recursive: true })
  },
  writeFile: (filePath, data, options) => fs.writeFile(filePath, data, options),
  rename: (source, destination) => fs.rename(source, destination),
  rm: async (filePath) => {
    await fs.rm(filePath, { force: true })
  },
}

export class ManifestManager {
  private manifest: Manifest
  private readonly path: string
  private generation = 0
  private savedGeneration = 0
  private saveTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly pathMapper: PathMapper,
    private readonly fileSystem: ManifestFileSystem = defaultFileSystem
  ) {
    this.path = pathMapper.manifestPath()
    this.manifest = {
      remote_root: pathMapper.remoteRoot,
      files: {},
    }
  }

  async load(): Promise<void> {
    await this.saveTail
    try {
      const data = await this.fileSystem.readFile(this.path)
      const parsed = JSON.parse(data) as Manifest
      if (
        parsed.remote_root &&
        parsed.files !== null &&
        !Array.isArray(parsed.files) &&
        typeof parsed.files === "object"
      ) {
        this.manifest = parsed
        this.generation = 0
        this.savedGeneration = 0
      }
    } catch {
      // Manifest doesn't exist yet; start empty
    }
  }

  async save(): Promise<void> {
    const generation = this.generation
    if (generation <= this.savedGeneration) return

    const snapshot = JSON.stringify(
      {
        remote_root: this.manifest.remote_root,
        files: { ...this.manifest.files },
      } satisfies Manifest,
      null,
      2
    )
    const publication = this.saveTail.then(async () => {
      if (generation <= this.savedGeneration) return
      await this.publishSnapshot(snapshot)
      this.savedGeneration = generation
    })
    this.saveTail = publication.catch(() => {})
    await publication
  }

  /** Register a remote file path. Returns its local relative path. */
  register(remotePath: string): string {
    const normalized = path.posix.normalize(remotePath)
    if (this.manifest.files[normalized]) {
      return this.manifest.files[normalized]
    }
    const rel = this.pathMapper.toLocalRelative(normalized)
    this.manifest.files[normalized] = rel
    this.generation++
    return rel
  }

  /** Check if a remote path is already tracked. */
  has(remotePath: string): boolean {
    return path.posix.normalize(remotePath) in this.manifest.files
  }

  /** Get all tracked remote paths. */
  remotePaths(): string[] {
    return Object.keys(this.manifest.files)
  }

  /** Get the relative local path for a tracked remote path. */
  getRel(remotePath: string): string | undefined {
    return this.manifest.files[path.posix.normalize(remotePath)]
  }

  /** Remove a tracked path. */
  remove(remotePath: string): void {
    const normalized = path.posix.normalize(remotePath)
    if (normalized in this.manifest.files) {
      delete this.manifest.files[normalized]
      this.generation++
    }
  }

  private async publishSnapshot(snapshot: string): Promise<void> {
    const directory = path.dirname(this.path)
    const suffix = randomBytes(12).toString("hex")
    const temporaryPath = path.join(directory, `.${path.basename(this.path)}.${suffix}.tmp`)
    let renamed = false

    await this.fileSystem.mkdir(directory)
    try {
      await this.fileSystem.writeFile(temporaryPath, snapshot, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      })
      await this.fileSystem.rename(temporaryPath, this.path)
      renamed = true
    } catch (error) {
      if (!renamed) {
        try {
          await this.fileSystem.rm(temporaryPath)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Manifest publication failed and may have left ${temporaryPath}`,
            { cause: error }
          )
        }
      }
      throw error
    }
  }
}
