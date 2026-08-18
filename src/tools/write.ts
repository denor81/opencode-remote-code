import fs from "fs/promises"
import path from "path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { PathMapper } from "../path-mapper.js"
import type { RemotePathResolver } from "../remote-path-resolver.js"
import { remotePermissionPattern } from "../remote-path.js"
import type { SyncEngine } from "../sync-engine.js"
import { createTwoFilesPatch } from "diff"
import { readFileWithBom, joinBom, splitBom } from "../bom.js"
import { trimDiff } from "../diff-utils.js"

export function createWriteTool(
  pathMapper: PathMapper,
  syncEngine: SyncEngine,
  pathResolver: RemotePathResolver
): ToolDefinition {
  return tool({
    description: `Write content to a file on the remote machine.`,
    args: {
      content: tool.schema.string().describe("The content to write to the file"),
      filePath: tool.schema.string().describe("The absolute path to the file to write (must be absolute)"),
    },
    async execute(args, ctx) {
      const remotePath = await pathResolver.resolveMutation(args.filePath, ctx)

      const localPath = pathMapper.toLocal(remotePath)
      return syncEngine.transaction(async (transaction) => {
        const existed = await transaction.pull(remotePath, ctx.abort)

        // Preserve BOM: source.bom || next.bom (OpenCode semantics)
        let bom = false
        let oldContent = ""
        if (existed) {
          const existing = await readFileWithBom(fs, localPath)
          bom = existing.bom
          oldContent = existing.text
        }
        bom = bom || splitBom(args.content).bom

        // Build diff preview for permission request
        const diffPreview = existed
          ? generateDiffPreview(remotePath, oldContent, args.content)
          : `A ${remotePath}\n+ ${args.content.split("\n").slice(0, 10).join("\n+ ")}`

        await ctx.ask({
          permission: "edit",
          patterns: [remotePermissionPattern(pathMapper.remoteRoot, remotePath)],
          always: [remotePermissionPattern(pathMapper.remoteRoot, remotePath)],
          metadata: { diff: diffPreview, executor: "ssh", remotePath },
        })

        await fs.mkdir(path.dirname(localPath), { recursive: true })
        await fs.writeFile(localPath, joinBom(args.content, bom), "utf-8")

        await transaction.push(remotePath, ctx.abort)

        return {
          title: remotePath,
          output: "Wrote file successfully.",
          metadata: {
            filepath: remotePath,
            exists: existed,
          },
        }
      })
    },
  })
}

function generateDiffPreview(filePath: string, oldText: string, newText: string): string {
  return trimDiff(createTwoFilesPatch(filePath, filePath, oldText, newText))
}
