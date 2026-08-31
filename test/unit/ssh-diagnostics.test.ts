import { describe, expect, it } from "vitest"
import {
  classifyControlMasterLine,
  classifySSHTransportFailure,
  createControlMasterDiagnosticParser,
} from "../../src/ssh/diagnostics.js"
import type { ProcessResult } from "../../src/process.js"

describe("SSH diagnostics", () => {
  it.each([
    [
      "channel 8: open failed: connect failed: private.example /secret/path",
      { kind: "channel-open-failed", reason: "connect-failed" },
    ],
    [
      "channel 12: open failed: administratively prohibited: policy detail",
      { kind: "channel-open-failed", reason: "administratively-prohibited" },
    ],
    ["Permission denied (publickey)", { kind: "master-message", category: "authentication" }],
    ["Host key verification failed", { kind: "master-message", category: "host-key" }],
    ["Connection reset by peer", { kind: "master-message", category: "connection" }],
    ["unrecognized private detail", { kind: "master-message", category: "other" }],
  ] as const)("classifies a master line without returning raw text: %s", (line, expected) => {
    const classified = classifyControlMasterLine(line)

    expect(classified).toEqual(expected)
    expect(JSON.stringify(classified)).not.toContain(line)
  })

  it("handles split, combined, partial, and overlong lines without retaining details", () => {
    const observed: unknown[] = []
    const parser = createControlMasterDiagnosticParser((value) => {
      observed.push(value)
    })

    parser.write(Buffer.from("channel 8: open failed: con"))
    parser.write(
      Buffer.from(
        "nect failed: secret\nPermission denied (publickey)\nConnection reset by peer"
      )
    )
    parser.write(Buffer.alloc(8 * 1024 + 1, 0x78))
    parser.write(Buffer.from("discarded\n"))
    parser.end()

    expect(observed).toEqual([
      { kind: "channel-open-failed", reason: "connect-failed" },
      { kind: "master-message", category: "authentication" },
      { kind: "master-message", category: "other" },
    ])
    expect(JSON.stringify(observed)).not.toContain("secret")
  })

  it("ignores configured OpenSSH debug verbosity without consuming diagnostics", () => {
    expect(
      classifyControlMasterLine("debug1: private hostname and configuration detail")
    ).toBeUndefined()
  })

  it("stops classifying after the observer reaches its event budget", () => {
    const observed: unknown[] = []
    const parser = createControlMasterDiagnosticParser((value) => {
      observed.push(value)
      return false
    })

    parser.write(Buffer.from("Permission denied\nConnection reset by peer\n"))
    parser.end()

    expect(observed).toEqual([
      { kind: "master-message", category: "authentication" },
    ])
  })

  it("classifies failed slave transports without exposing captured output", () => {
    const result = processResult({
      exitCode: 255,
      stderr: "mux_client_request_session: session request failed: private detail",
    })
    const error = Object.assign(new Error("private error"), {
      name: "SshClientError",
      result,
    })

    const classified = classifySSHTransportFailure(error, "ssh")

    expect(classified).toEqual({
      transport: "ssh",
      failureKind: "channel-open-refused",
      exitCode: 255,
      termination: null,
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    expect(JSON.stringify(classified)).not.toContain("private")
  })

  it("does not report expected file-not-found or aborted operations", () => {
    const missing = Object.assign(new Error("private path"), {
      name: "SftpFileNotFoundError",
    })
    const aborted = Object.assign(new Error("cancelled"), { name: "AbortError" })

    expect(classifySSHTransportFailure(missing, "sftp")).toBeUndefined()
    expect(classifySSHTransportFailure(aborted, "ssh")).toBeUndefined()
  })

  it("does not mistake an ordinary SFTP missing path for an unavailable master", () => {
    const result = processResult({
      exitCode: 1,
      stderr: "remote open /private/path: No such file or directory",
    })
    const error = Object.assign(new Error("private error"), {
      name: "SftpClientError",
      result,
    })

    expect(classifySSHTransportFailure(error, "sftp")).toMatchObject({
      failureKind: "sftp-failed",
    })
  })
})

function processResult(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    command: "private-command",
    args: ["private-argument"],
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    signal: null,
    termination: null,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    ...overrides,
  }
}
