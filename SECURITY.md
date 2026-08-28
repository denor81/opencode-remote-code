# Security Boundary

After package preflight, package `bash`, `read`, `write`, `edit`, `glob`, `grep`,
and `apply_patch` are SSH-backed. Package `remote_status` reports the selected
alias, canonical workdir, target ID, and connection health; it also executes and
validates the fixed `hostname; whoami; pwd -P` remote identity command and
completes that session's preflight.

Other OpenCode tools, external plugins, MCP servers, LSPs, formatters, provider
clients, TUI file APIs, and OpenCode internals execute from the local OpenCode
environment. Provider requests may leave the machine according to the user's
provider configuration. This package is not a sandbox and does not provide a
universal no-local-execution or no-egress guarantee. OpenCode Task orchestration
and direct-child session state are local; model/provider requests follow provider
configuration. Task is not an SSH-backed project tool.

The launcher automatically adds the installed
[`opencode-ssh-safety.md`](opencode-ssh-remote-use/opencode-ssh-safety.md) to the
root and every direct child session's instructions. Remote projects do not need
a copy or an `AGENTS.md` reference. That document is operational guidance, not
sandbox enforcement.

Remote root `AGENTS.md` is not read or injected automatically. A preflighted
session may explicitly read it through the package `read` tool and normal
OpenCode permissions.

## Control Classes And Trust

| Class | Security meaning |
| --- | --- |
| Package-enforced | Private one-step per-session `remote_status` preflight state; project-tool and root-Task gates; root-only foreground Task; runtime rejection of child/background Task; startup-qualified same-launch resume with launch-local ownership and atomic admission; collision check for `mcp.remote`; SSH/SFTP process policy; and package file transaction checks. |
| OpenCode host policy | Tool catalogs and configured global, per-agent, and session permission decisions. The package requests permissions but does not implement or sandbox the host permission UI. |
| Prompt/operator guidance | The injected safety text, disjoint sibling scopes, reviewed administration, final remote verification, and manual release checklist. Prompt compliance is not an enforcement boundary. |

OpenCode, configured same-process plugins, direct SDK/session API callers, and
same-UID local processes are in the trusted computing base. A hostile trusted
plugin can read launch environment or hook arguments, mutate later config, call
the owned socket, or bypass package tools and package-observed Task hooks. The
package does not sandbox it. An enabled `mcp.remote` config is rejected because
its `status` tool can collide with the package `remote_status` ID; other same-name
plugin behavior remains inside this trusted boundary.

## SSH

- SSH aliases are passed to system OpenSSH as literal process arguments.
- The launcher never uses a local shell to spawn `ssh`, `sftp`, or `opencode`.
- Before SSH startup, probe protocol v3 requires the selected OpenCode to load
  the package-root server plugin through `debug config` and atomically publish a
  nonce-bound marker containing loader runtime version, observation source, and
  callable `client.session.get`. The selected `--version` must exactly match the
  loader runtime. Missing lookup or malformed, missing, or mismatched runtime
  evidence blocks startup before launch paths, ControlMaster, or SSH. The probe
  uses generated local configuration and no shell or SSH target.
- Callable session lookup is required for every launch. Only explicitly
  release-qualified OpenCode 1.18.18 enables Task resume. Another identified
  loader/runtime-compatible version may launch with resume disabled, keeps
  fresh foreground direct Task, and rejects every `task_id` before upstream
  execution.
- The v3 marker is target-free and pre-SSH. During normal production startup,
  after the launcher starts the ControlMaster and canonicalizes the workdir, the
  plugin rechecks callable session lookup and runtime health through the OpenCode
  host SDK's configured transport, then requires that version to match the
  loader evidence. This occurs before launch ownership, mirror creation, package
  SSH pool/bootstrap commands, or ready, but not before the ControlMaster and
  canonicalization SSH already used.
- OpenCode 1.18.18/1.18.23 expose no public `client.global.health`. The observer
  prefers that API if a future host makes it callable; otherwise root/global/
  session must expose one shared own legacy `_client`, which is invoked as
  `_client.get({ url: "/global/health" })`. SDK envelopes require real
  `Request`/`Response` objects, successful GET/status, an exact healthy/version
  payload, and matching selected/loader/runtime versions. The observer never
  raw-fetches `PluginInput.serverUrl` and never trusts fallback
  `localhost:4096`.
- The target-free compatibility probe runs actual `debug config` and does not
  invoke TUI, a model, Task, or SSH. Upstream's default no-argument TUI design
  uses OpenCode's configured in-process SDK transport, and the production
  launcher starts that TUI. Its plugin recheck uses the host SDK transport but
  does not itself invoke a model, Task, or permission UI or certify visual TUI
  behavior. Automated no-listener evidence directly covers target-free `debug
  config` plus decoys and a hermetic SDK transport, not default TUI; serve
  evidence is listener-backed. Production has no executable fallback. The
  target-free probe may use strict `process.execPath --version` only when no
  actual health transport exists; failure or a malformed response from an
  available transport is fatal and cannot fall back.
- Concurrent config calls are batch-validated before one nonce-bound ready
  publication. Config failure and disposal are terminal; pool closure begins
  immediately on disposal. The launcher waits 25 ms after first observing ready,
  then re-reads and revalidates the marker. Ready proves this startup boundary,
  not perpetual plugin liveness.
- `~/.ssh/config`, `known_hosts`, `ssh-agent`, key passphrases, and `ProxyJump`
  remain under OpenSSH control.
- SSH password and keyboard-interactive authentication are disabled.
- The package does not store SSH or sudo passwords and creates no remote
  askpass script.
- Remote commands are never automatically retried after spawn.

## Direct Task Children

Only a root that completed package preflight may call Task. It may launch
multiple foreground direct siblings sequentially or concurrently. Effective
depth is zero when explicitly zero and one when absent or positive. The package
runtime guard retrieves the caller session and rejects lookup/shape failure,
every child Task call, and `background: true`. The launcher also forces
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false`. This guard is a backstop even
if a trusted later config hook changes the primary-tool catalog.

OpenCode stores global and per-agent permissions separately from the optional
session-local permission overlay. An omitted caller-root `session.permission`
is therefore normalized to an empty overlay for fingerprinting and inherited
deny projection, matching OpenCode's own `session.permission ?? []` behavior.
This does not grant permissions: global and agent policy still applies. An
explicit malformed root value, an incompatible root-session `ask`, changed root
evidence, or a child without an explicit valid permission array remains
fail-closed.

Task resume is a package capability, not a general promise about OpenCode's
`task_id` behavior. Callable `client.session.get` is a launch requirement, not
the resume discriminator. Each launch enables resume only for explicitly
release-qualified OpenCode 1.18.18; generated system context exposes the
decision. Another compatible version rejects `task_id` before upstream but
continues to allow fresh foreground direct children.

When enabled, fresh admission is one-shot for the root and Task call. The package
binds the root permission fingerprint, inherited SSH-project deny projection,
and root security epoch before upstream Task, then requires the same root
security evidence after completion. It registers only a successful, well-formed
direct child with an explicit agent matching `subagent_type`, an explicit
permission array, and every inherited SSH-project deny preserved. Replay or a
second registration for that call/child is denied. Registration does not itself
require child preflight when a fresh child returns without using package project
tools.

The in-memory registry belongs to one `opencode-ssh` launch. A resume must use
that exact child `task_id`, the same caller root, and the same `subagent_type`.
Cross-launch, foreign-root, unknown/invented, child-initiated, background, busy,
failed, canceled, and uncertain resumes are denied or ineligible. In particular,
an unknown ID is rejected in the package before upstream can reinterpret it as
a request for a fresh child.

Before reservation, asynchronous validation rechecks the exact launch, caller
root, registered direct child, `subagent_type`, observed agent, root and child
permission fingerprints, and root/child security epochs. Admission then
atomically changes the entry from ready to reserved, so only one resumer can
enter. Once reserved, failed, missing, malformed, aborted, canceled, or uncertain
admission/completion leaves the child permanently locked for that launch.
Package code does not automatically retry; start a fresh child and supply the
required context instead.

An admitted resume clears the child's old package preflight state before
upstream Task execution. The resumed child must complete a full new package
`remote_status` preflight before any package project tool and before successful
registry release. That tool runs and validates `hostname; whoami; pwd -P` in the
canonical launch workdir internally. Parent ownership, requested and observed
agent, session permissions, completion metadata, and security epochs are
checked around the run. Exact model continuity is not recorded or promised.
Trusted plugins or direct SDK/session calls that bypass the observed Task hooks
remain TCB limits.

The resolved policy adds `remote_status: ask` only when neither global nor the
configured `explore` policy explicitly matches that permission. Stable global
and per-agent policy is supported. Package permission requests other than
`external_directory` use no reusable `always` patterns, so a host-policy `ask`
can prompt for each call. A supported normalized external path offers its exact
path and descendants for `Allow always`; external paths containing literal `*`,
`?`, or `\\` are rejected because OpenCode cannot match those POSIX names
literally. OpenCode stores that
approval in memory for the current process and applies it instance-wide, so it
does not survive restart and can supersede a matching global, per-agent, or
session deny in a root or child session. Use `Allow once` where policy isolation
matters, and restart OpenCode to clear an approval that became too broad. The
separate `read`, `glob`, `grep`, `edit`, or `bash` permission is not granted by
an external-directory approval. The host authorizes the fixed internal identity
command through `remote_status`; this does not grant arbitrary package Bash.
OpenCode
1.18.18 does not inherit parent session asks into Task children. If a root
session `ask` matches `remote_status`, `bash`, `read`, `edit`, `glob`, `grep`, or
`external_directory`, package code rejects delegation and directs the operator
to global or per-agent policy. Do not claim that parent session `allow`/`ask`
rules propagate. Package Task validation preserves inherited deny arrays, but a
matching OpenCode instance-wide external-directory approval can supersede those
arrays and other matching host-policy denies until process exit.

Task security epochs consume both OpenCode v2 `permission.asked` requests and
`permission.replied` `requestID` delivery, and legacy `permission.updated` plus
`permissionID` delivery. Relevant requests/replies invalidate the affected
session epoch; malformed or unknown relevant delivery also invalidates fail
closed. The fire-and-forget event hook catches delivery errors and remains
non-throwing rather than producing a detached rejection.

Package preflight state is keyed by session ID and never copied. Package code
requires completed preflight before that session's package project tools and
also before root Task. It does not require a fresh child that used no package
project tools to preflight merely to become resumable. Operator guidance still
directs every child to preflight before remote project work. When preflight is
needed, that session calls package `remote_status` once. The tool internally
runs `hostname; whoami; pwd -P` in the canonical launch workdir.

Every `remote_status` attempt advances a per-session generation. The new
generation revokes prior evidence and aborts active package project SSH, SFTP,
and mutation leases. Preflight completes atomically only after a zero-exit,
non-truncated, exact three-line result with non-empty hostname/user and a workdir
matching the canonical launch root. Denial, cancellation, policy/transport
failure, non-zero or malformed output, or workdir mismatch leaves package
project tools and root Task code-enforced blocked until a new `remote_status`
fully succeeds. Already completed remote commits and already-admitted upstream
Task execution are not retroactively undone. Package Bash is not a preflight
mechanism. Built-in `explore` cannot use package Bash; its package read/glob/grep
calls remain subject to host policy after preflight.

Read-only siblings may overlap. Mutation-capable siblings require disjoint path
scopes; same-path concurrent editing is unsupported. One plugin instance
serializes package file transactions. Bash, MCP, other plugins, separate module
instances, and non-cooperating writers bypass that mutex. Content conflicts and
cooperative locks are backstops, not a sibling scheduler. Waiting for every
fresh and resumed run, repeating final status/diff/path checks after resumed
work, and complete reporting are operator guidance rather than package
enforcement. A settled Task resume does not prove settlement of real remote
descendants.

## Permission Timing

- Package project tools reject on incomplete preflight before path resolution,
  baseline transfer, permission preparation, SSH, or SFTP.
- Starting `remote_status` advances the session generation, invalidates old
  state, and aborts active package project leases. It asks for its own permission
  before running the fixed identity SSH command. No separate preflight `bash`
  request occurs. A failed or denied recheck leaves the session invalidated.
- After preflight, lexical external paths ask for `external_directory` before a
  canonicalization probe. If canonicalization resolves to a different external
  path, that canonical target receives a separate check. Other path
  canonicalization can occur before the tool-specific `bash`, `read`, `glob`,
  `grep`, or `edit` request.
- Write, edit, and patch pull current remote content into the private local
  mirror before requesting `edit`, because the permission metadata includes a
  diff. Read pulls its content after the `read` decision.
- No requested Bash command or remote file mutation occurs before its
  corresponding `bash` or `edit` approval.

These are OpenCode host permission decisions around package-enforced ordering,
not a filesystem sandbox. Only `external_directory` offers a reusable
interactive scope, limited to the exact normalized path and descendants for the
current OpenCode process. That scope crosses sessions in the same process but
not restarts. External paths containing literal `*`, `?`, or `\\` are rejected.
Configure reviewed global/per-agent policy for durable behavior.

## Privileges

The base connection uses the configured SSH user. A workspace of `/` does not
grant root privileges. Administrative commands should use narrowly scoped
`sudo -n` operations backed by explicit `NOPASSWD` sudoers rules and separate
user confirmation.

SFTP file operations cannot elevate through sudo. Root-owned files must be
changed through an explicit administrative shell command or by a separately
audited privileged workflow.

## Paths And Files

Direct file paths outside the configured remote workdir request OpenCode's
`external_directory` permission. This is an operator-consent boundary, not a
shell sandbox: arbitrary bash commands can address any path allowed to the SSH
user after the normal bash permission is granted.

One plugin instance has one abort-aware, operation-wide file transaction queue.
A canceled waiter rejects without entering its transaction or overtaking the
active owner. Mutation paths are canonicalized and repeatedly revalidated after
queue admission and before commit. The system-SSH/SFTP design has no
descriptor-relative no-follow primitive, so a non-cooperating rename can still
race after the final check.

Each commit compares full content against its baseline, acquires deterministic
locks containing random owner tokens, precreates a random same-directory
temporary at mode `0600`, uploads by SFTP, takes the destination's numeric mode
from final validation, and replaces with GNU `mv -fT --`. Cleanup removes only
token-matching locks; unknown or uncertain foreign locks are left in place and
reported. Cleanup errors retain the primary error and name possible artifacts.

The guarantee is content plus numeric mode only. New files finish as `0600`;
existing files receive the final observed numeric mode. Replacement does not
preserve owner, group, ACLs, xattrs, capabilities, timestamps, hard-link
identity, or other metadata. A single replacement is atomic. A multi-file
operation is only per-file atomic and can stop after partial completion; its
typed error reports committed, failed, uncertain, and unattempted paths, with no
automatic rollback or retry. Patch delete and move remain rejected.

These checks do not make same-path sibling mutation safe and do not cover Bash,
MCP, other plugins, another package module instance, or external writers. Assign
disjoint scopes and use disposable data for the initial mutation trial.

## Local Data And Cleanup

Canonicalization output, downloaded baselines, diff preparation, manifests,
and mirrored file content are local data. Mirrors are launch-scoped and private
to the local user, but same-UID processes are trusted and can read them. Normal
cleanup removes the launch mirror; a surfaced cleanup failure means residue may
remain and must be inspected. Remote project instructions are not automatically
ingested, so a root `AGENTS.md` reaches the host/model only if a preflighted
session explicitly reads or otherwise transmits it.

## Startup Diagnostics

`src/logger.ts` is a reusable best-effort local JSONL logger, not a security
audit log. Its default file is
`${XDG_STATE_HOME:-$HOME/.local/state}/opencode-ssh/logs/opencode-ssh-YYYY-MM-DD.jsonl`.
It uses one file per UTC day and has no background retention timer. Logging
activity may run pruning at most once per UTC day per logger instance; when that
maintenance runs, it keeps the current UTC day plus the previous four. Stale
matching files can remain if no later logging occurs. The logger enforces `0700`
directories and a `0600` regular file, opens with `O_APPEND`, `O_NOFOLLOW`, and
`O_NONBLOCK`, and rejects records over 64 KiB. The 500 ms caller deadline assumes
a local state filesystem. It does not cancel an issued native filesystem request,
which may finish later on pathological or non-local storage; it is not universal
bounded-process-settlement evidence. Every logging failure is suppressed and
never replaces the core operation result.

Instrumentation is intentionally startup-focused: compatibility version/probe;
launcher SSH, canonicalization, OpenCode, ready, and cleanup; probe health and
marker publication; and production plugin lookup, health source/version,
mirror, pool, bootstrap, config, ready, and disposal. Runtime compatibility
signals include an at-most-once-per-launch
`plugin.task_root_permission.normalized` warning when an omitted caller-root
permission overlay is accepted as empty. It contains only the standard
correlation envelope. The external-directory request/reply lifecycle tracks at
most 64 requests per launch and also emits a same-scope repeat-after-`always`
warning plus one bounded diagnostics-limit warning. Those lifecycle records
contain only the reply/lifetime, bounded limit reason, and boolean reusable/
coverage/pending/repeat state, never the path, patterns, metadata, or host
permission IDs. Non-secret `startupID`
correlates processes, followed by `launchID` and `targetID`. `targetID` is the
stable pseudonymous SHA-256 of alias plus canonical workdir. It is not secret and
is not claimed irreversible against guessed alias/workdir inputs. Production
failure records use stable categories/codes and allowlisted fields, never raw
errors or messages.

Do not log raw target alias/canonical workdir or project/local paths;
commands/argv; environment or config content; nonce/token/credential values or
their hashes; session/task/permission IDs; output or response bodies; or model/
provider data. The only path shown to the operator is the local diagnostic file
path printed by the CLI after at least one successful write. Same-UID processes
remain trusted and can read that private local file.

Future callers must use stable event names matching
`[A-Za-z0-9][A-Za-z0-9._:-]*` and reviewed non-secret fields. Critical cleanup
or disposal must start before awaiting diagnostics. Do not expand the narrow
documented external-directory lifecycle into general project, tool, permission,
session, model, or provider telemetry.

## Live Command Output

Live Bash output is session-visible data. Commands must not print credentials,
tokens, private keys, or other secrets. The latest partial output is
intentionally retained in the Bash card on command failure, timeout, and
cancellation.

Seeing progress is not proof that a mutating command completed successfully.
Verify remote state before treating an uncertain operation as complete or
retrying it.

## Lifecycle And Cancellation

Within one loaded package module, only one active production plugin factory can
own a launch ID. This does not protect against a hostile duplicate module
instance. Config validation failure and disposal are terminal. Disposal starts
package-pool closure immediately; closure rejects new operations, aborts active
SSH and SFTP slaves, and waits for them to settle without taking ownership of
the launcher ControlMaster. Ready publication and its 25 ms launcher
revalidation establish a startup boundary, not a perpetual liveness guarantee.

On supported POSIX local hosts, only owned launcher children that explicitly
request process groups are covered: OpenCode, version, and compatibility-probe
processes, with bounded TERM/KILL settlement. This is not a claim about every
local child. Package-pool closure separately rejects new operations, aborts
active SSH/SFTP slaves, and waits for their settlement. Launcher cleanup attempts
OpenCode, ready marker, mirror, ControlMaster, socket, and signal-listener cleanup
even after an earlier step fails. Known cleanup errors are surfaced; signal exits
retain 130/143 and emit a warning when cleanup is incomplete.

Timeout or cancellation closes the local SSH channel. The remote process or its
descendants may survive loss of that channel. Neither local process groups nor
pool settlement universally terminate real remote descendants. Inspect the
remote host before retrying a command whose completion is uncertain.

Automated direct-child cancellation coverage proves local OpenCode Task/session
settlement, local fake-SSH slave termination, and no retry. It does not prove
universal termination of real remote descendants.

Final 2026-08-28 automated evidence passed the exact OpenCode 1.18.18
six-scenario manifest with safe same-launch resume and installed real-Task
fake-SFTP mutation, plus a real installed permission-engine scenario. Ordinary
installed OpenCode 1.18.25 also passed 6/6 with resume disabled and fresh
fallback, and its permission-engine scenario passed. Every automated preflight used one
`remote_status` identity SSH command and no separate Bash preflight. The
installed 1.18.25 fresh path and exact 1.18.18 fresh/resume paths accepted an
omitted root permission overlay as empty while retaining explicit child arrays.
Formal direct-child release evidence remains incomplete only for real-SSH
two-sibling mutation and real permission UI and direct-child TUI behavior;
`npm run test:real` was not run. Earlier `5/5` records are historical pre-resume
evidence and are not the current six-scenario result.

The same final cycle's focused runtime-health/logging evidence passed lint/build,
actual OpenCode 1.18.25 self-test with Task resume disabled, a focused 121/121
permission/diagnostics/lifecycle gate, and installed-loader 3/3 with zero skips. The target-free localhost:4096
decoys saw zero connections/requests and the observer reported
`client._client.get`; real-serve activation/disposal and correlated logs also
passed. The complete default, smoke, and package dry-run gates passed; detailed
counts remain in the fit report. The no-listener case is target-free `debug
config` plus a hermetic SDK path, not default no-argument TUI automation; neither
focused case proves visual TUI, real permission UI, model, or real-SSH behavior.

## Reporting

Do not include private keys, passphrases, passwords, provider tokens, expanded
configuration secrets, or production file contents in reports or logs.
For delegated work, the root report must identify every fresh and resumed run,
every change, failure, cancellation, unverified result, and remaining
uncertainty after repeated final remote verification.
