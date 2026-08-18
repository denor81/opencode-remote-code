# OpenCode SSH Live Bash Output Design

Status: approved for implementation on 2026-08-17

## Goal

Display stdout and stderr from an agent-initiated SSH-backed `bash` tool call
inside the normal OpenCode Bash card while the remote command is still running.
The completed or failed card must retain the latest bounded output preview.

## Current Boundary

The remote process and the local OpenSSH slave already stream bytes. The local
process helper drains those bytes into bounded captures, but exposes them only
after the child closes. The Bash tool then returns a completed result without
the `metadata.output` field consumed by OpenCode's Bash renderer.

OpenCode 1.18.18 also has an open legacy-plugin bridge defect: the public
`ToolContext.metadata()` method is typed as returning `void`, while the runtime
method returns an unexecuted Effect. This is tracked by
`anomalyco/opencode#37877`.

## Scope

- Agent calls to the `bash` tool registered by `opencode-ssh`.
- Live stdout and stderr as observed by the local OpenSSH process.
- A bounded replacement preview in the existing OpenCode Bash card.
- Partial output retention for non-zero exit, timeout, and cancellation.
- The existing final model-facing output and SSH failure semantics.

## Non-Goals

- PTY allocation or interactive stdin.
- Streaming results from `glob`, `grep`, file tools, MCP tools, or third-party
  shell tools.
- Forcing a remote program to flush output that it buffers itself.
- Persisting an unlimited transcript. Commands that require a complete large
  log must explicitly write or tee that log to a reviewed remote file.
- Retrying a command after timeout, cancellation, or transport failure.

## Transport Contract

`ProcessOptions` gains optional synchronous raw-chunk observers:

```ts
onStdout?: (chunk: Buffer) => void
onStderr?: (chunk: Buffer) => void
```

The observers run for every received chunk before bounded capture discards any
excess bytes. Existing capture remains limited to 1 MiB per stream and both
streams remain continuously drained. Observer callbacks must not introduce an
asynchronous backpressure queue in the process layer.

`ExecOptions` exposes the same observers and `SshClient.exec()` forwards them
to `spawnProcess()`. No new connection, retry, shell interpolation, or process
registry is introduced. `SSHPool` remains a transparent compatibility facade.

## Preview Contract

- stdout and stderr use independent streaming UTF-8 decoders so a multibyte
  character split across chunks is not corrupted.
- Decoded text is appended in the order in which local stream callbacks run.
  True cross-file-descriptor ordering on the remote host cannot be guaranteed.
- The preview follows native OpenCode shell behavior and retains at most the
  latest 30,000 characters, prefixed with `...\n\n` once earlier text is cut.
- The transport callbacks continue updating the preview after the 1 MiB final
  capture limit is reached, so the card continues to show the newest log tail.
- Metadata updates are serialized and coalesced to at most one update per 100
  milliseconds. A pending trailing snapshot is flushed before tool settlement.
- Every running update contains the complete metadata object because OpenCode
  replaces running metadata rather than merging it.

## OpenCode Compatibility Contract

A small isolated helper calls `ToolContext.metadata()` and observes its runtime
return value through a narrow cast. If the value is an Effect, the helper runs
it with Effect 4.0.0-beta.83, matching the exact dependency of the pinned
`@opencode-ai/plugin` 1.18.18 package. If the host returns `void`, the helper
assumes a future fixed host already scheduled the update and does nothing else.

`effect` is declared as a direct exact dependency. A metadata publication
failure disables further live publications for that tool call but never kills,
retries, or otherwise changes the remote command. The ordinary final result
remains the fallback.

OpenCode 1.18.18 reserves completed `metadata.truncated`: its plugin adapter
overwrites the plugin value with model-output truncation state. The plugin
therefore publishes its remote preview/capture state under both `truncated` and
`remoteOutputTruncated` before the adapter. `truncated` remains necessary for
the running renderer and direct plugin contract; `remoteOutputTruncated` is the
durable plugin-specific signal after completion. The standard TUI is not
assumed to read `remoteOutputTruncated`; `...\n\n` inside `metadata.output`
remains the user-facing preview-cut indicator.

The workaround is accepted only after an actual OpenCode 1.18.18 TUI fit test.
If the returned Effect cannot run against the correct host instance, direct SDK
ToolPart mutation is prohibited because it races settlement and changes durable
session state. The clean fallback is a patched OpenCode host bridge.

## Bash Settlement Contract

- An initial update publishes an empty `output` after permission approval and
  before command execution.
- Successful completion returns `metadata.output` containing the final preview
  or `(no output)`.
- Non-zero exit publishes the final preview and exit code before preserving the
  existing thrown-error behavior.
- Timeout and cancellation publish the latest preview before rethrowing the
  original `SshClientError`; the warning that the remote process may survive is
  preserved.
- Final metadata retains `description`, `executor: "ssh"`, canonical `workdir`,
  exit information when known, and both truncation fields. Their final remote
  value is `previewWasCut || result.stdoutTruncated || result.stderrTruncated`.
- Existing model-facing formatting of stdout followed by a labeled stderr
  section remains unchanged.

## Verification

Automated tests cover callback timing, capture overflow, UTF-8 chunk boundaries,
stdout/stderr delivery, preview truncation, update serialization/coalescing,
final metadata, non-zero exit, timeout, and cancellation cleanup.

The mandatory manual fit command is:

```sh
for n in 1 2 3 4; do
  printf 'stdout %s\n' "$n"
  printf 'stderr %s\n' "$n" >&2
  sleep 1
done
```

Each pair must appear before the process exits. Additional safe checks cover a
non-zero exit after output, timeout after output, cancellation, and a preview
larger than 30,000 characters.

## Acceptance Criteria

- Agent-initiated remote Bash logs appear while the command is running.
- The final, failed, timed-out, or cancelled card retains the latest preview.
- Memory and pending metadata work remain bounded.
- Existing SSH ControlMaster, permissions, capture, timeout, cancellation, and
  no-retry behavior remain intact.
- No direct writes are made to the local terminal stdout outside OpenCode's TUI.
