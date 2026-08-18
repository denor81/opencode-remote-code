# OpenCode SSH Live Bash Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream stdout and stderr from agent-initiated remote Bash commands into the existing OpenCode Bash card while each command is running.

**Architecture:** Add raw chunk observers to the existing process and SSH layers, then build a bounded invocation-local preview in the Bash tool. Publish replacement snapshots through an isolated OpenCode 1.18.18 metadata compatibility bridge and preserve the current final result, permission, timeout, and no-retry contracts.

**Tech Stack:** TypeScript 5.9, Node.js 22.22.2+, system OpenSSH, Effect 4.0.0-beta.83, `@opencode-ai/plugin` 1.18.18, Vitest 3.2.

**Spec:** `docs/superpowers/specs/2026-08-17-opencode-ssh-live-bash-output-design.md`

## Global Constraints

- Only the agent's SSH-backed `bash` tool gains live output; no PTY or interactive stdin is added.
- Preserve one-shot `ssh -T` channels through the launcher-owned ControlMaster.
- Never retry a command after spawn, timeout, cancellation, or transport failure.
- Preserve 1 MiB bounded capture independently for stdout and stderr.
- Live preview is the latest 30,000 characters and metadata updates are serialized and coalesced to at most once per 100 milliseconds.
- Use independent streaming UTF-8 decoders for stdout and stderr.
- Keep the current model-facing final output and non-zero-exit error behavior.
- Publish remote preview/capture truncation under both `truncated` and
  `remoteOutputTruncated`. OpenCode 1.18.18 reserves and overwrites `truncated`
  at completion, so `remoteOutputTruncated` is the durable plugin-specific
  signal.
- Do not mutate OpenCode ToolParts directly through the SDK.
- Keep the OpenCode 1.18.18 Effect workaround isolated and removable.
- Do not commit, merge, push, publish, or modify unrelated dirty-worktree changes without explicit user instruction.

---

### Task 1: Process And SSH Chunk Observers

**Files:**
- Modify: `test/unit/process.test.ts`
- Modify: `test/unit/ssh-client.test.ts`
- Modify: `test/fixtures/bin/ssh`
- Modify: `src/process.ts`
- Modify: `src/ssh/client.ts`

**Interfaces:**
- Produces: `ProcessOptions.onStdout?: (chunk: Buffer) => void`
- Produces: `ProcessOptions.onStderr?: (chunk: Buffer) => void`
- Produces: matching optional fields on `ExecOptions`
- Preserves: `ProcessResult`, `RemoteCommandResult`, capture limits, and termination semantics

- [x] **Step 1: Add failing process tests**

Add tests proving observers receive output before `spawnProcess()` settles and
continue receiving bytes beyond `maxStdoutBytes` and `maxStderrBytes`.

- [x] **Step 2: Run the process tests and verify RED**

Run: `npm run test:unit -- test/unit/process.test.ts`

Expected: TypeScript or assertions fail because chunk observers do not exist.

- [x] **Step 3: Implement minimal process observers**

Pass each raw captured `Buffer` to the matching observer from the existing
`data` listener before applying the capture limit. Keep observers synchronous.

- [x] **Step 4: Extend the fake SSH fixture and add failing SSH tests**

Add a JSON chunk-sequence environment input supporting stdout/stderr entries and
optional delays. Test that `SshClient.exec()` forwards observers before it
resolves and still returns the existing bounded final result.

- [x] **Step 5: Run the SSH tests and verify RED**

Run: `npm run test:unit -- test/unit/ssh-client.test.ts`

Expected: observer fields are absent or callbacks receive no chunks.

- [x] **Step 6: Forward observers through `SshClient.exec()`**

Add the fields to `ExecOptions` and pass them unchanged to `spawnProcess()`.

- [x] **Step 7: Verify Task 1**

Run: `npm run test:unit -- test/unit/process.test.ts test/unit/ssh-client.test.ts`

Expected: all focused tests pass with no warnings.

- [x] **Step 8: Write the Task 1 report and update the SDD ledger**

Record files, RED evidence, GREEN command, result, and remaining concerns.

### Task 2: OpenCode Metadata Compatibility Bridge

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/opencode-metadata.ts`
- Create: `test/unit/opencode-metadata.test.ts`

**Interfaces:**
- Consumes: legacy `ToolContext.metadata()` from `@opencode-ai/plugin` 1.18.18
- Produces: `publishToolMetadata(context, update): Promise<void>`
- Produces: direct exact dependency `effect: "4.0.0-beta.83"`

- [x] **Step 1: Add failing bridge tests**

Test a context whose metadata function returns `Effect.sync(...)` despite its
public `void` type, plus a context that returns `void` as a future fixed host
would. Assert each update is applied exactly once.

- [x] **Step 2: Run the bridge test and verify RED**

Run: `npm run test:unit -- test/unit/opencode-metadata.test.ts`

Expected: module or function does not exist.

- [x] **Step 3: Implement the narrow bridge**

Call metadata through a return-value-observing cast. Run only values accepted by
`Effect.isEffect`; treat `void` as already handled by the host.

- [x] **Step 4: Declare the exact direct dependency**

Add Effect 4.0.0-beta.83 without changing any other pinned package version and
review the lockfile delta.

- [x] **Step 5: Verify Task 2**

Run: `npm run test:unit -- test/unit/opencode-metadata.test.ts`

Expected: all focused tests pass.

- [x] **Step 6: Write the Task 2 report and update the SDD ledger**

Record the runtime compatibility assumption explicitly for the later TUI gate.

### Task 3: Bash Live Preview And Settlement

**Files:**
- Create: `test/unit/bash-tool.test.ts`
- Modify: `src/tools/bash.ts`

**Interfaces:**
- Consumes: `ExecOptions.onStdout`, `ExecOptions.onStderr`
- Consumes: `publishToolMetadata(context, update)`
- Produces: running and completed Bash metadata with bounded `output`, plus
  matching `truncated` and `remoteOutputTruncated` remote state

- [x] **Step 1: Add a failing successful-stream test**

Use a fake `SSHPool` that emits split UTF-8 stdout and stderr chunks before
resolving. Make `ctx.metadata()` return Effects and assert intermediate output
appears before completion, updates are ordered, and final `metadata.output`
contains the combined preview.

- [x] **Step 2: Run the focused Bash test and verify RED**

Run: `npm run test:unit -- test/unit/bash-tool.test.ts`

Expected: no callbacks are supplied and no live/final metadata output exists.

- [x] **Step 3: Implement the invocation-local preview**

Use separate `StringDecoder` instances, append in callback observation order,
retain the latest 30,000 characters, and expose running truncation state under
both fields.

- [x] **Step 4: Implement serialized coalesced publication**

Publish complete metadata snapshots, allow at most one publication per 100 ms,
keep at most one trailing snapshot, and flush before settlement. Metadata errors
disable live publishing for this invocation without affecting the command.

- [x] **Step 5: Add failing settlement tests**

Cover `(no output)`, preview overflow, non-zero exit, a timeout-style
`SshClientError` with partial output, and cancellation cleanup with no late
metadata update after settlement.

- [x] **Step 6: Run settlement tests and verify RED**

Run: `npm run test:unit -- test/unit/bash-tool.test.ts`

Expected: at least final/error retention assertions fail before implementation.

- [x] **Step 7: Complete success and error settlement**

Return final `metadata.output`; publish exit/truncation metadata before existing
non-zero throws; catch, flush, and rethrow transport timeout/abort errors. Set
both remote fields to
`previewWasCut || result.stdoutTruncated || result.stderrTruncated`. The host may
replace completed `truncated`, while `remoteOutputTruncated` remains durable;
the standard TUI is not assumed to read it, so the visible `...\n\n` output
marker remains required when the preview is cut.

- [x] **Step 8: Verify Task 3**

Run: `npm run test:unit -- test/unit/bash-tool.test.ts test/unit/process.test.ts test/unit/ssh-client.test.ts test/unit/opencode-metadata.test.ts`

Expected: all focused tests pass with no leaked timers or unhandled rejections.

- [x] **Step 9: Write the Task 3 report and update the SDD ledger**

Record exact metadata shape and any limitations discovered during implementation.

### Task 4: Documentation, Full Verification, And Fit Gate

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `opencode-ssh-remote-use/opencode-ssh-safety.md`
- Modify: `docs/upstream-fit-checklist.md`
- Modify: `docs/upstream-fit-report.md`
- Modify: `.superpowers/sdd/2026-08-17-opencode-ssh-live-bash-output/progress.md`

**Interfaces:**
- Consumes: verified behavior from Tasks 1-3
- Produces: operator guidance and a compaction-safe final evidence record

- [x] **Step 1: Document the exact live-output boundary**

State that only agent `bash` calls stream, output is a bounded replacement tail,
there is no PTY/interactive stdin, and programs must flush their own output.

- [x] **Step 2: Document administrative-command constraints**

Retain explicit confirmation, `sudo -n`, non-interactive package operation,
increased timeout, and uncertain-result verification requirements.

- [x] **Step 3: Add the manual fit cases to the checklist**

Include timed stdout/stderr, non-zero exit, timeout, cancellation, and preview
overflow using only disposable commands and paths.

- [x] **Step 4: Run static and focused verification**

Run: `npm run lint`

Run: `npm run test:unit`

- [x] **Step 5: Run complete verification**

Run: `npm test`

Run: `npm run test:smoke`

Run: `npm pack --dry-run`

Run: `git diff --check`

- [x] **Step 6: Perform the actual OpenCode 1.18.18 TUI fit gate where feasible**

Use the approved disposable SSH target and the spec's timed command. Do not run
an actual package upgrade. Record whether each line appears before completion.

- [x] **Step 7: Rebuild and reinstall only after all automated gates pass**

Run: `npm install -g .`

Run: `opencode-ssh --version`

- [x] **Step 8: Write the final Task 4 report and complete the SDD ledger**

Record every command and result, any manual check that could not be run, and the
exact resume point if the TUI gate remains pending.
