import fs from "fs/promises"
import path from "path"
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { createTwoFilesPatch, diffLines } from "diff"
import type { RemoteConfig } from "../config.js"
import { trimDiff } from "../diff-utils.js"
import type { PathMapper } from "../path-mapper.js"
import type {
  RemotePathResolver,
  ResolvedMutationPath,
} from "../remote-path-resolver.js"
import { remotePermissionPattern } from "../remote-path.js"
import { assertValidRemotePath, normalizeRemotePath } from "../remote-path.js"
import type { SyncEngine } from "../sync-engine.js"
import { readFileWithBom, joinBom } from "../bom.js"

// ========================================================================
// Copied from OpenCode packages/opencode/src/patch/index.ts
// Minimal adaptations: removed Effect framework, replaced BOM helpers.
// ========================================================================

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] }

export interface UpdateFileChunk {
  old_lines: string[]
  new_lines: string[]
  change_context?: string
  is_end_of_file?: boolean
}

interface PatchPlan {
  kind: "add" | "update"
  path: string
  mutationPath: ResolvedMutationPath
  apply: (content: string) => string
}

interface PatchFileMetadata {
  type: "add" | "update"
  relativePath: string
  filePath: string
  patch: string
  additions: number
  deletions: number
}

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx]

  if (line.startsWith("*** Add File:")) {
    const filePath = parseNativeHeaderPath(line, "*** Add File:")
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null
  }

  if (line.startsWith("*** Delete File:")) {
    const filePath = parseNativeHeaderPath(line, "*** Delete File:")
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null
  }

  if (line.startsWith("*** Update File:")) {
    const filePath = parseNativeHeaderPath(line, "*** Update File:")
    let movePath: string | undefined
    let nextIdx = startIdx + 1

    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      movePath = parseNativeHeaderPath(lines[nextIdx], "*** Move to:")
      nextIdx++
    }

    return filePath ? { filePath, movePath, nextIdx } : null
  }

  return null
}

function parseNativeHeaderPath(line: string, prefix: string): string {
  const value = line.slice(prefix.length)
  return trimAsciiSpaces(value.startsWith(" ") ? value.slice(1) : value)
}

function parseUpdateFileChunks(lines: string[], startIdx: number): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = []
  let i = startIdx

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("@@")) {
      const contextLine = lines[i].substring(2).trim()
      i++

      const oldLines: string[] = []
      const newLines: string[] = []
      let isEndOfFile = false

      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
        const changeLine = lines[i]

        if (changeLine === "*** End of File") {
          isEndOfFile = true
          i++
          break
        }

        if (changeLine.startsWith(" ")) {
          const content = changeLine.substring(1)
          oldLines.push(content)
          newLines.push(content)
        } else if (changeLine.startsWith("-")) {
          oldLines.push(changeLine.substring(1))
        } else if (changeLine.startsWith("+")) {
          newLines.push(changeLine.substring(1))
        }

        i++
      }

      chunks.push({
        old_lines: oldLines,
        new_lines: newLines,
        change_context: contextLine || undefined,
        is_end_of_file: isEndOfFile || undefined,
      })
    } else {
      i++
    }
  }

  return { chunks, nextIdx: i }
}

function parseAddFileContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
  let content = ""
  let i = startIdx

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("+")) {
      content += lines[i].substring(1) + "\n"
    }
    i++
  }

  if (content.endsWith("\n")) {
    content = content.slice(0, -1)
  }

  return { content, nextIdx: i }
}

function stripHeredoc(input: string): string {
  const heredocMatch = input.match(/^(?:cat\s+)?<<['"']?(\w+)['"']?\s*\n([\s\S]*?)\n\1\s*$/)
  if (heredocMatch) {
    return heredocMatch[2]
  }
  return input
}

export function parsePatch(patchText: string): { hunks: Hunk[] } {
  const cleaned = stripHeredoc(patchText.trim())
  const lines = cleaned.split("\n")
  const hunks: Hunk[] = []
  let i = 0

  const beginMarker = "*** Begin Patch"
  const endMarker = "*** End Patch"

  const beginIdx = lines.findIndex((line) => line.trim() === beginMarker)
  const endIdx = lines.findIndex((line) => line.trim() === endMarker)

  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers")
  }

  i = beginIdx + 1

  while (i < endIdx) {
    const header = parsePatchHeader(lines, i)
    if (!header) {
      i++
      continue
    }

    if (lines[i].startsWith("*** Add File:")) {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx)
      hunks.push({
        type: "add",
        path: header.filePath,
        contents: content,
      })
      i = nextIdx
    } else if (lines[i].startsWith("*** Delete File:")) {
      hunks.push({
        type: "delete",
        path: header.filePath,
      })
      i = header.nextIdx
    } else if (lines[i].startsWith("*** Update File:")) {
      const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx)
      hunks.push({
        type: "update",
        path: header.filePath,
        move_path: header.movePath,
        chunks,
      })
      i = nextIdx
    } else {
      i++
    }
  }

  return { hunks }
}

function deriveNewContentsFromChunks(
  filePath: string,
  chunks: UpdateFileChunk[],
  originalText: string,
): { content: string; bom: boolean } {
  const originalContent = readTextWithBom(originalText)

  let originalLines = originalContent.text.split("\n")

  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop()
  }

  const replacements = computeReplacements(originalLines, filePath, chunks)
  let newLines = applyReplacements(originalLines, replacements)

  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines.push("")
  }

  const next = readTextWithBom(newLines.join("\n"))

  return {
    content: next.text,
    bom: originalContent.bom || next.bom,
  }
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = []
  let lineIndex = 0

  for (const chunk of chunks) {
    if (chunk.change_context) {
      const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex)
      if (contextIdx === -1) {
        throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`)
      }
      // Allow old_lines to start at the context line itself (common when
      // AI puts the anchor on the first line of the block to be changed).
      lineIndex = contextIdx
    }

    if (chunk.old_lines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length
      replacements.push([insertionIdx, 0, chunk.new_lines])
      continue
    }

    let pattern = chunk.old_lines
    let newSlice = chunk.new_lines
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file)

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1)
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1)
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file)
    }

    if (found !== -1) {
      replacements.push([found, pattern.length, newSlice])
      lineIndex = found + pattern.length
    } else {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`)
    }
  }

  replacements.sort((a, b) => a[0] - b[0])

  return replacements
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
  const result = [...lines]

  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i]

    result.splice(startIdx, oldLen)

    for (let j = 0; j < newSegment.length; j++) {
      result.splice(startIdx + j, 0, newSegment[j])
    }
  }

  return result
}

function normalizeUnicode(str: string): string {
  return str
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ")
}

type Comparator = (a: string, b: string) => boolean

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length
    if (fromEnd >= startIndex) {
      let matches = true
      for (let j = 0; j < pattern.length; j++) {
        if (!compare(lines[fromEnd + j], pattern[j])) {
          matches = false
          break
        }
      }
      if (matches) return fromEnd
    }
  }

  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true
    for (let j = 0; j < pattern.length; j++) {
      if (!compare(lines[i + j], pattern[j])) {
        matches = false
        break
      }
    }
    if (matches) return i
  }

  return -1
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1

  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof)
  if (exact !== -1) return exact

  const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof)
  if (rstrip !== -1) return rstrip

  const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof)
  if (trim !== -1) return trim

  const normalized = tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
    eof,
  )
  return normalized
}

// ========================================================================
// BOM helpers (adapted from original Bom module)
// ========================================================================

function readTextWithBom(text: string): { text: string; bom: boolean } {
  const BOM_CODE = 0xfeff
  if (text.charCodeAt(0) === BOM_CODE) {
    return { text: text.slice(1), bom: true }
  }
  return { text, bom: false }
}

// ========================================================================
// Unified-diff types & parser (kept from previous implementation)
// ========================================================================

interface HunkUnified {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

interface UnifiedDiffFile {
  oldPath: string | null
  newPath: string | null
  hunks: HunkUnified[]
  isNew: boolean
  isDeleted: boolean
}

function parseUnifiedPatch(patchText: string): UnifiedDiffFile[] {
  const lines = patchText.split("\n")
  const files: UnifiedDiffFile[] = []
  let current: UnifiedDiffFile | null = null
  let currentHunk: HunkUnified | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith("--- ")) {
      const oldPath = trimAsciiSpaces(line.slice(4))
      const nextLine = lines[i + 1] ?? ""
      let newPath: string | null = null
      if (nextLine.startsWith("+++ ")) {
        newPath = trimAsciiSpaces(nextLine.slice(4))
        i++
      }
      current = {
        oldPath: oldPath === "/dev/null" ? null : oldPath,
        newPath: newPath === "/dev/null" ? null : newPath,
        hunks: [],
        isNew: oldPath === "/dev/null",
        isDeleted: newPath === "/dev/null",
      }
      files.push(current)
      currentHunk = null
      continue
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch && current) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] ?? "1", 10),
        lines: [],
      }
      current.hunks.push(currentHunk)
      continue
    }

    if (currentHunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      currentHunk.lines.push(line)
      continue
    }
  }

  return files
}

function detectNoNewlineAtEnd(hunks: HunkUnified[]): boolean {
  for (const hunk of hunks) {
    for (let i = hunk.lines.length - 1; i >= 0; i--) {
      const line = hunk.lines[i]
      if (line === "\\ No newline at end of file") return true
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) break
    }
  }
  return false
}

function applyUnifiedDiff(content: string, hunks: HunkUnified[], hasNoNewlineMarker: boolean): string {
  let lines = content === "" ? [] : content.split("\n")
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === ""
  if (hadTrailingNewline) {
    lines.pop()
  }

  for (let h = hunks.length - 1; h >= 0; h--) {
    const hunk = hunks[h]
    const matchIdx = findHunkPosition(lines, hunk)
    if (matchIdx === -1) {
      throw new Error(`Patch does not apply: could not find hunk context near line ${hunk.oldStart}`)
    }

    const newLines: string[] = []
    for (const ln of hunk.lines) {
      if (ln.startsWith(" ") || ln.startsWith("+")) {
        newLines.push(ln.slice(1))
      }
    }

    let oldLinesCount = 0
    for (const ln of hunk.lines) {
      if (ln.startsWith(" ") || ln.startsWith("-")) {
        oldLinesCount++
      }
    }

    lines.splice(matchIdx, oldLinesCount, ...newLines)
  }

  let result = lines.join("\n")
  if (!hasNoNewlineMarker && lines.length > 0) {
    result += "\n"
  }
  return result
}

function findHunkPosition(lines: string[], hunk: HunkUnified): number {
  const expectedIndex = hunk.oldStart - 1
  const oldLines: string[] = []
  for (const ln of hunk.lines) {
    if (ln.startsWith(" ") || ln.startsWith("-")) {
      oldLines.push(ln.slice(1))
    }
  }

  if (oldLines.length === 0) {
    return expectedIndex >= 0 && expectedIndex <= lines.length ? expectedIndex : -1
  }

  const exact = tryMatchUnified(lines, expectedIndex, oldLines)
  if (exact >= 0) return exact

  for (let offset = 1; offset <= 20; offset++) {
    const up = tryMatchUnified(lines, expectedIndex - offset, oldLines)
    if (up >= 0) return up
    const down = tryMatchUnified(lines, expectedIndex + offset, oldLines)
    if (down >= 0) return down
  }

  return -1
}

function tryMatchUnified(lines: string[], idx: number, oldLines: string[]): number {
  if (idx < 0 || idx + oldLines.length > lines.length) return -1
  for (let i = 0; i < oldLines.length; i++) {
    if (lines[idx + i] !== oldLines[i]) return -1
  }
  return idx
}

// ========================================================================
// Tool definition
// ========================================================================

export function createPatchTool(
  config: RemoteConfig,
  pathMapper: PathMapper,
  syncEngine: SyncEngine,
  pathResolver: RemotePathResolver
): ToolDefinition {
  return tool({
    description: `Apply a patch to files on the remote machine.`,
    args: {
      patchText: tool.schema.string().describe("The full patch text that describes all changes to be made"),
    },
    async execute(args, ctx) {
      if (!args.patchText.trim()) {
        throw new Error("patchText is required")
      }

      const patchText = args.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

      let files: PatchPlan[]
      if (patchText.includes("*** Begin Patch")) {
        files = await parseAndPrepareNative(patchText, config, pathResolver, ctx)
        if (files.length === 0) {
          files = await parseAndPrepareUnified(patchText, config, pathResolver, ctx)
        }
      } else {
        files = await parseAndPrepareUnified(patchText, config, pathResolver, ctx)
      }

      if (files.length === 0) {
        throw new Error("apply_patch verification failed: no file paths found in patch")
      }

      const involvedPaths = Array.from(new Set(files.map((file) => file.path))).sort()
      const mutationPaths = files.map((file) => file.mutationPath)

      return syncEngine.transaction(async (transaction) => {
        const planned = new Map<
          string,
          { existed: boolean; originalText: string; text: string; bom: boolean }
        >()

        for (const remotePath of involvedPaths) {
          const existed = await transaction.pull(remotePath, ctx.abort)
          const original = await readFileWithBom(fs, pathMapper.toLocal(remotePath))
          planned.set(remotePath, {
            existed,
            originalText: original.text,
            text: original.text,
            bom: original.bom,
          })
        }

        for (const file of files) {
          const current = planned.get(file.path)
          if (!current) throw new Error(`Missing patch baseline for ${file.path}`)
          if (file.kind === "add" && current.existed) {
            throw new Error(`Cannot add file because it already exists: ${file.path}`)
          }
          if (file.kind === "update" && !current.existed) {
            throw new Error(`Cannot update missing file: ${file.path}`)
          }
        }

        for (const file of files) {
          const current = planned.get(file.path)
          if (!current) throw new Error(`Missing patch baseline for ${file.path}`)
          const next = readTextWithBom(file.apply(current.text))
          current.text = next.text
          current.bom = current.bom || next.bom
        }

        const fileMetadata: PatchFileMetadata[] = involvedPaths.map((remotePath) => {
          const current = planned.get(remotePath)
          if (!current) throw new Error(`Missing patch result for ${remotePath}`)
          const patch = trimDiff(
            createTwoFilesPatch(
              current.existed ? remotePath : "/dev/null",
              remotePath,
              current.originalText,
              current.text
            )
          )
          const stats = countDiffStats(current.originalText, current.text)
          return {
            type: current.existed ? "update" : "add",
            relativePath: path.posix.relative(pathMapper.remoteRoot, remotePath) || remotePath,
            filePath: remotePath,
            patch,
            additions: stats.additions,
            deletions: stats.deletions,
          }
        })
        const diffPreview = fileMetadata.map((file) => file.patch).join("\n")

        await ctx.ask({
          permission: "edit",
          patterns: involvedPaths.map((remotePath) =>
            remotePermissionPattern(pathMapper.remoteRoot, remotePath)
          ),
          always: [],
          metadata: {
            diff: diffPreview,
            executor: "ssh",
            filepath: involvedPaths.join(", "),
            files: fileMetadata,
            remotePaths: involvedPaths,
          },
        })

        for (const remotePath of involvedPaths) {
          const current = planned.get(remotePath)
          if (!current) throw new Error(`Missing patch result for ${remotePath}`)
          const localPath = pathMapper.toLocal(remotePath)
          await fs.mkdir(path.dirname(localPath), { recursive: true })
          await fs.writeFile(localPath, joinBom(current.text, current.bom), "utf-8")
        }

        await transaction.pushMany(involvedPaths, ctx.abort)

        return {
          title: `Patched ${involvedPaths.length} file(s)`,
          output: `Success. Updated the following files:\n${involvedPaths.join("\n")}`,
          metadata: {
            diff: diffPreview,
            executor: "ssh",
            files: fileMetadata,
            remotePaths: involvedPaths,
          },
        }
      }, ctx.abort, mutationPaths)
    },
  })
}

function countDiffStats(oldText: string, newText: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldText, newText)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { additions, deletions }
}

async function parseAndPrepareUnified(
  patchText: string,
  config: RemoteConfig,
  pathResolver: RemotePathResolver,
  ctx: ToolContext
): Promise<PatchPlan[]> {
  const parsed = parseUnifiedPatch(patchText)
  const result: PatchPlan[] = []

  for (const file of parsed) {
    if (file.isDeleted) {
      throw new Error(
        "apply_patch deletion is disabled until remote atomic delete support is implemented; use an explicit bash rm command"
      )
    }
    const oldRemotePath = file.oldPath
      ? normalizePatchPath(file.oldPath, config.remoteWorkdir, true)
      : undefined
    const newRemotePath = file.newPath
      ? normalizePatchPath(file.newPath, config.remoteWorkdir, true)
      : undefined
    if (oldRemotePath && newRemotePath && oldRemotePath !== newRemotePath) {
      throw new Error(
        "apply_patch move is disabled until remote atomic move support is implemented; use an explicit bash mv command"
      )
    }
  }

  for (const file of parsed) {
    const targetPath = file.newPath ?? file.oldPath
    if (!targetPath) continue
    const mutationPath = await pathResolver.resolveMutation(
      normalizePatchPath(targetPath, config.remoteWorkdir, true),
      ctx
    )
    const hasNoNewlineMarker = detectNoNewlineAtEnd(file.hunks)
    result.push({
      kind: file.isNew ? "add" : "update",
      path: mutationPath.remotePath,
      mutationPath,
      apply: (content) => applyUnifiedDiff(content, file.hunks, hasNoNewlineMarker),
    })
  }

  return result
}

async function parseAndPrepareNative(
  patchText: string,
  config: RemoteConfig,
  pathResolver: RemotePathResolver,
  ctx: ToolContext
): Promise<PatchPlan[]> {
  const hunks = parsePatch(patchText).hunks
  const result: PatchPlan[] = []

  for (const hunk of hunks) {
    if (hunk.type === "delete") {
      throw new Error(
        "apply_patch deletion is disabled until remote atomic delete support is implemented; use an explicit bash rm command"
      )
    }
    if (hunk.type === "update" && hunk.move_path !== undefined) {
      throw new Error(
        "apply_patch move is disabled until remote atomic move support is implemented; use an explicit bash mv command"
      )
    }
  }

  for (const hunk of hunks) {
    const mutationPath = await pathResolver.resolveMutation(
      normalizePatchPath(hunk.path, config.remoteWorkdir),
      ctx
    )
    const remotePath = mutationPath.remotePath
    if (hunk.type === "add") {
      result.push({
        kind: "add",
        path: remotePath,
        mutationPath,
        apply: () => hunk.contents ?? "",
      })
    } else if (hunk.type === "update" && hunk.chunks) {
      const chunks = hunk.chunks
      result.push({
        kind: "update",
        path: remotePath,
        mutationPath,
        apply: (content) =>
          deriveNewContentsFromChunks(remotePath, chunks, content).content,
      })
    }
  }

  return result
}

function normalizePatchPath(
  raw: string,
  remoteWorkdir: string,
  hasUnifiedMetadata = false
): string {
  let p = raw
  if (hasUnifiedMetadata) {
    const tabIdx = p.indexOf("\t")
    if (tabIdx >= 0) p = p.slice(0, tabIdx)
  }
  p = trimAsciiSpaces(p)
  assertValidRemotePath(p, "apply_patch path")
  if (p.startsWith("a/") || p.startsWith("b/")) {
    p = p.slice(2)
  }
  if (!p) throw new Error("apply_patch path is empty")
  return normalizeRemotePath(remoteWorkdir, p)
}

function trimAsciiSpaces(value: string): string {
  return value.replace(/^ +| +$/g, "")
}
