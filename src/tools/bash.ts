import { StringDecoder } from "node:string_decoder"
import {
  tool,
  type ToolContext,
  type ToolDefinition,
} from "@opencode-ai/plugin"
import { publishToolMetadata } from "../opencode-metadata.js"
import type { RemotePathResolver } from "../remote-path-resolver.js"
import type {
  BashExecutionAdmission,
  ProjectAdmissionToken,
} from "../session-safety.js"
import type { SSHPool } from "../ssh-pool.js"
import { SshClientError } from "../ssh/client.js"

const MAX_METADATA_LENGTH = 30_000
const METADATA_UPDATE_INTERVAL_MS = 100

export interface BashSafety {
  beforeBash(
    context: Pick<ToolContext, "sessionID" | "agent">,
    command: string,
    workdir?: string
  ): BashExecutionAdmission
  revalidateProject(
    sessionID: string,
    admission: ProjectAdmissionToken
  ): void
  projectSignal(
    sessionID: string,
    admission: ProjectAdmissionToken
  ): AbortSignal
  releaseProject(sessionID: string, admission: ProjectAdmissionToken): void
}

export function createBashTool(
  sshPool: SSHPool,
  defaultWorkdir: string,
  pathResolver: RemotePathResolver,
  safety: BashSafety
): ToolDefinition {
  return tool({
    description: `Execute commands in a one-shot POSIX shell on the remote machine.`,
    args: {
      command: tool.schema.string().describe("The bash command to execute"),
      description: tool.schema.string().describe("A short description of what the command does"),
      timeout: tool.schema.number().optional().describe("Timeout in milliseconds (optional)"),
      workdir: tool.schema.string().optional().describe("Working directory on the remote machine (optional)"),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID
      const admission = safety.beforeBash(ctx, args.command, args.workdir)
      try {
        const executionContext = projectContext(
          ctx,
          safety,
          sessionID,
          admission.admission
        )
        const timeout = args.timeout ?? 120_000
        if (timeout < 0) {
          throw new Error("Timeout must be a non-negative number")
        }
        const workdir = await pathResolver.resolveExisting(
          args.workdir ?? defaultWorkdir,
          executionContext
        )
        await executionContext.ask({
          permission: "bash",
          patterns: [args.command],
          always: [],
          metadata: {
            description: args.description,
            executor: "ssh",
            workdir,
          },
        })
        const title = args.description || "bash"
        const stdoutDecoder = new StringDecoder("utf8")
        const stderrDecoder = new StringDecoder("utf8")
        const publisher = new MetadataPublisher(ctx)
        let preview = ""
        let previewWasCut = false
        let decodersFinished = false
        const appendPreview = (text: string) => {
          preview += text
          if (preview.length > MAX_METADATA_LENGTH) {
            preview = "...\n\n" + preview.slice(-MAX_METADATA_LENGTH)
            previewWasCut = true
          }
        }
        const runningUpdate = (): MetadataUpdate => ({
          title,
          metadata: {
            output: preview,
            description: args.description,
            executor: "ssh",
            workdir,
            truncated: previewWasCut,
            remoteOutputTruncated: previewWasCut,
          },
        })
        const finishPreview = () => {
          if (decodersFinished) return
          decodersFinished = true
          appendPreview(stdoutDecoder.end())
          appendPreview(stderrDecoder.end())
        }
        const settlementMetadata = (result?: {
          exitCode: number | null
          stderr: string
          stdoutTruncated: boolean
          stderrTruncated: boolean
        }) => {
          const stderr =
            result === undefined ? "" : filterSshNoise(result.stderr || "")
          const remoteOutputTruncated =
            previewWasCut ||
            (result?.stdoutTruncated ?? false) ||
            (result?.stderrTruncated ?? false)
          return {
            output: preview || "(no output)",
            ...(result?.exitCode != null ? { exit: result.exitCode } : {}),
            description: args.description,
            stderr: stderr || undefined,
            executor: "ssh",
            workdir,
            truncated: remoteOutputTruncated,
            remoteOutputTruncated,
          }
        }

        await publisher.publishInitial(runningUpdate())
        safety.revalidateProject(sessionID, admission.admission)
        let result
        try {
          result = await sshPool.exec(args.command, {
            cwd: workdir,
            timeout,
            signal: executionContext.abort,
            onStdout: (chunk) => {
              appendPreview(stdoutDecoder.write(chunk))
              publisher.notify(runningUpdate())
            },
            onStderr: (chunk) => {
              appendPreview(stderrDecoder.write(chunk))
              publisher.notify(runningUpdate())
            },
          })
        } catch (error) {
          finishPreview()
          const errorResult =
            error instanceof SshClientError ? error.result : undefined
          await publisher.settle({
            title,
            metadata: settlementMetadata(errorResult),
          })
          throw error
        }

        let stdout = result.stdout || ""
        let stderr = result.stderr || ""

        // Filter out SSH connection noise from stderr
        stderr = filterSshNoise(stderr)

        finishPreview()
        const finalMetadata = settlementMetadata(result)
        await publisher.settle({ title, metadata: finalMetadata })

        if (result.exitCode !== 0) {
          const parts: string[] = []
          if (stdout.trim()) parts.push(stdout)
          if (stderr.trim()) parts.push(`stderr:\n${stderr}`)
          const message = parts.length > 0 ? parts.join("\n\n") : "(no output)"
          throw new Error(
            `Command failed with exit code ${result.exitCode}:\n${args.command}\n\n${message}`
          )
        }

        let output = stdout
        if (stderr.trim()) {
          output += "\n\nstderr:\n" + stderr
        }
        if (!output.trim()) {
          output = "(no output)"
        }
        if (result.stdoutTruncated || result.stderrTruncated) {
          output += "\n\n(Output truncated by opencode-ssh.)"
        }

        return {
          title,
          output,
          metadata: finalMetadata,
        }
      } finally {
        safety.releaseProject(sessionID, admission.admission)
      }
    },
  })
}

function projectContext(
  context: ToolContext,
  safety: BashSafety,
  sessionID: string,
  admission: ProjectAdmissionToken
): ToolContext {
  const abort = combineAbortSignals(
    context.abort,
    safety.projectSignal(sessionID, admission)
  )
  const ask: ToolContext["ask"] = async (input) => {
    await context.ask.call(context, input)
    safety.revalidateProject(sessionID, admission)
  }
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === "ask") return ask
      if (property === "abort") return abort
      return Reflect.get(target, property, receiver)
    },
  })
}

function combineAbortSignals(original: AbortSignal, lease: AbortSignal): AbortSignal {
  if (original === lease) return original
  return AbortSignal.any([original, lease])
}

type MetadataUpdate = Parameters<ToolContext["metadata"]>[0]

class MetadataPublisher {
  private enabled = true
  private accepting = true
  private pending: MetadataUpdate | undefined
  private worker: Promise<void> | undefined
  private lastSuccessAt: number | undefined

  constructor(private readonly context: Pick<ToolContext, "metadata">) {}

  async publishInitial(update: MetadataUpdate): Promise<void> {
    try {
      await publishToolMetadata(this.context, update)
      this.lastSuccessAt = Date.now()
    } catch {
      this.disable()
    }
  }

  notify(update: MetadataUpdate): void {
    if (!this.enabled || !this.accepting) return
    this.pending = update
    this.startWorker()
  }

  async settle(update: MetadataUpdate): Promise<void> {
    this.accepting = false
    if (this.enabled) {
      this.pending = update
      this.startWorker()
    }
    while (
      this.worker !== undefined ||
      (this.enabled && this.pending !== undefined)
    ) {
      this.startWorker()
      const worker = this.worker
      if (worker === undefined) break
      await worker
    }
  }

  private startWorker(): void {
    if (!this.enabled || this.worker !== undefined || this.pending === undefined) return
    const worker = this.runWorker().finally(() => {
      if (this.worker === worker) {
        this.worker = undefined
        this.startWorker()
      }
    })
    this.worker = worker
  }

  private async runWorker(): Promise<void> {
    while (this.enabled && this.pending !== undefined) {
      if (this.lastSuccessAt !== undefined) {
        const wait =
          METADATA_UPDATE_INTERVAL_MS - (Date.now() - this.lastSuccessAt)
        if (wait > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, wait))
        }
      }
      if (!this.enabled || this.pending === undefined) return

      const update = this.pending
      this.pending = undefined
      try {
        await publishToolMetadata(this.context, update)
        this.lastSuccessAt = Date.now()
      } catch {
        this.disable()
      }
    }
  }

  private disable(): void {
    this.enabled = false
    this.accepting = false
    this.pending = undefined
  }
}

const SSH_NOISE_PATTERNS = [
  /^Warning: Permanently added .* to the list of known hosts\.\s*$/,
  /^\*\* WARNING: connection is not using a post-quantum key exchange algorithm\.\s*$/,
  /^\*\* This session may be vulnerable to "store now, decrypt later" attacks\.\s*$/,
  /^\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html\s*$/,
  /^Connection to .* closed\.\s*$/,
]

function filterSshNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !SSH_NOISE_PATTERNS.some((p) => p.test(line)))
    .join("\n")
}
