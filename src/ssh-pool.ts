import type { RemoteConfig } from "./config.js"
import { SshClient, type ExecOptions, type RemoteCommandResult } from "./ssh/client.js"
import { SftpClient, type SftpTransferOptions } from "./ssh/sftp.js"

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
export async function createSSHPool(config: RemoteConfig): Promise<SSHPool> {
  const ssh = new SshClient(config.alias, config.controlSocket, {
    sshBinary: config.sshBinary,
  })
  const sftp = new SftpClient(config.alias, config.controlSocket, {
    sftpBinary: config.sftpBinary,
  })
  const closeController = new AbortController()
  const active = new Set<Promise<unknown>>()
  let closed = false
  let closePromise: Promise<void> | undefined

  const track = <T>(
    callerSignal: AbortSignal | undefined,
    start: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    if (closed) return Promise.reject(new SSHPoolClosedError())

    const signal = callerSignal
      ? AbortSignal.any([closeController.signal, callerSignal])
      : closeController.signal
    const operation = start(signal)
    active.add(operation)
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation)
    )
    return operation
  }

  return {
    exec: (command, options) =>
      track(options?.signal, (signal) => ssh.exec(command, { ...options, signal })),
    download: (remotePath, localPath, options) =>
      track(options?.signal, (signal) =>
        sftp.download(remotePath, localPath, { ...options, signal })
      ),
    upload: (localPath, remotePath, options) =>
      track(options?.signal, (signal) =>
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
