# OpenCode SSH

Run OpenCode and its TUI locally while the normal project tools operate on a
remote machine through system OpenSSH. The remote host needs no OpenCode,
Node.js, plugin, or agent installation.

Tested against OpenCode 1.18.18. Before every SSH connection, the launcher asks
the installed OpenCode to load this server plugin in an isolated local check and
requires its reported version to match nonce-bound loader runtime evidence.
Callable session lookup is mandatory for every launch. Safe same-launch Task
resume is package-controlled and enabled only for explicitly release-qualified
OpenCode 1.18.18; another loader/runtime-compatible version keeps fresh
foreground direct Task but rejects `task_id` before upstream execution.

Final 2026-08-28 evidence includes the exact 1.18.18 six-scenario resume gate
and installed real-Task fake-SFTP mutation. Formal direct-child release remains
incomplete only for real-SSH two-sibling mutation and real permission-UI and
direct-child TUI behavior. The real-SSH suite was not run.

```bash
opencode-ssh staging /srv/app
opencode-ssh staging /
```

The launcher passes `staging` unchanged to `ssh` and `sftp`. OpenSSH remains
responsible for `~/.ssh/config`, keys, `ssh-agent`, host verification,
`ProxyJump`, and connection algorithms.

## Requirements

- Node.js 22.22.2 or newer.
- OpenCode installed locally. Version 1.18.18 is the tested baseline.
- A POSIX local host. Current release evidence is Linux x86_64; macOS is an
  intended local platform but is not part of the recorded hardening evidence.
  Windows users should run the launcher in WSL rather than native Windows.
- System `ssh` and `sftp` clients.
- A GNU/Linux SSH target with SFTP and POSIX `sh`. Startup and project tools use
  `pwd -P`, `hostname`, `whoami`, `uname`, GNU `realpath -e --`, GNU `stat -c`,
  GNU `mv -fT --`, and the usual GNU `mkdir`, `rmdir`, `chmod`, `rm`, `cat`,
  `ls`, `dd`, `od`, `grep`, `find`, `sort`, and `cut` behavior. `remote_status`
  invokes `hostname; whoami; pwd -P` internally. `git`, `file`, and `rg` are
  optional; Git detection degrades to non-Git, and file and search tools have
  documented fallbacks. `head` is not required because remote `AGENTS.md` is
  not read automatically. A macOS remote is not supported by this command
  contract.

## Install

```bash
npm run install:verified
```

This installs the locked dependencies, runs the local test suite, builds and
installs `opencode-ssh`, then runs the installed compatibility self-test. It
requires OpenCode, `ssh`, and `sftp`, but no SSH target or provider. See the
complete [installation and usage guide](docs/installation-and-usage.md) for
OpenCode installation, the optional prompt-free `remote_status` permission, SSH
setup, a fixed-target local script, project safety instructions, and
first-launch verification.

## SSH Configuration

Configure and verify the target with ordinary OpenSSH first:

```sshconfig
Host staging
    HostName staging.example.invalid
    User deploy
    IdentityFile ~/.ssh/id_ed25519
```

```bash
ssh staging
ssh staging 'pwd -P'
```

The launcher disables SSH account-password and keyboard-interactive fallback.
It does not use `BatchMode`, so OpenSSH may still ask for host-key confirmation
or a private-key passphrase. When the key is loaded in `ssh-agent`, the launcher
inherits `SSH_AUTH_SOCK` and normally asks nothing.

## Usage

The command accepts exactly an SSH alias and an absolute remote workdir:

```bash
opencode-ssh <ssh-alias> <absolute-remote-workdir>
```

There is no OpenCode argument forwarding. Model, provider, permission, plugin,
and MCP settings come from the normal OpenCode configuration.

Before SSH startup, the launcher checks the selected local `opencode --version`
and runs `opencode debug config` with an isolated HOME, config, and workspace.
Probe protocol v3 must load this package's server plugin and atomically publish
a nonce-bound marker containing the loader runtime version, its observation
source, and callable `client.session.get`. The selected version must exactly
match the loader runtime version. Missing lookup or malformed, missing, or
mismatched runtime evidence blocks launch before launch paths, ControlMaster, or
SSH. A different identified version may continue only when all those loader
checks pass; it prints a warning, keeps fresh foreground direct Task, and has
resume disabled. Only explicitly release-qualified 1.18.18 enables resume.
Generated system context states the launch decision. This check does not observe
TUI rendering, so run the documented manual TUI checks before relying on a new
version. See the
[automatic compatibility preflight](docs/installation-and-usage.md#automatic-compatibility-preflight)
for the exact checks, regression coverage, and intentional limitations.

The v3 loader marker is target-free and opens no SSH connection. Normal
production initialization is a separate boundary: after the launcher has
started the ControlMaster and canonicalized the workdir, the plugin rechecks
callable `client.session.get` and runtime health/version through the OpenCode
host SDK's configured transport. That recheck occurs before launch ownership,
mirror creation, package SSH pool and bootstrap commands, or ready publication,
but it does not precede the ControlMaster or workdir-canonicalization SSH already
performed.

OpenCode 1.18.18 and 1.18.23 provide a legacy PluginInput client without public
`client.global.health`. The observer prefers that public method if a future host
exposes it. Otherwise it requires root `client`, `client.global`, and
`client.session` to share the same own `_client` transport and invokes
`_client.get({ url: "/global/health" })`. SDK envelopes must contain real
`Request` and `Response` objects for a successful GET, status 200, and an exact
`{ healthy: true, version }` payload matching the selected/loader runtime. It
never raw-fetches `PluginInput.serverUrl` and never trusts fallback
`localhost:4096`.

The target-free compatibility probe runs actual `debug config`; it does not
invoke TUI, a model, Task, or SSH. Upstream's normal no-argument TUI design uses
OpenCode's configured in-process SDK transport, and the production launcher
starts that TUI. Its plugin health recheck uses the host SDK transport but does
not itself invoke a model, Task, or permission UI or certify visual TUI
behavior. Automated release evidence directly covers target-free `debug config`
plus decoys and a hermetic SDK transport, not default no-argument TUI. Serve
evidence is listener-backed. Production never falls back to an executable
version check. The target-free compatibility probe alone may use strict
`process.execPath --version`, only when no health transport exists; failure or a
malformed response from an available transport remains fatal.

Concurrent config calls are validated as a batch before one nonce-bound ready
publication. A config failure or disposal is terminal, and pool closure starts
immediately on disposal. After first observing ready, the launcher waits 25 ms
and re-reads and revalidates the marker. Ready proves this startup boundary, not
perpetual plugin liveness. Full same-launch resume behavior belongs to the
six-scenario installed-Task release gate, not a model call on every startup.

The terminal reports `checking`, `testing`, `passed`, and `starting SSH` while
the launcher is busy. `opencode-ssh self-test` runs the same local check without
an SSH alias, remote host, project configuration, or provider and reports Task
resume as enabled or disabled. The verified installation runs it once to
initialize a private probe config; later checks normally take a few seconds.

Global configuration under `~/.config/opencode` and absolute explicit config
paths are preserved. Caller-directory project config (`opencode.json` or
`.opencode/`) is intentionally not discovered because OpenCode starts in the
stable launcher workspace rather than the directory where the command was
typed. Put settings needed by remote sessions in global config or an absolute
`OPENCODE_CONFIG` file. The launcher automatically adds the installed
[`opencode-ssh-safety.md`](opencode-ssh-remote-use/opencode-ssh-safety.md) to the
root and every direct child session's instructions without replacing existing
instructions. No copy, link, or remote project setup is required. Remote root
`AGENTS.md` is not read or injected at startup. After completing package
preflight, a user or session may explicitly read it with the normal SSH-backed
`read` tool and applicable OpenCode permissions.

The remote workdir is the initial project root and stable session identity. It
is not a chroot:

- File tools request `external_directory` permission for direct paths outside
  the workdir.
- An explicit external `bash.workdir` requests the same permission.
- Arbitrary shell text such as `cd /etc && ...` is governed by the normal
  `bash` permission because shell paths cannot be parsed reliably.
- Each bash call is independent, so `cd` does not persist.
- `/` is valid and makes the entire remote filesystem the project scope.

All operations still run with the SSH user's Unix permissions. Use explicit
`sudo -n` shell commands for administration. SFTP-backed `read`, `write`,
`edit`, and `apply_patch` do not become root through sudo.

## Control Classification

| Class | What it covers |
| --- | --- |
| Package-enforced | One-step per-session `remote_status` preflight with embedded remote identity validation, project-tool and root-Task gates, root-only foreground Task, child/background rejection, depth 0/1 policy, startup-qualified same-launch resume with an ownership registry and atomic admission, `mcp.remote` collision rejection, SSH/SFTP no-retry behavior, and file transaction checks. |
| OpenCode host policy | Tool visibility and evaluation of configured global, per-agent, and session permission rules. This package does not replace OpenCode's permission engine. |
| Prompt/operator guidance | The injected safety document, disjoint child scopes, reviewed `sudo`, final remote verification, and manual fit procedures. Guidance is not a sandbox control. |

Same-process plugins, direct SDK/session API callers, and same-UID local
processes are trusted computing-base members. They can inspect launch state or
bypass package tools and package-observed Task hooks; this package does not
sandbox a hostile trusted plugin. An enabled configuration entry named
`mcp.remote` is rejected because it can collide with `remote_status`, but that
specific check is not general plugin isolation.

## Direct Task Children

After the root completes package preflight, it may use OpenCode's local Task
implementation to launch multiple foreground direct children sequentially or
concurrently. Depth limits nesting, not sibling count. An absent or positive
`subagent_depth` becomes one; explicit zero remains zero. A package runtime
guard rejects every Task call from a child even if a trusted later config hook
re-exposes Task. Background Task remains unsupported, and the launcher forces
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false`. OpenCode, Task orchestration,
and child-session state remain local. Model/provider requests follow the
configured provider and may leave the machine.

Task resume is package-controlled rather than general OpenCode behavior.
Callable session lookup is required for every launch. Only explicitly
release-qualified OpenCode 1.18.18 enables resume; another compatible loader and
runtime version still permits fresh foreground direct Task but rejects every
`task_id` before upstream execution. Generated system context reports the
decision. When startup qualification enables resume, all of these rules apply:

- The root may use only the exact `task_id` returned for a successfully
  completed foreground direct child created by that same root in the current
  `opencode-ssh` launch, and it must use the same `subagent_type`.
- Fresh-child admission is one-shot for that root and Task call. Registration
  binds the root permission fingerprint and security epoch before and after the
  Task, requires unchanged root evidence, preserves every inherited SSH-project
  deny, and requires an explicit child agent matching `subagent_type` plus an
  explicit permission array.
- A launch-local ownership registry records only those validated successful
  children. Cross-launch, foreign-root, unknown or invented, child-initiated,
  background, busy, failed, canceled, and uncertain resumes are not eligible.
  Unknown IDs are rejected before upstream OpenCode can reinterpret them as
  fresh children.
- Before atomic reservation, the package revalidates the exact launch, caller
  root, direct child, `subagent_type`, observed agent, root and child permission
  fingerprints, and relevant security epochs. Only one resumer can be admitted.
- Admission clears the child's old package preflight. The resumed child must
  complete a full new package `remote_status` preflight before any project tool
  and before the registry can release that child for another sequential resume.
  The tool runs and validates `hostname; whoami; pwd -P` in the canonical launch
  workdir internally.
- Once reserved, a failed, missing, malformed, aborted, canceled, or uncertain
  admission or completion permanently locks that child for the launch. Do not
  retry that ID; start a fresh direct child and include the required context.
- Exact model continuity is not promised.

The package defaults `remote_status` to `ask` only when neither global policy
nor the configured `explore` policy explicitly matches it. Stable global and
per-agent `allow`, `ask`, or `deny` rules remain supported. Package permission
requests provide no persistent `always` choice, so an `ask` can prompt on each
call. In OpenCode 1.18.18, parent session `ask` rules are not inherited by Task
children. The package therefore rejects delegation when a root-session `ask`
matches an SSH project permission and directs the user to global or per-agent
policy. Do not rely on parent session `allow`/`ask` propagation; inherited
denies remain restrictive.

Task security epochs observe both event pairs: OpenCode v2 `permission.asked`
followed by `permission.replied` carrying `requestID`, and legacy
`permission.updated` followed by `permission.replied` carrying `permissionID`.
A malformed or unknown relevant delivery invalidates security evidence fail
closed. The fire-and-forget permission event hook remains non-throwing rather
than creating a detached rejection.

Package code gives every session independent preflight state. Each session must
complete it before that session's package project tools; the root additionally
needs it before Task. Fresh-child registration validates owner-before/after
evidence and child metadata, agent, permissions, and inherited denies, not an
unconditional child preflight. A fresh child that returns without using package
project tools can therefore register without completing preflight. Operator
guidance still directs every child to preflight before remote project work.
Resume is stricter: admission clears the child's old state, and successful
registry release requires the resumed child to renew preflight.

Each `remote_status` attempt advances a per-session generation; a new generation
revokes prior evidence and aborts active package project SSH, SFTP, and mutation
leases. The tool internally runs `hostname; whoami; pwd -P` and requires a
zero-exit, non-truncated, exact three-line result with non-empty hostname/user
and the canonical launch workdir. A denied, failed, canceled, unhealthy,
malformed, or mismatched attempt leaves package project tools and root Task
blocked until a new `remote_status` fully succeeds. Completed remote commits and
already-admitted upstream Task execution are not retroactively undone. Parent
evidence is never copied. Package Bash is not a preflight mechanism; built-in
`explore` cannot use it, although its package `read`, `glob`, and `grep` tools can
operate after preflight subject to host policy.

Read-only siblings may overlap. Mutation-capable siblings must have disjoint
path scopes. Package file mutations share one operation-wide mutex in one plugin
instance, but same-path sibling editing is unsupported. Bash, MCP, other
plugins, another module instance, and non-cooperating remote writers bypass that
mutex. Operator guidance requires the root to wait for every fresh and resumed
run, repeat `remote_status` and changed-path or diff verification after resumed
work, and report each run's changes, failures, cancellations, and uncertainties.
A settled resume does not prove that real remote descendants have settled.

## Remote Tools

The plugin overrides these familiar OpenCode tools:

| Tool | Execution |
| --- | --- |
| `bash` | One-shot POSIX `sh` command through the OpenSSH ControlMaster |
| `glob`, `grep` | Remote command through the ControlMaster |
| `read`, `write`, `edit`, `apply_patch` | Private local mirror plus system SFTP |
| `remote_status` | Target and ControlMaster health, remote identity validation, and session preflight completion |

Task is intentionally absent from this table because it is local OpenCode
orchestration, not an SSH-backed project tool.

Other tools, plugins, MCP servers, LSPs, formatters, provider clients, and TUI
internals execute from the local OpenCode environment. Provider requests may
leave the machine according to provider configuration. This package is not a
sandbox and does not guarantee that every OpenCode operation is remote.

### Permission Timing

Package preflight rejects project tools before path resolution, baseline reads,
SSH/SFTP preparation, or their tool-specific permission request.
Starting `remote_status` advances the session generation, invalidates old
preflight, and aborts active package project leases. Its own permission is
requested before the internal fixed `hostname; whoami; pwd -P` SSH command; no
separate preflight `bash` permission or Bash tool call occurs.
Once preflight is complete, path canonicalization can use SSH before the
`bash`, `read`, `glob`, or `grep` prompt; write, edit, and patch also pull current
content before the `edit` prompt so OpenCode can present a diff. A lexical path
outside the workdir asks for `external_directory` before its canonicalization
probe. No file mutation or requested Bash command runs before its corresponding
approval. Preparatory content is held in the private launch mirror until cleanup
and is accessible to trusted same-UID local processes.

### File Replacement

The package's one-plugin file path uses an abort-aware operation queue,
per-file content baselines, repeated canonical-path checks, token-owned
deterministic locks, a random mode-0600 sibling temporary, and GNU
`mv -fT --` replacement. Revalidation narrows but cannot eliminate a final
rename race from non-cooperating writers.

Only file content and numeric mode are carried forward. Existing files use the
mode observed at final validation; new files are mode `0600`. Owner, group,
ACLs, xattrs, capabilities, timestamps, hard-link identity, and other metadata
are not preserved. Each file replacement is atomic, but a multi-file operation
is not globally atomic. A typed partial-result error distinguishes committed,
failed, uncertain, and unattempted paths; there is no automatic rollback or
retry. Unknown locks are not deleted automatically, and cleanup errors identify
possible lock or temporary artifacts.

### Live Bash Output

The implementation publishes incremental stdout and stderr from agent calls to
the SSH-backed `bash` tool to the existing OpenCode Bash card contract while the
command runs. Automated publication and settlement tests pass. Manual fit
testing on the pinned OpenCode 1.18.18 TUI confirmed incremental rendering and
retained output across success, failure, timeout, cancellation, and overflow;
see the [fit report](docs/upstream-fit-report.md).

The published preview is a replacement tail, not a full transcript: it retains
the latest 30,000 characters and includes a truncation marker after older
preview text is removed. The final model-facing capture is independent, remains
limited to 1 MiB per stream, and can be further truncated by OpenCode.

Manual shell commands entered in the TUI with a leading `!` remain local and
are unrelated to this feature. The remote Bash tool provides no PTY or
interactive stdin. A
program that block-buffers output because it sees a pipe will not become live
automatically; use a program-supported unbuffered mode when appropriate.

Timeout or cancellation can leave remote descendants alive. Visible partial
output does not authorize an automatic retry; inspect remote state first.

## Lifecycle

The launcher:

1. Requires the pre-SSH protocol-v3 loader marker, exact selected/loader runtime
   version agreement, and callable session lookup, then decides whether the
   exact 1.18.18 launch qualifies resume.
2. Starts a private OpenSSH ControlMaster and resolves the canonical remote
   workdir only after that target-free check passes.
3. Creates the stable local OpenCode workspace and launches OpenCode with the
   safety instructions and package-root plugin in `OPENCODE_CONFIG_CONTENT`.
4. Before claiming launch ownership, creating the plugin mirror, opening its SSH
   pool, or running bootstrap commands, the normal plugin again requires
   callable session lookup and matching runtime health/version through the host
   SDK's configured transport.
5. Builds tools, runs bootstrap `uname` and optional Git SSH, and validates each
   concurrent config batch before publishing one nonce-bound ready marker.
6. Waits 25 ms after first observing ready, then re-reads and validates the same
   marker while continuing to supervise the ControlMaster.
7. Supervises OpenCode and attempts cleanup of the ready marker, mirror, master,
   socket, and signal listeners.

Within one loaded module, only one active production plugin factory may own a
launch ID. Config failure and disposal are terminal. Disposal starts pool close
immediately; close rejects new SSH/SFTP calls, aborts active slaves, and waits
for settlement. The ready marker proves the validated startup boundary, not
perpetual plugin liveness. On POSIX local hosts, the owned OpenCode, version, and
compatibility-probe children explicitly request process groups with bounded
TERM/KILL settlement; other local children are not covered by that claim.
SSH/SFTP slave settlement is the separate package-pool behavior described above.
Cleanup failures are surfaced (or warned while preserving signal exit status).
These controls do not protect against a hostile duplicate module instance and
do not prove termination of arbitrary real remote descendants.

Runtime data is private to the local user:

```text
${XDG_STATE_HOME:-~/.local/state}/opencode-ssh/<target-id>/
${XDG_CACHE_HOME:-~/.cache}/opencode-ssh/<target-id>/
${XDG_RUNTIME_DIR:-/tmp}/opencode-ssh-<uid>/
```

## Startup Diagnostics

Startup diagnostics are best-effort JSON Lines at:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/opencode-ssh/logs/opencode-ssh-YYYY-MM-DD.jsonl
```

The logger uses one file per UTC day. It has no background retention timer:
logging activity may prune at most once per UTC day per logger instance, and
when maintenance runs it keeps the current UTC day plus four previous days.
Stale matching files can remain if no later logging occurs. The logger creates
directories as `0700` and regular files as `0600`, and opens files with append,
no-follow, and nonblocking flags. A record is limited to 64 KiB. Each call uses
a 500 ms deadline for expected local-state I/O, but that deadline
does not cancel an already issued native filesystem request; work may finish
later on pathological or non-local filesystems. Logging failure never replaces
the launch, probe, cleanup, or disposal result.

On failure, the CLI prints this only after at least one log write succeeded:

```text
opencode-ssh: diagnostics: <path> (startupID <id>)
```

Filter the daily JSONL file by the displayed ID:

```bash
grep -F '"startupID":"<id>"' "<path>"
jq -c 'select(.fields.startupID == "<id>")' "<path>"
```

Instrumentation is currently limited to compatibility version/probe, launcher
SSH/canonicalization/OpenCode/ready/cleanup, probe health/marker, and production
plugin lookup/health/source/version/mirror/pool/bootstrap/config/ready/disposal.
Records correlate first by non-secret `startupID`, then `launchID` and
`targetID`. `targetID` is the stable pseudonymous SHA-256 of alias plus canonical
workdir. It is not secret and is not claimed irreversible against guessed alias/
workdir inputs. Production emits stable failure codes and reviewed fields, not
raw errors/messages. It never logs raw target alias/canonical workdir or project/
local paths; commands or argv; environment/config; nonce/token/credential values
or their hashes; session/task/permission IDs; output/response bodies; or model/
provider data. The only displayed path is the local diagnostic path above.

Repository code can reuse `createFileLogger` from the relative `./logger.js`-
style NodeNext path. Use stable event names matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`, allowlist non-secret fields, and start critical
cleanup or disposal before awaiting a diagnostic write. This is startup
diagnostics, not general project/tool/session telemetry.

## Testing

```bash
npm run lint
npm run lint:test
npm run build
npm run test:unit
npm run test:integration
npm run build && npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose
OPENCODE_TASK_TEST_BINARY=/absolute/path/to/opencode-1.18.18 npm run test:task-baseline
npm test
npm run test:smoke
npm pack --dry-run
node dist/cli.js self-test
```

`test:task-baseline` requires the explicit executable and accepts only exact
OpenCode 1.18.18 with all six scenarios, including safe same-launch resume,
passing with zero failed, skipped, or todo scenarios. Final evidence recorded on
2026-08-28 is:

- `npm run lint` passed, and `npm run build` passed repeatedly.
- The actual installed OpenCode 1.18.25 self-test passed; Task resume was
  disabled.
- The focused merged diagnostics/lifecycle gate passed 100/100.
- The complete installed-loader gate passed 3/3 with zero skips. Its actual
  target-free self-test held valid health decoys on every resolved localhost
  loopback address at port 4096, saw zero connections and requests, and observed
  `client._client.get`. Real-serve production activation/disposal and correlated
  startup logs also passed.
- Ordinary installed OpenCode 1.18.25 passed all 6/6 Task scenarios. Resume was
  disabled, every `task_id` was rejected before upstream execution, and the
  fresh-Task fallback passed.
- The exact baseline binary
  `/tmp/opencode/opencode-ai-1.18.18/node_modules/.bin/opencode` resolved to
  `/tmp/opencode/opencode-ai-1.18.18/node_modules/opencode-ai/bin/opencode.exe`.
  The baseline accepted the exact six-name manifest: 6 passed, 0 failed, and 0
  skipped; the resume scenario was enabled.
- The exact sixth scenario took `task_id` from the root model-visible Task
  result, cross-checked the actual direct child, proved the identical package
  write was blocked before renewed preflight with zero SSH/SFTP preparation,
  then completed one renewed `remote_status` and atomic fake-SFTP get, private
  put, and `mv -fT --` with the expected final content.
- Every automated root, child, and resumed-child preflight used one
  `remote_status` SSH identity command and no separate Bash preflight.
- `npm test` passed 32 unit/integration files and 453/453 tests, then 2 smoke
  files/tests passed 2/2.
- `npm pack --dry-run` passed with 166 files listed, and `git diff --check`
  passed.
- The actual installed-loader integration used a real OpenCode serve process on
  a dynamically selected, test-only IPv4-loopback port. The host-configured SDK
  transport uses that process-owned listener in serve mode; the harness does not
  make a fixed fixture port a production input or trust boundary. It is separate
  from the no-listener pre-SSH `opencode debug config` probe. Its transport
  fixtures and the Task suite remain fake SSH/SFTP, not real-host evidence.

Real SSH was not run. The automated no-listener case is target-free `debug
config` plus a hermetic SDK path, not default no-argument TUI automation. These
gates do not prove visual TUI, real permission-UI, model, or real-SSH behavior.

Use a separate non-production SSH target for manual mutation tests. The current
`npm run test:real` suite exists, mutates its configured disposable target, and
requires reviewed passwordless `sudo -n id -u`; it is not Task, OpenCode, TUI,
or permission-UI evidence. The opt-in checklist is separate from default
real-SSH-free tests in
[`docs/upstream-fit-checklist.md`](docs/upstream-fit-checklist.md).
The actual-loader and focused Task integration tests run with the installed
OpenCode and skip only when no `opencode` executable exists. Loader success does
not replace the Task test. Formal direct-child release remains incomplete only
for the disposable real-SSH two-sibling mutation gate and real permission UI and
direct-child TUI checks. `npm run test:real` was not run on 2026-08-28. The
historical five live-output checks in the
[installation guide](docs/installation-and-usage.md#manual-tui-checks) cover
Bash-card rendering, not these direct-child boundaries.

## Current Trial Limitations

- File transfers are full-file rather than delta-based.
- Package file changes are per-file atomic, not globally atomic. Multi-file
  failures report committed, failed, uncertain, and unattempted paths; no
  rollback or retry is automatic.
- Existing numeric mode is preserved from final validation and new files use
  `0600`; ownership, group, ACL, xattr, capability, timestamp, hard-link, and
  other metadata semantics are not preserved.
- `apply_patch` delete and move operations are rejected until atomic remote
  delete/move support is implemented. Use explicit reviewed shell commands.
- Sibling mutation scopes must be disjoint. Same-path concurrent editing is not
  supported, even though conflict and lock checks still apply as backstops.
- Cancellation settles tested local Task/session and SSH slave boundaries;
  remote descendants may survive and require remote inspection.
- Mirrors are launch-scoped; concurrent launchers do not share local files.
- Real-SSH direct-sibling mutation and real permission-UI/direct-child TUI
  behavior remain unverified release boundaries. The exact six-scenario gate
  and installed real-Task fake-SFTP mutation are complete.

See [SECURITY.md](SECURITY.md) for the exact boundary.

## Upstream And License

This work adapts `zz6zz666/opencode-remote-code` at the commit recorded in
[UPSTREAM.md](UPSTREAM.md). It is distributed under the MIT license.
