import { AsyncLocalStorage } from "node:async_hooks"
import type { RemoteConfig } from "./config.js"
import { SshClient, type ExecOptions, type RemoteCommandResult } from "./ssh/client.js"
import {
  classifySSHTransportFailure,
  type SSHTransport,
  type SSHTransportFailureDiagnostic,
} from "./ssh/diagnostics.js"
import { SftpClient, type SftpTransferOptions } from "./ssh/sftp.js"

export type SSHPoolOperation =
  | "bootstrap"
  | "remote_status"
  | "bash"
  | "glob"
  | "grep"
  | "read"
  | "write"
  | "edit"
  | "apply_patch"

export interface SSHPoolTransportFailure extends SSHTransportFailureDiagnostic {
  operation: SSHPoolOperation
}

export interface SSHPoolOptions {
  onTransportFailure?: (failure: SSHPoolTransportFailure) => void
}

export interface SSHPool {
  exec(command: string, options?: ExecOptions): Promise<RemoteCommandResult>
  download(
    remotePath: string,
    localPath: string,
    options?: SftpTransferOptions
  ): Promise<void>
  upload(
    localPath: string,
    remotePath: string,
    options?: SftpTransferOptions
  ): Promise<void>
  close(): Promise<void>
}

export interface ContextualSSHPool extends SSHPool {
  runWithOperation<T>(operation: SSHPoolOperation, callback: () => Promise<T>): Promise<T>
}

export class SSHPoolClosedError extends Error {
  constructor() {
    super("SSH pool is closed")
    this.name = "SSHPoolClosedError"
  }
}

/**
 * Compatibility facade for the existing tools. OpenSSH owns connection
 * multiplexing; this object never retries a command or owns the master.
 */
export async function createSSHPool(
  config: RemoteConfig,
  options: SSHPoolOptions = {}
): Promise<ContextualSSHPool> {
  const ssh = new SshClient(config.alias, config.controlSocket, {
    sshBinary: config.sshBinary,
  })
  const sftp = new SftpClient(config.alias, config.controlSocket, {
    sftpBinary: config.sftpBinary,
  })
  const closeController = new AbortController()
  const operationContext = new AsyncLocalStorage<SSHPoolOperation>()
  const active = new Set<Promise<unknown>>()
  let closed = false
  let closePromise: Promise<void> | undefined

  const track = <T>(
    transport: SSHTransport,
    callerSignal: AbortSignal | undefined,
    start: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    if (closed) return Promise.reject(new SSHPoolClosedError())

    const signal = callerSignal
      ? AbortSignal.any([closeController.signal, callerSignal])
      : closeController.signal
    const initiatingOperation = operationContext.getStore()
    const operation = start(signal)
    active.add(operation)
    void operation.then(
      () => active.delete(operation),
      (error: unknown) => {
        active.delete(operation)
        if (!initiatingOperation || !options.onTransportFailure) return
        const failure = classifySSHTransportFailure(error, transport)
        if (!failure) return
        try {
          options.onTransportFailure({ operation: initiatingOperation, ...failure })
        } catch {
          // Diagnostics must never affect the transport result.
        }
      }
    )
    return operation
  }

  return {
    runWithOperation: (operation, callback) => operationContext.run(operation, callback),
    exec: (command, options) =>
      track("ssh", options?.signal, (signal) =>
        ssh.exec(command, { ...options, signal })
      ),
    download: (remotePath, localPath, options) =>
      track("sftp", options?.signal, (signal) =>
        sftp.download(remotePath, localPath, { ...options, signal })
      ),
    upload: (localPath, remotePath, options) =>
      track("sftp", options?.signal, (signal) =>
        sftp.upload(localPath, remotePath, { ...options, signal })
      ),
    close() {
      if (closePromise) return closePromise

      closed = true
      const operations = [...active]
      closeController.abort(new SSHPoolClosedError())
      closePromise = Promise.allSettled(operations).then((results) => {
        const unexpected = results.flatMap((result) => {
          if (result.status === "fulfilled" || isAbortError(result.reason)) return []
          return [result.reason]
        })
        if (unexpected.length > 0) {
          throw new AggregateError(
            unexpected,
            "SSH pool closed after active operations failed"
          )
        }
        // The launcher, not the pool, owns the ControlMaster.
      })
      return closePromise
    },
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  )
}
