# OpenCode SSH Practical Adaptation Implementation Plan

> **Archived historical plan:** This document records the adaptation process
> and is not current implementation guidance. Interfaces, paths, dependencies,
> and referenced files may be obsolete. Use `README.md`,
> `docs/installation-and-usage.md`, `SECURITY.md`, and the current source and
> tests for authoritative behavior. Do not execute this plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First evaluate the pinned `opencode-remote-code` plugin with the user's normal OpenCode configuration, then, only if requested, harden it into a practical `opencode-ssh <ssh-alias> [remote-workdir]` launcher without strict tool isolation or compatibility certification.

**Architecture:** Stage A imports and smoke-tests upstream commit `68dd10ba9f91c66a09c2058110714dce7094cb7a` with only the fixes required to build and load it. Stage B keeps ordinary OpenCode configuration, plugins, MCP servers, provider authentication, and the local TUI, but replaces upstream SSH and synchronization internals with a launcher-owned system OpenSSH ControlMaster, safe command/SFTP clients, and conflict-checked file operations. The plugin continues to override the familiar built-in project tool names; other OpenCode tools remain local.

**Tech Stack:** TypeScript, Node.js 22.22.2+, system OpenSSH (`ssh` and `sftp`), `@opencode-ai/plugin`, Vitest, optional operator-provided non-production SSH target.

**Spec:** `docs/opencode-ssh.txt` (practical hardening findings only). The strict design in `docs/superpowers/specs/2026-08-16-opencode-ssh-remote-execution-design.md` is explicitly out of scope for this plan.

## Global Constraints

- Stage A must finish with a user-visible fit report before any Stage B hardening begins.
- Do not begin Stage B unless the user explicitly approves it after the Stage A trial.
- Use upstream commit `68dd10ba9f91c66a09c2058110714dce7094cb7a`, not a moving branch.
- Treat upstream as MIT per the user's licensing decision; preserve attribution and the pinned source URL.
- OpenCode, model credentials, provider traffic, VPN/proxy settings, TUI, sessions, normal plugins, and normal MCP servers remain local.
- Existing global OpenCode configuration remains enabled. Serper and other currently configured integrations are not intentionally disabled.
- The plugin overrides `bash`, `read`, `write`, `edit`, `glob`, `grep`, and `apply_patch` with SSH-backed implementations.
- Tools not overridden by the plugin may still execute locally. This plan does not provide a fail-closed or no-local-execution guarantee.
- Do not add exact-version manifests, tool-inventory certification, arm attestations, isolated HOME/XDG directories, or a `serve`/`attach` supervisor.
- Pass SSH aliases to system OpenSSH unchanged so `~/.ssh/config`, SSH agent, encrypted keys, `ProxyJump`, and `known_hosts` remain authoritative in Stage B.
- Never use `shell: true` for local process spawning.
- Never automatically retry a remote command after it may have started.
- Canonicalize remote file paths outside the configured workdir and request OpenCode `external_directory` permission before access. A root workdir `/` contains every absolute path.
- Initial Stage B remote targets are Linux systems with SSH, SFTP, POSIX `sh`, and `realpath`; document this requirement instead of pretending to support every POSIX host.
- Stage B clients are Linux and macOS with Node.js 22.22.2+; Windows users run the launcher in WSL.
- Do not implement sudo-password storage or remote askpass scripts.
- Do not modify the user's global OpenCode configuration during tests. Use additive process environment/config content or documented manual installation.
- Do not run Stage A mutation tests against a production directory.
- Keep automated tests hermetic by injecting fake `ssh`/`sftp` executables from `test/fixtures/bin`; real-host tests are opt-in through `OPENCODE_SSH_TEST_ALIAS` and skip when it is absent.
- Do not create git commits unless the user explicitly requests them.

## Approved Trial Refinements

- SSH alias support is a prerequisite for the first real-host trial because the operator authenticates exclusively through system OpenSSH config and keys.
- The launcher interface is exactly `opencode-ssh <ssh-alias> <absolute-remote-workdir>`; it does not forward OpenCode arguments after `--`.
- The launcher disables SSH account-password and keyboard-interactive fallback, while allowing normal OpenSSH host-key and private-key passphrase prompts during master startup.
- `/` is a valid remote workdir for read-only administration trials. Unix access remains limited to the SSH user's privileges.
- Root-owned files are administered through explicit `bash` commands using `sudo -n`; SFTP-backed file tools do not elevate.
- The controlled mutation trial uses a separate non-production SSH target.

## Explicitly Deferred Strict Features

The following features remain in the original strict plan and are not part of this implementation:

- `remote_*` tool names and default-deny policy.
- `LOCKED`, `PREFLIGHT`, `ARMED`, and `STOPPING` guard states.
- Exact OpenCode version and tool inventory manifests.
- Schema certification and local canary certification.
- Blocking ordinary external plugins, MCP servers, LSP, formatters, project configuration, and direct TUI APIs.
- A claim that every model-initiated or user-initiated operation is remote.

## Planned File Structure

```text
opencode-ssh/
  package.json
  package-lock.json
  tsconfig.json
  vitest.config.ts
  LICENSE
  UPSTREAM.md
  README.md
  SECURITY.md
  src/cli.ts
  src/launcher-config.ts
  src/process.ts
  src/runtime-paths.ts
  src/ssh/control-master.ts
  src/ssh/client.ts
  src/ssh/quote.ts
  src/ssh/sftp.ts
  src/plugin/index.ts
  src/plugin/context.ts
  src/plugin/system-context.ts
  src/plugin/files/fingerprint.ts
  src/plugin/files/mirror.ts
  src/plugin/files/transaction.ts
  src/plugin/tools/bash.ts
  src/plugin/tools/read.ts
  src/plugin/tools/search.ts
  src/plugin/tools/write.ts
  src/plugin/tools/edit.ts
  src/plugin/tools/patch.ts
  src/plugin/tools/status.ts
  src/upstream/                    selected adapted upstream utilities
  test/unit/
  test/integration/
  test/fixtures/bin/
  test/smoke/
  docs/upstream-fit-report.md
```

## Reuse Map

Use upstream as a source baseline, not as an architectural constraint:

| Upstream area | Decision |
| --- | --- |
| `src/bom.ts` | Reuse with tests. |
| `src/diff-utils.ts` | Reuse after dependency and output-bound review. |
| `src/tools/edit.ts` | Adapt parsing/matching structure, but replace the `0.0` threshold and add current OpenCode regression tests. |
| `src/tools/patch.ts` | Adapt parser only; replace delete, move, validation, and upload behavior. |
| Tool schemas and result formatting | Adapt to current `@opencode-ai/plugin` and preserve familiar built-in tool names. |
| `src/config.ts` | Keep for Stage A, then delete when `src/launcher-config.ts` and the new plugin entry replace it. |
| `src/ssh-pool.ts` | Keep only for the Stage A trial, then delete in Stage B. |
| `src/path-mapper.ts` | Replace with canonical remote containment and hashed private mirror paths. |
| `src/sync-engine.ts` | Replace with per-file conflict-checked transactions. |
| `src/prompts/*` and prompt replacement | Delete; append only a compact remote context block. |

---

## Stage A: Upstream Fit Trial

### Task 1: Import The Pinned Upstream And Repair The Build

**Files:**
- Create: `opencode-ssh/` from upstream commit `68dd10ba9f91c66a09c2058110714dce7094cb7a`
- Modify: `opencode-ssh/package.json`
- Create: `opencode-ssh/package-lock.json`
- Create: `opencode-ssh/vitest.config.ts`
- Create: `opencode-ssh/LICENSE`
- Create: `opencode-ssh/UPSTREAM.md`
- Test: `opencode-ssh/test/smoke/package-load.test.ts`

**Interfaces:**
- Produces: a buildable upstream baseline whose plugin entry can be imported from `dist/index.js`.
- Produces: an explicit record of the source repository, source commit, license decision, and local modifications.

- [ ] **Step 1: Import exactly the pinned source snapshot**

Use a temporary clone only as an import source. Do not retain a nested `.git` directory.

```bash
git clone --filter=blob:none https://github.com/zz6zz666/opencode-remote-code.git /tmp/opencode/opencode-remote-code
git -C /tmp/opencode/opencode-remote-code checkout 68dd10ba9f91c66a09c2058110714dce7094cb7a
mkdir opencode-ssh
git -C /tmp/opencode/opencode-remote-code archive 68dd10ba9f91c66a09c2058110714dce7094cb7a | tar -x -C opencode-ssh
```

- [ ] **Step 2: Reproduce and record the baseline build failure**

Run:

```bash
npm install
npm run build
```

Expected before repair: installation has no lock file and the duplicate `dependencies` key omits `diff`, causing the build or runtime import to fail.

- [ ] **Step 3: Replace package metadata with one unambiguous dependency set**

Use one `dependencies` object. For the initial trial retain `ssh2`; Stage B removes it.

```json
{
  "name": "opencode-ssh",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && node scripts/postbuild.cjs",
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "test:smoke": "vitest run test/smoke"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@opencode-ai/plugin": "1.18.18",
    "diff": "9.0.0",
    "ssh2": "1.17.0",
    "zod": "3.25.76"
  },
  "devDependencies": {
    "@types/node": "22.17.1",
    "@types/ssh2": "1.15.5",
    "typescript": "5.9.2",
    "vitest": "3.2.4"
  }
}
```

If implementation occurs against a different installed OpenCode version, use that exact `@opencode-ai/plugin` version and record the tested version in the fit report. Do not add a runtime compatibility gate.

- [ ] **Step 4: Add provenance and license files**

`UPSTREAM.md` must include:

```markdown
# Upstream

This project is adapted from:

- Repository: https://github.com/zz6zz666/opencode-remote-code
- Commit: 68dd10ba9f91c66a09c2058110714dce7094cb7a
- Declared license: MIT (README and package metadata)

Local changes are documented in git history and the project README.
```

Add the standard MIT license text and preserve the upstream author attribution.

- [ ] **Step 5: Write a package-load smoke test**

The test must import the built plugin with remote mode disabled and prove that it remains dormant rather than opening SSH connections.

```ts
import { describe, expect, it } from "vitest"

describe("package entry", () => {
  it("loads without activating remote mode", async () => {
    delete process.env.REMOTE_SSH
    const plugin = await import("../../dist/index.js")
    expect(plugin.default).toBeDefined()
  })
})
```

- [ ] **Step 6: Generate the lock file and verify the repaired baseline**

Run:

```bash
npm install
npm run build
npm run test:smoke
npm pack --dry-run
```

Expected: all commands exit 0 and the tarball contains the built plugin entry.

### Task 2: Run A Controlled Upstream Fit Trial

**Files:**
- Create: `opencode-ssh/docs/upstream-fit-checklist.md`
- Create: `opencode-ssh/docs/upstream-fit-report.md`
- Create: `opencode-ssh/test/smoke/fixtures/remote-smoke.patch`

**Interfaces:**
- Consumes: the buildable upstream plugin from Task 1.
- Produces: a go/no-go report for Stage B based on actual user workflow.

- [ ] **Step 1: Document the safe trial boundary**

The checklist must require:

```text
- A non-production SSH target or disposable test directory.
- No secrets committed to files or shell history.
- A unique remote smoke directory created for this run.
- A local canary path that the test must not intentionally modify.
- Cleanup commands reviewed before they are run.
```

- [ ] **Step 2: Configure the plugin additively**

Use an explicit built plugin path in a temporary OpenCode configuration or an additive `OPENCODE_CONFIG_CONTENT` value. Do not overwrite the user's global configuration. Leave existing global plugins and MCP servers enabled.

For the unmodified Stage A transport, use only authentication supported by upstream: a direct host with a password or an absolute unencrypted private-key path. If the user's normal connection requires an SSH alias, agent, encrypted key, or `ProxyJump`, record the transport trial as unsupported and proceed only after Stage B is approved.

- [ ] **Step 3: Exercise the existing remote tools in a disposable directory**

Verify, in order:

```text
1. bash: pwd, uname, and a command with spaces and dollar signs.
2. glob: files under the disposable directory only.
3. grep: a known expression and include filter.
4. read: text file, directory, BOM file, and path containing spaces.
5. write: create one new text file.
6. edit: one exact unique replacement.
7. apply_patch: add and update operations only.
8. Serper: one normal search through the user's existing integration.
9. Session restart: confirm the remote target remains understandable.
```

Do not test the known-broken delete operation against a valuable file.

- [ ] **Step 4: Record observed behavior without hiding upstream defects**

The report must contain this table with concrete results:

```markdown
| Capability | Pass/Fail | Evidence | Blocking for daily use? |
| --- | --- | --- | --- |
| Build and plugin load | | | |
| SSH authentication | | | |
| Remote bash | | | |
| Remote read/search | | | |
| Remote write/edit/patch | | | |
| Existing Serper/MCP tools | | | |
| Session persistence | | | |
| Cleanup | | | |
```

Also record the tested OpenCode version, operating systems, remote shell, and exact upstream commit. Never include credentials, expanded key content, or passwords.

- [ ] **Step 5: Stop for the Stage B decision**

Present the fit report to the user.

- If the existing plugin is sufficient, stop. Do not implement Tasks 3-9.
- If only specific defects block use, revise Stage B to the smallest approved subset.
- If the user approves the complete practical hardening scope, continue with Task 3.

---

## Stage B: Practical Hardening

### Task 3: Add The Launcher And System OpenSSH ControlMaster

**Files:**
- Modify: `opencode-ssh/package.json`
- Create: `opencode-ssh/src/cli.ts`
- Create: `opencode-ssh/src/launcher-config.ts`
- Create: `opencode-ssh/src/process.ts`
- Create: `opencode-ssh/src/runtime-paths.ts`
- Create: `opencode-ssh/src/ssh/control-master.ts`
- Create: `opencode-ssh/test/fixtures/bin/ssh`
- Test: `opencode-ssh/test/unit/cli.test.ts`
- Test: `opencode-ssh/test/unit/process.test.ts`
- Test: `opencode-ssh/test/unit/runtime-paths.test.ts`
- Test: `opencode-ssh/test/unit/control-master.test.ts`

**Interfaces:**
- Produces: `parseCli(argv: string[]): CliOptions`.
- Produces: `spawnChecked(command: string, args: string[], options): Promise<ProcessResult>`.
- Produces: `spawnManaged(command: string, args: string[], options): ManagedProcess`.
- Produces: `ControlMaster.start(alias: string, socketPath: string, signal: AbortSignal): Promise<ControlMaster>`.
- Produces: `OpenSshBinaries { ssh: string; sftp: string }`, defaulting to system executable names and injectable by tests.
- Produces: launcher environment consumed by `src/plugin/context.ts`.

- [ ] **Step 1: Write failing CLI and argument-preservation tests**

Cover:

```ts
expect(parseCli(["staging"])).toEqual({ host: "staging", opencodeArgs: [] })
expect(parseCli(["staging", "/srv/app", "--", "--model", "openai/gpt-5"])).toEqual({
  host: "staging",
  workdir: "/srv/app",
  opencodeArgs: ["--model", "openai/gpt-5"],
})
expect(() => parseCli(["bad host"])).toThrow(/SSH alias/)
```

Process tests must prove that `"a b"`, `"$(id)"`, quotes, and newlines remain single literal arguments and that no helper sets `shell: true`.

The fake `ssh` executable must record its argv as JSON and provide deterministic `-G`, `-O check`, `-O exit`, and remote-command responses without opening a network connection.

- [ ] **Step 2: Implement private runtime paths without the strict XDG profile**

Use:

```text
state:   ${XDG_STATE_HOME:-~/.local/state}/opencode-ssh/<target-id>/
cache:   ${XDG_CACHE_HOME:-~/.cache}/opencode-ssh/<target-id>/
workdir: <state>/workspace/
socket:  ${XDG_RUNTIME_DIR:-/tmp}/opencode-ssh-<uid>/<launch-id>.sock
ready:   <state>/plugin-ready-<launch-id>.json
```

The random launch ID determines the socket before the canonical remote workdir is known. After SSH resolves the canonical workdir, compute the stable target ID from `alias + "\0" + canonicalWorkdir`. Create directories with mode `0700` and metadata files with mode `0600`.

- [ ] **Step 3: Implement the launcher-owned ControlMaster**

Use argument arrays equivalent to:

```text
ssh -G -- <alias>
ssh -MN -o ControlMaster=yes -o ControlPersist=no -o ControlPath=<socket> -- <alias>
ssh -S <socket> -O check -- <alias>
```

Inherit stdin/stderr for master startup so OpenSSH can handle host-key and key-passphrase prompts normally. Do not add `StrictHostKeyChecking=no`.

- [ ] **Step 4: Add the executable entry and additive plugin loading**

Add:

```json
{
  "bin": {
    "opencode-ssh": "dist/cli.js"
  }
}
```

The launcher starts ordinary `opencode`, not `opencode serve`. Preserve `HOME`, every XDG variable, provider/proxy variables, and current configuration. Append this package's plugin entry to a parsed copy of existing `OPENCODE_CONFIG_CONTENT`, or set a new content object when absent. Reject malformed existing content rather than discarding it.

- [ ] **Step 5: Require a plugin-ready handshake**

Pass a random nonce and private ready-file path to the child. The plugin atomically writes a mode-`0600` JSON file containing the nonce hash, alias, canonical workdir, and target ID during initialization. If no matching file appears within five seconds, terminate OpenCode and report that the remote plugin did not load; never continue silently with local built-in tools.

This handshake proves plugin initialization only. It is not a strict tool-inventory or implementation-identity guarantee.

- [ ] **Step 6: Verify unit tests and build**

Run:

```bash
npm run test:unit
npm run build
```

Expected: all tests pass and `dist/cli.js` is executable through the package bin entry.

### Task 4: Split Launcher Ownership From Plugin SSH Clients

**Files:**
- Keep temporarily: `opencode-ssh/src/ssh-pool.ts` for the still-active Stage A plugin entry
- Create: `opencode-ssh/src/ssh/client.ts`
- Create: `opencode-ssh/src/ssh/quote.ts`
- Create: `opencode-ssh/src/plugin/context.ts`
- Test: `opencode-ssh/test/unit/ssh-client.test.ts`
- Test: `opencode-ssh/test/unit/ssh-quote.test.ts`
- Test: `opencode-ssh/test/integration/ssh-command.test.ts`

**Interfaces:**
- Consumes: control socket and canonical target metadata from Task 3 environment variables.
- Produces: `SshClient.exec(command: string, options: ExecOptions): Promise<RemoteCommandResult>`.
- Produces: `loadRemoteContext(env): RemoteContext`.

- [ ] **Step 1: Write adversarial POSIX quoting tests**

Cover empty strings, spaces, single quotes, double quotes, dollar signs, command substitutions, backticks, semicolons, and newlines. The quoting function must use POSIX single-quote escaping and return one shell word.

- [ ] **Step 2: Implement validated plugin context loading**

Require every field below when remote mode is active:

```ts
interface RemoteContext {
  alias: string
  canonicalWorkdir: string
  socketPath: string
  targetID: string
  readyPath: string
  readyNonce: string
}
```

Reject missing fields, control characters, a relative workdir, or a socket path outside the launcher's private runtime directory.

- [ ] **Step 3: Implement one-shot command channels over the existing master**

Spawn:

```text
ssh -T -S <socket> -- <alias> sh -lc <quoted-script>
```

Prefix tool commands with a canonical-workdir `cd`. Capture bounded stdout and stderr, preserve the exit code and signal, and never retry after spawn succeeds.

- [ ] **Step 4: Implement cancellation honestly**

On timeout or `AbortSignal`, terminate the local SSH channel with TERM followed by KILL after three seconds. Report that remote descendants may survive channel loss; do not claim guaranteed remote process-group termination without an additional remote dependency.

- [ ] **Step 5: Implement workdir and path canonicalization**

Resolve the requested workdir with remote `realpath`; when no workdir is provided, resolve `pwd -P`. For existing paths, use remote `realpath`. For new paths, canonicalize the existing parent and append one validated basename. A path is contained only when it equals the root or starts with `root + "/"`.

- [ ] **Step 6: Keep the legacy transport isolated until the plugin switch**

Do not import `src/ssh-pool.ts` from any new Stage B module. Keep `ssh2` and `@types/ssh2` only because the Stage A plugin entry still imports that file. Task 8 removes the legacy entry, transport, and dependencies together.

- [ ] **Step 7: Verify command behavior**

Tests must prove:

```text
- aliases are never interpolated into local shell strings;
- a failed command executes once;
- timeout and abort stop the local SSH process;
- stdout/stderr limits are enforced;
- canonical paths outside the workdir request `external_directory` permission before access.
```

### Task 5: Replace Global Sync With Conflict-Checked SFTP Transactions

**Files:**
- Keep temporarily: `opencode-ssh/src/path-mapper.ts` for the Stage A plugin entry
- Keep temporarily: `opencode-ssh/src/sync-engine.ts` for the Stage A plugin entry
- Keep temporarily: `opencode-ssh/src/manifest.ts` for the Stage A plugin entry
- Create: `opencode-ssh/src/ssh/sftp.ts`
- Create: `opencode-ssh/src/plugin/files/fingerprint.ts`
- Create: `opencode-ssh/src/plugin/files/mirror.ts`
- Create: `opencode-ssh/src/plugin/files/transaction.ts`
- Create: `opencode-ssh/test/fixtures/bin/sftp`
- Test: `opencode-ssh/test/unit/sftp-quote.test.ts`
- Test: `opencode-ssh/test/unit/fingerprint.test.ts`
- Test: `opencode-ssh/test/integration/file-transaction.test.ts`

**Interfaces:**
- Produces: `SftpClient.download(remote: string, local: string): Promise<void>`.
- Produces: `SftpClient.upload(local: string, remote: string): Promise<void>`.
- Produces: `FileTransaction.read/replace/delete/move`.

- [ ] **Step 1: Write adversarial SFTP path tests**

Cover spaces, quotes, leading dashes, dollar signs, semicolons, Unicode, and traversal. Reject newlines and any path that cannot be represented safely in OpenSSH SFTP batch syntax.

- [ ] **Step 2: Implement SFTP over the existing control socket**

Spawn an argument array equivalent to:

```text
sftp -b - -o ControlPath=<socket> -- <alias>
```

Generate exactly one tested batch command per operation. Never concatenate a batch command from unvalidated fragments.

The fake `sftp` executable must implement only the batch commands used by the client against a temporary fixture root and record every command for assertions. Any unrecognized command fails the test.

- [ ] **Step 3: Implement private hashed mirror paths**

Map each canonical remote path to a SHA-256 filename under the target cache. Store metadata separately; never recreate the raw absolute remote path as local directories. Use mode `0600` for mirrored files.

- [ ] **Step 4: Implement content-aware fingerprints**

Use canonical path, SFTP size/mtime/mode attributes, and a local SHA-256 of downloaded content. Before mutation, download the current remote file to a second private temporary path and compare its complete fingerprint. Missing files return `null`; permission failures remain errors.

- [ ] **Step 5: Implement atomic replacement and real deletion**

Upload to a random sibling `.opencode-ssh-<target>-<nonce>.tmp`, apply the intended mode, and rename within the same remote directory. `delete` must remove the path after a fingerprint check. `move` must validate source and destination, then use one remote rename when both share a filesystem.

- [ ] **Step 6: Test conflicts and interrupted uploads**

An integration test must modify a remote file between read and replace and expect `RemoteFileConflict` with the second writer's content unchanged. Interrupt before rename and prove the destination remains unchanged. Verify temporary files are cleaned on the next connection when they match this target ID.

### Task 6: Adapt Bash, Read, Glob, And Grep

**Files:**
- Keep temporarily: `opencode-ssh/src/tools/bash.ts`, `read.ts`, `glob.ts`, and `grep.ts` for the Stage A plugin entry
- Keep temporarily: `opencode-ssh/src/types/plugin-shim.ts` for the Stage A plugin entry
- Create: `opencode-ssh/src/plugin/tools/bash.ts`
- Create: `opencode-ssh/src/plugin/tools/read.ts`
- Create: `opencode-ssh/src/plugin/tools/search.ts`
- Create: `opencode-ssh/src/plugin/tools/status.ts`
- Test: `opencode-ssh/test/unit/read-tools.test.ts`
- Test: `opencode-ssh/test/integration/remote-read-search-bash.test.ts`

**Interfaces:**
- Produces plugin tools named `bash`, `read`, `glob`, and `grep`.
- Produces diagnostic plugin tool `remote_status`.

- [ ] **Step 1: Define schemas with the current plugin package**

Use `tool` and `tool.schema` from `@opencode-ai/plugin` in every new Stage B tool. Do not import the custom plugin/Zod shim from new code; Task 8 deletes it with the legacy entry. Match current OpenCode argument names closely enough that existing model prompts remain effective.

- [ ] **Step 2: Implement permission-aware remote bash**

Before execution call `ctx.ask` with permission `bash`, the command pattern, target alias, and canonical workdir metadata. Execute once through `SshClient`, honor abort/timeout, and return bounded stdout/stderr plus exit status.

- [ ] **Step 3: Implement bounded remote reads**

Canonicalize and constrain every path. Use SFTP for files and directory listing, preserve UTF-8 BOM, reject unsupported binary content, and cap text output at 50 KiB or 2,000 lines. Images/PDFs require explicit MIME and size checks.

- [ ] **Step 4: Implement remote search**

Prefer remote `rg`. Fall back to fixed Linux command templates using `find` and `grep`; quote patterns separately and cap output before local buffering. Never search outside the canonical workdir.

- [ ] **Step 5: Add remote status**

Return:

```json
{
  "executor": "ssh",
  "targetAlias": "staging",
  "remoteWorkdir": "/srv/app",
  "connectionId": "target-id",
  "controlMaster": "healthy"
}
```

Do not report strict mode, certification, or an `ARMED` state.

- [ ] **Step 6: Verify read-side integration behavior**

Cover paths with spaces, directory reads, BOM, binary rejection, glob patterns, grep regex/include filters, command exit codes, timeout, abort, and proof that the equivalent local fixture is not used by the four overridden tools.

### Task 7: Fix Write, Edit, And Apply Patch

**Files:**
- Keep temporarily: `opencode-ssh/src/tools/write.ts`, `edit.ts`, and `patch.ts` for the Stage A plugin entry
- Create: `opencode-ssh/src/plugin/tools/write.ts`
- Create: `opencode-ssh/src/plugin/tools/edit.ts`
- Create: `opencode-ssh/src/plugin/tools/patch.ts`
- Copy and adapt: `opencode-ssh/src/bom.ts` to `opencode-ssh/src/upstream/bom.ts`
- Copy and adapt: `opencode-ssh/src/diff-utils.ts` to `opencode-ssh/src/upstream/diff-utils.ts`
- Test: `opencode-ssh/test/unit/edit.test.ts`
- Test: `opencode-ssh/test/unit/patch.test.ts`
- Test: `opencode-ssh/test/integration/remote-mutations.test.ts`

**Interfaces:**
- Produces plugin tools named `write`, `edit`, and `apply_patch`.
- Consumes: `FileTransaction` from Task 5.

- [ ] **Step 1: Write edit regression tests before adapting upstream code**

Cover exact unique replacement, duplicate rejection, `replaceAll`, CRLF, BOM, missing files, and current OpenCode fuzzy matching. Include a regression proving that matching only the first and last lines with unrelated middle content is rejected.

- [ ] **Step 2: Write patch operation tests**

Cover add, update, multi-file update, move, and actual deletion. A conflict in any source input must prevent every upload from starting. Delete must make the remote path absent rather than empty.

- [ ] **Step 3: Implement write and edit on one fresh remote snapshot**

Download the current file, calculate the new content and unified diff, call `ctx.ask` with permission `edit`, then perform one conflict-checked transaction. Do not use upstream's global `pullAll()`/`pushAll()` behavior.

- [ ] **Step 4: Replace the unsafe edit threshold**

Use the matching behavior from the installed OpenCode version under test, including its non-zero fuzzy threshold and disproportionate-match guard. Record the source OpenCode version in a code comment next to the constants and in the test name.

- [ ] **Step 5: Implement patch validation before mutation**

Parse every operation into an immutable plan, canonicalize all source/destination paths, read every source, validate every chunk, calculate one complete diff, ask once, then execute. Use `FileTransaction.delete` for deletion and `FileTransaction.move` for moves.

- [ ] **Step 6: Return honest metadata**

Every mutation result must include affected remote paths, additions/deletions, `executor: "ssh"`, alias, workdir, and target ID. Do not claim OpenCode snapshot/revert support.

- [ ] **Step 7: Run mutation tests**

Run:

```bash
npm run test:unit
npm run test:integration
```

Expected: conflict, delete, move, BOM/CRLF, duplicate edit, and interrupted upload tests pass.

### Task 8: Wire Plugin Context, Prompt Append, And Cleanup

**Files:**
- Replace: `opencode-ssh/src/index.ts` with `opencode-ssh/src/plugin/index.ts`
- Delete: `opencode-ssh/src/config.ts`
- Delete: `opencode-ssh/src/ssh-pool.ts`
- Delete: `opencode-ssh/src/path-mapper.ts`
- Delete: `opencode-ssh/src/sync-engine.ts`
- Delete: `opencode-ssh/src/manifest.ts`
- Delete: `opencode-ssh/src/tools/`
- Delete: `opencode-ssh/src/types/plugin-shim.ts`
- Delete: `opencode-ssh/src/bom.ts`
- Delete: `opencode-ssh/src/diff-utils.ts`
- Delete: `opencode-ssh/src/prompts/`
- Delete: `opencode-ssh/src/remote-system-prompt.ts`
- Delete: `opencode-ssh/scripts/postbuild.cjs`
- Create: `opencode-ssh/src/plugin/system-context.ts`
- Modify: `opencode-ssh/src/cli.ts`
- Modify: `opencode-ssh/package.json`
- Modify: `opencode-ssh/package-lock.json`
- Modify: `opencode-ssh/tsconfig.json`
- Test: `opencode-ssh/test/integration/plugin-registration.test.ts`
- Test: `opencode-ssh/test/integration/system-context.test.ts`
- Test: `opencode-ssh/test/integration/launcher-lifecycle.test.ts`

**Interfaces:**
- Consumes all Stage B transport and tool modules.
- Produces the complete practical `opencode-ssh` lifecycle.

- [ ] **Step 1: Register familiar tool names and write the ready handshake**

The plugin must return:

```ts
{
  tool: {
    bash,
    read,
    write,
    edit,
    glob,
    grep,
    apply_patch,
    remote_status,
  },
}
```

Write the ready file only after context validation and tool construction succeed. Remote mode is active only when the complete launcher environment is present; otherwise the plugin returns no remote tools.

- [ ] **Step 2: Switch package entry points and remove legacy dependencies**

After the new plugin integration test passes, change package metadata to:

```json
{
  "main": "dist/plugin/index.js",
  "exports": {
    ".": "./dist/plugin/index.js"
  },
  "bin": {
    "opencode-ssh": "dist/cli.js"
  }
}
```

Delete the legacy modules listed in this task, remove `ssh2`, `@types/ssh2`, the direct Zod 3 dependency, and the postbuild script, and remove the `@opencode-ai/plugin` path mapping from `tsconfig.json`. Change the build script back to `tsc -p tsconfig.json`, regenerate `package-lock.json`, and run `npm run build` immediately to catch any remaining legacy imports.

- [ ] **Step 3: Append, never replace, system context**

Use `experimental.chat.system.transform` to append one compact element containing alias, canonical workdir, and an instruction that the seven overridden project tools operate over SSH. Preserve every existing system element and every other plugin's output.

- [ ] **Step 4: Optionally include only the root remote AGENTS.md**

If `<remote-workdir>/AGENTS.md` exists, read at most 32 KiB and append it as clearly labeled remote project instructions. Absence or read failure must be reported through `remote_status`, not silently replaced with local instructions. Nested remote instruction discovery remains out of scope.

- [ ] **Step 5: Implement launcher cleanup**

Use one `AbortController`, register SIGINT/SIGTERM once, wait for the OpenCode child, then close the ControlMaster and remove the ready file/socket in reverse startup order. Cleanup must be idempotent.

- [ ] **Step 6: Test normal configuration coexistence**

Integration tests must prove:

```text
- existing system prompt entries survive;
- another test plugin still loads;
- a synthetic local-safe/MCP-style tool remains registered;
- the seven project tools resolve to this plugin during the tested OpenCode version;
- missing ready handshake terminates the launcher;
- normal exit and Ctrl-C close the master.
```

This coexistence test does not convert other plugins or MCP tools to remote execution.

- [ ] **Step 7: Run the complete Stage B suite**

Run:

```bash
npm run build
npm run test:unit
npm run test:integration
```

Expected: all commands exit 0.

### Task 9: Package And Document The Practical Guarantee

**Files:**
- Create: `opencode-ssh/README.md`
- Create: `opencode-ssh/SECURITY.md`
- Modify: `opencode-ssh/package.json`
- Test: `opencode-ssh/test/smoke/package-install.test.ts`

**Interfaces:**
- Produces an installable package and an operator workflow that does not overstate isolation.

- [ ] **Step 1: Write a clean-install smoke test**

Pack the project, install into an empty temporary prefix, run `opencode-ssh --help`, and verify the CLI can resolve its bundled plugin entry. Do not contact a real SSH host in the package-install test.

- [ ] **Step 2: Document installation and use**

README must include:

```text
- Node.js and system OpenSSH prerequisites.
- Linux remote requirement, including realpath and SFTP.
- OpenSSH alias examples.
- opencode-ssh staging /srv/app examples.
- How normal OpenCode config, provider auth, VPN/proxy, Serper, plugins, and MCP remain local.
- How to run the opt-in real-SSH smoke checklist.
- Runtime/cache paths and cleanup.
```

- [ ] **Step 3: Document the actual security boundary**

SECURITY.md must state prominently:

```text
The seven overridden project tools are SSH-backed when the launcher handshake succeeds.
Other OpenCode tools, plugins, MCP servers, LSP, formatters, TUI file APIs, and OpenCode internals remain local.
This package does not provide a sandbox or a universal no-local-execution guarantee.
```

Also document host-key verification through system OpenSSH, no command retries, conflict detection, atomic replacement, cancellation limitations, and why sudo passwords are unsupported.

- [ ] **Step 4: Add package supply-chain controls**

Commit-ready package contents must include the lock file, exact runtime dependencies, LICENSE, UPSTREAM.md, README, SECURITY, `dist`, and source maps if enabled. Exclude test credentials, runtime state, mirrors, audit files, and fit-test secrets.

- [ ] **Step 5: Run final verification**

Run:

```bash
npm ci
npm run build
npm run test:unit
npm run test:integration
npm run test:smoke
npm pack --dry-run
```

Expected: all commands exit 0 and package contents contain no credentials or runtime artifacts.

## Final Acceptance Checklist

- [ ] Stage A report records whether the original plugin already satisfies the user's workflow.
- [ ] Stage B was started only after explicit user approval.
- [ ] `opencode-ssh <alias> [workdir]` delegates SSH configuration and host verification to system OpenSSH.
- [ ] Ordinary OpenCode provider auth, proxy/VPN environment, plugins, MCP servers, and Serper remain available locally.
- [ ] A matching plugin-ready handshake is required before the launcher remains open.
- [ ] `bash`, `read`, `write`, `edit`, `glob`, `grep`, and `apply_patch` use the selected SSH target in the tested OpenCode version.
- [ ] Documentation clearly says other tools may execute locally.
- [ ] Canonical remote paths outside the workdir require `external_directory` permission; `/` is treated as the full remote scope.
- [ ] Remote writes detect conflicts and use same-directory atomic replacement.
- [ ] Delete removes the remote path and move performs a real rename.
- [ ] Mutating remote commands are never automatically retried.
- [ ] System context is appended rather than replaced.
- [ ] Exit and interruption close the OpenCode child and ControlMaster.
- [ ] Clean package installation works without the source checkout.
