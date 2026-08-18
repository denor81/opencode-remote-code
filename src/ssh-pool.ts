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

  return {
    exec: (command, options) => ssh.exec(command, options),
    download: (remotePath, localPath, options) =>
      sftp.download(remotePath, localPath, options),
    upload: (localPath, remotePath, options) =>
      sftp.upload(localPath, remotePath, options),
    async close() {
      // The launcher owns and closes the ControlMaster.
    },
  }
}
