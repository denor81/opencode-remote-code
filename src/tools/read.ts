import fs from "fs/promises"
import path from "path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { PathMapper } from "../path-mapper.js"
import type { RemotePathResolver } from "../remote-path-resolver.js"
import { remotePermissionPattern } from "../remote-path.js"
import { quoteShell } from "../shell-quote.js"
import type { SSHPool } from "../ssh-pool.js"
import {
  RemoteFileSizeLimitError,
  type SyncEngine,
} from "../sync-engine.js"


const DEFAULT_LIMIT = 2000
const MAX_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000
const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const IMAGE_PROBE_BYTES = 12

type SupportedImageMime =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp"

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".pyc", ".pyo", ".class", ".o", ".a", ".obj",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
])

function isBinaryByExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function sniffSupportedImageMime(bytes: Uint8Array): SupportedImageMime | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png"
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg"
  }
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii")
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif"
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }
  return undefined
}

async function inspectRemoteImage(
  sshPool: SSHPool,
  remotePath: string,
  signal: AbortSignal
): Promise<{ mime?: SupportedImageMime; size: bigint }> {
  const quotedPath = quoteShell(remotePath)
  const result = await sshPool.exec(
    [
      `size=$(stat -c %s -- ${quotedPath}) || exit $?`,
      `printf '%s\\n' "$size"`,
      `dd bs=${IMAGE_PROBE_BYTES} count=1 if=${quotedPath} 2>/dev/null | od -An -v -tx1 2>/dev/null || :`,
    ].join("; "),
    { timeout: 10_000, signal }
  )
  if (result.exitCode !== 0) {
    throw new Error(`Failed to inspect remote file ${remotePath}: ${result.stderr}`)
  }

  const [sizeText = "", ...headerLines] = result.stdout.split("\n")
  if (!/^(?:0|[1-9][0-9]*)$/u.test(sizeText)) {
    throw new Error(`Failed to inspect remote file ${remotePath}: invalid size response`)
  }
  const headerText = headerLines.join(" ").trim()
  const octets = headerText === "" ? [] : headerText.split(/\s+/u)
  if (octets.some((octet) => !/^[0-9a-f]{2}$/iu.test(octet))) {
    throw new Error(`Failed to inspect remote file ${remotePath}: invalid header response`)
  }
  const header = Buffer.from(octets.map((octet) => Number.parseInt(octet, 16)))
  return {
    mime: sniffSupportedImageMime(header),
    size: BigInt(sizeText),
  }
}

async function checkRemoteBinary(
  sshPool: SSHPool,
  remotePath: string,
  signal: AbortSignal
): Promise<{ isBinary: boolean; reason?: string }> {
  // 1. Extension blacklist
  if (isBinaryByExtension(remotePath)) {
    return { isBinary: true, reason: "binary extension" }
  }

  // 2. Remote file command check
  const fileResult = await sshPool.exec(
    `file -b ${quoteShell(remotePath)} 2>/dev/null || echo "UNKNOWN"`,
    { timeout: 10_000, signal }
  )
  const fileDesc = fileResult.stdout.trim().toLowerCase()
  if (fileDesc !== "unknown" && !fileDesc.includes("text") && !fileDesc.includes("empty")) {
    return { isBinary: true, reason: `file type: ${fileResult.stdout.trim()}` }
  }

  // 3. Remote null-byte check in first 4KB (fallback when file cmd unavailable or ambiguous)
  const nullCheck = await sshPool.exec(
    `dd bs=4096 count=1 if=${quoteShell(remotePath)} 2>/dev/null | od -An -tx1 | grep -q ' 00 ' && echo HAS_NULL || echo NO_NULL`,
    { timeout: 10_000, signal }
  )
  if (nullCheck.stdout.trim() === "HAS_NULL") {
    return { isBinary: true, reason: "null bytes detected" }
  }

  return { isBinary: false }
}

export function createReadTool(
  pathMapper: PathMapper,
  syncEngine: SyncEngine,
  sshPool: SSHPool,
  pathResolver: RemotePathResolver
): ToolDefinition {
  return tool({
    description: `Read the contents of a file or list a directory on the remote machine. PNG, JPEG, GIF, and WebP files are returned as image attachments.`,
    args: {
      filePath: tool.schema.string().describe("The absolute path to the file or directory to read"),
      offset: tool.schema.number().optional().describe("The line number to start reading from (1-indexed)"),
      limit: tool.schema.number().optional().describe("The maximum number of lines to read (defaults to 2000)"),
    },
    async execute(args, ctx) {
      const remotePath = await pathResolver.resolveExisting(args.filePath, ctx)
      const permissionPattern = remotePermissionPattern(pathMapper.remoteRoot, remotePath)
      await ctx.ask({
        permission: "read",
        patterns: [permissionPattern],
        always: [],
        metadata: { executor: "ssh", remotePath },
      })

      const localPath = pathMapper.toLocal(remotePath)
      const limit = args.limit ?? DEFAULT_LIMIT
      const offset = (args.offset ?? 1) - 1

      // Determine remote type (file / directory / missing)
      const typeResult = await sshPool.exec(
        `if [ -d ${quoteShell(remotePath)} ]; then echo "DIR"; elif [ -f ${quoteShell(remotePath)} ]; then echo "FILE"; else echo "MISSING"; fi`,
        { timeout: 10_000, signal: ctx.abort }
      )
      if (typeResult.exitCode !== 0) {
        throw new Error(`Failed to inspect remote path ${remotePath}: ${typeResult.stderr}`)
      }
      const remoteType = typeResult.stdout.trim()

      if (remoteType === "DIR") {
        const result = await sshPool.exec(
          `ls -1pA ${quoteShell(remotePath)}`,
          { timeout: 15_000, signal: ctx.abort }
        )
        if (result.exitCode !== 0) {
          throw new Error(`Failed to list remote directory ${remotePath}: ${result.stderr}`)
        }
        const items = result.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
        items.sort((a, b) => a.localeCompare(b))
        const start = offset
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        return {
          title: remotePath,
          output: [
            `<path>${remotePath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length + 1})`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: { preview: sliced.slice(0, 20).join("\n"), truncated },
        }
      }

      if (remoteType === "MISSING") {
        // Suggest similar files from remote parent directory
        const remoteDir = path.posix.dirname(remotePath)
        const base = path.posix.basename(remotePath).toLowerCase()
        let suggestions: string[] = []
        try {
          const result = await sshPool.exec(`ls -1A ${quoteShell(remoteDir)}`, {
            timeout: 10_000,
            signal: ctx.abort,
          })
          const items = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
          suggestions = items
            .filter((i) => i.toLowerCase().includes(base) || base.includes(i.toLowerCase()))
            .slice(0, 3)
        } catch {}
        if (suggestions.length > 0) {
          throw new Error(
            `File not found: ${remotePath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
          )
        }
        throw new Error(`File not found: ${remotePath}`)
      }

      await pathResolver.revalidateExisting(remotePath, ctx.abort)
      const imageProbe = await inspectRemoteImage(sshPool, remotePath, ctx.abort)
      await pathResolver.revalidateExisting(remotePath, ctx.abort)
      if (imageProbe.mime !== undefined) {
        const expectedMime = imageProbe.mime
        if (imageProbe.size > BigInt(MAX_IMAGE_BYTES)) {
          throw new Error(
            `Cannot read image file: ${remotePath}\n\nImage exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB limit.`
          )
        }

        return syncEngine.transaction(async (transaction) => {
          await pathResolver.revalidateExisting(remotePath, ctx.abort)
          try {
            if (!(await transaction.pull(remotePath, ctx.abort, MAX_IMAGE_BYTES))) {
              throw new Error(`File not found: ${remotePath}`)
            }
          } catch (error) {
            if (error instanceof RemoteFileSizeLimitError) {
              throw new Error(
                `Cannot read image file: ${remotePath}\n\nImage exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB limit after download.`,
                { cause: error }
              )
            }
            throw error
          }

          const bytes = await fs.readFile(localPath)
          if (bytes.byteLength > MAX_IMAGE_BYTES) {
            throw new Error(
              `Cannot read image file: ${remotePath}\n\nImage exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB limit after download.`
            )
          }
          if (BigInt(bytes.byteLength) !== imageProbe.size) {
            throw new Error(`Cannot read image file: ${remotePath}\n\nFile changed during download.`)
          }

          const downloadedMime = sniffSupportedImageMime(bytes)
          if (downloadedMime !== expectedMime) {
            throw new Error(`Cannot read image file: ${remotePath}\n\nFile type changed during download.`)
          }

          await pathResolver.revalidateExisting(remotePath, ctx.abort)
          const finalProbe = await inspectRemoteImage(sshPool, remotePath, ctx.abort)
          if (
            finalProbe.size !== BigInt(bytes.byteLength) ||
            finalProbe.mime !== downloadedMime
          ) {
            throw new Error(`Cannot read image file: ${remotePath}\n\nRemote file changed during download.`)
          }

          const message = "Image read successfully"
          return {
            title: remotePath,
            output: message,
            metadata: { preview: message, truncated: false },
            attachments: [
              {
                type: "file",
                mime: downloadedMime,
                url: `data:${downloadedMime};base64,${bytes.toString("base64")}`,
              },
            ],
          }
        }, ctx.abort)
      }

      // For other files: check binary on remote BEFORE syncing
      const binaryCheck = await checkRemoteBinary(sshPool, remotePath, ctx.abort)
      if (binaryCheck.isBinary) {
        throw new Error(
          `Cannot read binary file: ${remotePath}\n\nReason: ${binaryCheck.reason}. Only PNG, JPEG, GIF, and WebP images can be attached.`
        )
      }

      return syncEngine.transaction(async (transaction) => {
        await pathResolver.revalidateExisting(remotePath, ctx.abort)
        // Safe to sync: it's a text file
        if (!(await transaction.pull(remotePath, ctx.abort))) {
          throw new Error(`File not found: ${remotePath}`)
        }
        await pathResolver.revalidateExisting(remotePath, ctx.abort)

        const buf = await fs.readFile(localPath)
        // ignoreBOM: true preserves the BOM as a regular character in the output
        // (false would consume/remove it, which is what readFileWithBom does for editing)
        const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf)
        const lines = content.split("\n")

        // Offset validation
        if (offset > lines.length && lines.length > 0) {
          throw new Error(`Offset ${args.offset} is out of range (file has ${lines.length} lines)`)
        }

        const start = offset
        let bytes = 0
        const out: string[] = []
        let cut = false
        let more = false

        for (let i = start; i < lines.length; i++) {
          if (out.length >= limit) {
            more = true
            break
          }
          let line = lines[i]
          // Line length truncation
          if (line.length > MAX_LINE_LENGTH) {
            line = line.substring(0, MAX_LINE_LENGTH) + " ... (line truncated)"
          }
          const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > MAX_BYTES) {
            cut = true
            more = true
            break
          }
          out.push(line)
          bytes += size
        }

        let output = [`<path>${remotePath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
        output += out.map((line, i) => `${i + start + 1}: ${line}`).join("\n")
        const last = start + out.length
        if (cut) {
          output += `\n\n(Output capped at ${MAX_BYTES / 1024} KB. Showing lines ${start + 1}-${last}. Use offset=${last + 1} to continue.)`
        } else if (more) {
          output += `\n\n(Showing lines ${start + 1}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)`
        } else {
          output += `\n\n(End of file - total ${lines.length} lines)`
        }
        output += "\n</content>"

        return {
          title: remotePath,
          output,
          metadata: {
            preview: out.slice(0, 20).join("\n"),
            truncated: more || cut,
          },
        }
      }, ctx.abort)
    },
  })
}
