# Rules for Working Through OpenCode SSH

This document is automatically included in OpenCode's instructions when a
project is launched with:

```text
opencode-ssh <ssh-alias> <absolute-remote-workdir>
```

Users do not need to copy it into, reference it from, or customize it for each
remote project. Remote root `AGENTS.md` is not loaded or injected automatically.
After package preflight, explicitly read it through SSH-backed `read` if the
user wants its project-specific guidance applied. User instructions, OpenCode
permissions, and Unix permissions also continue to apply.

This file is prompt/operator guidance. It describes package-enforced controls
and OpenCode host-policy boundaries, but the text itself is not a sandbox or an
authorization mechanism:

- **Package-enforced:** private per-session preflight, package project-tool and
  root-Task gates, root-only foreground Task, child/background rejection,
  startup-qualified same-launch resume with launch-local ownership and atomic
  admission, SSH/SFTP behavior, and package file transaction checks.
- **OpenCode host policy:** tool catalogs and configured global, per-agent, and
  session permission decisions.
- **Guidance:** task scope, reviewed administration, disjoint sibling work,
  verification, and reporting rules in this document.

## 1. Execution Boundary And Preflight

The OpenCode process, TUI, provider client/authentication, MCP servers, plugins,
Task orchestration, and direct-child session state run on the local machine.
Model/provider requests follow provider configuration and may leave it. These
project tools are supplied by the OpenCode SSH plugin and operate on the selected
SSH server:

- `bash`
- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `apply_patch`
- `remote_status`

Task is not in that list. It is local OpenCode orchestration and does not make a
child session or model run on the SSH server.

Other facilities may remain local, including manual TUI commands prefixed with
`!`, web tools, MCP servers, LSP servers, formatters, TUI file APIs, third-party
plugins, and OpenCode internals. Tool-card appearance alone does not prove where
a command ran. Do not use unknown project tools named `terminal`, `execute`,
`shell`, `run_command`, or similar unless their execution location is proven.

Package code gives every session independent preflight state and requires this
sequence before that session's package project tools; the root also needs it
before Task. Guidance requires every direct child to complete the sequence
before remote project work even if it would return without using a package
project tool:

1. Call `remote_status`.
2. Require `executor: ssh` and `controlMaster: healthy`.
3. Note `targetAlias`, `remoteWorkdir`, and `connectionId` as the active target.
4. Use package SSH-backed `bash`, with no explicit workdir, to run exactly
   `hostname; whoami; pwd -P`.
5. Confirm that the shell is remote and that `pwd -P` equals `remoteWorkdir`.
6. Confirm that every planned mutation is inside all applicable task and
   project boundaries.

Every package status or identity attempt advances a per-session generation. A
new generation invalidates earlier status/identity and aborts active package
project SSH, SFTP, and mutation leases. Only a completed healthy status followed
by a zero-exit, exactly three-line identity result with non-empty hostname/user
and matching canonical workdir restores preflight. A denied, canceled, failed,
unhealthy, truncated, or mismatched check keeps package project tools and root
Task blocked. An already completed remote commit and already-admitted upstream
Task execution are not retroactively undone. Parent evidence is never copied to
a child. An admitted Task resume deliberately clears that child's earlier state,
so the resumed run must repeat this entire sequence.

Guidance: repeat verification after a reconnect, context compaction, unexpected
transport error, or loss of confidence in the execution location, and before a
dangerous administrative operation.

Before identity completes, package Bash permits only that exact command. After
identity, built-in `explore` still cannot use package Bash for project commands;
its package `read`, `glob`, and `grep` remain subject to OpenCode host policy.
There is no package local-Bash fallback.

The package defaults `remote_status` to `ask` only if neither global nor the
configured `explore` policy explicitly matches it. Package permission requests
offer no persistent `always`, so `ask` may prompt on each call. OpenCode host
policy must approve an ask before the corresponding operation. Guidance: never
work around a deny with another agent, tool, or local command; name the conflict
and stop rather than creating a matching local file or switching execution
tools.

Task security epochs observe both event pairs: OpenCode v2 `permission.asked`
followed by `permission.replied` carrying `requestID`, and legacy
`permission.updated` followed by `permission.replied` carrying `permissionID`.
A relevant request/reply, including malformed or unknown delivery, can
invalidate Task security evidence fail closed. Permission event delivery remains
non-throwing; that does not make invalidated Task admission succeed.

Use SSH-backed `read` or `bash` to verify remote files and results. A local
formatter, LSP, MCP tool, web tool, or manual `!` command cannot verify a remote
change. This mode is not a sandbox and does not make every OpenCode operation
remote.

Startup ready is a nonce-bound boundary that the launcher revalidates after
25 ms; it is not a perpetual liveness guarantee. Config failure and disposal are
terminal, and disposal starts package-pool closure immediately. If a package
tool reports a disposed or inactive lifecycle, stop rather than switching tools
or assuming the earlier ready result is still current.

Before any SSH, the target-free `debug config` probe requires nonce-bound loader
runtime version/source, exact agreement with selected `--version`, and callable
session lookup; it does not invoke TUI, a model, Task, or SSH. The normal
production launcher starts the no-argument TUI. Its plugin rechecks callable
lookup and matching runtime health through the OpenCode host SDK's configured
transport only after ControlMaster startup and workdir canonicalization, but
before plugin launch ownership, mirror, package pool/bootstrap commands, or
ready. The recheck does not itself invoke a model, Task, or permission UI or
certify visual TUI behavior. Upstream's default no-listener TUI design uses the
in-process SDK transport; serve may use the process-owned listener. The observer
never raw-fetches `PluginInput.serverUrl` or trusts fallback localhost:4096. Do
not claim that this second check precedes all SSH.

If launch fails after diagnostics were successfully written, the CLI may show a
local diagnostic path and `startupID`. Log lookup is operator-side local
troubleshooting only. It is not a child project workflow, remote preflight, or
verification source; a child must not substitute those logs for `remote_status`,
SSH-backed tools, or remote file/diff inspection. Do not expose or transmit the
local diagnostic file as project context.

Permission timing matters. Incomplete preflight rejects package project tools
before path resolution, baseline reads, SSH/SFTP preparation, or tool-specific
permission preparation. `remote_status` asks before its health SSH. After
preflight, canonicalization can use SSH before a `bash`, `read`, `glob`, `grep`,
or `edit` prompt. Write/edit/patch pull current content before `edit` approval to
prepare the diff. A lexical external path asks for `external_directory` before
canonicalization. No requested Bash command or remote mutation runs before its
corresponding approval. Preparatory baselines remain in the private local mirror
until cleanup and are visible to trusted same-UID local processes.

## 2. Workdir, Scope, And Shell Semantics

The configured remote workdir is the initial directory for remote shell
commands, the root used by remote file tools, and part of session identity. It
is not a chroot and technical access is not authorization to modify a path.

Direct file paths outside the workdir are canonicalized remotely and normally
request `external_directory` permission. Arbitrary paths embedded in shell text
cannot be inferred reliably and remain governed by the `bash` permission. Never
use shell text to bypass a path or project boundary.

A project guide or the user may define a narrower mutation scope. That scope
applies to file tools, shell commands, `sudo`, package managers, services, and
direct children. Canonical paths and symlink targets must remain inside it.
Neither an `external_directory` approval nor approval for `sudo` broadens it.
Ambiguous scope requires asking before mutation.

If no narrower scope is stated, this document adds no separate path restriction,
but only task-authorized changes are allowed. A workdir of `/` contains every
absolute remote path for permission purposes; narrower project and task
boundaries still apply.

Each `bash` call starts a separate remote POSIX `sh` process. `cd`, `export`,
aliases, functions, and variables do not persist between calls. Set an explicit
working directory for each call that needs one. If Bash syntax is required,
first verify Bash exists and invoke it explicitly with `bash -lc ...`.

Do not use `sudo -i` or another interactive shell to seek persistent state. It
will not persist across tool calls and may hang.

## 3. Privileges And High-Impact Operations

The connection uses the SSH user configured by system OpenSSH. SFTP-backed
`read`, `write`, `edit`, and `apply_patch` use that user's permissions and do not
elevate through `sudo`.

Before every `sudo`, destructive, or high-impact operation, the agent MUST:

1. Show the exact command.
2. Explain its purpose and impact scope.
3. State how the result will be verified.
4. State the rollback plan, or say explicitly that no rollback is available.
5. Obtain explicit user confirmation for that exact operation.

Changed command text or broader impact requires new confirmation. A general
request is not blanket authorization for undisclosed administrative commands.

For an approved administrative operation, use a reviewed non-interactive
command:

```text
sudo -n -- <command>
```

If privileged shell redirection is required, invoke the privileged shell only
for the reviewed command:

```text
sudo -n sh -c '<reviewed command>'
```

Separate explicit confirmation is required for `rm -rf`, bulk deletion,
recursive `chmod` or `chown`, package or system upgrades, production service
restarts, reboot, mounts, user management, and changes to SSH, firewall,
sudoers, or network configuration.

Never work around a permission error with broad ownership or mode changes, a
persistent root shell, or elevation of the entire session. Never prompt for,
store, or transmit an SSH or sudo password.

## 4. Safe File Changes

Before changing a file:

1. Canonicalize and verify the remote path.
2. Read the current remote content.
3. Confirm the effective mutation scope.
4. Prepare the smallest necessary change.
5. Review the intended diff.
6. Re-read the file after the change.
7. In a Git project, inspect remote `git status --short` and `git diff`.

Within one plugin instance, package file mutations use one abort-aware,
operation-wide queue, full-content baselines, repeated canonical-path
revalidation, deterministic locks with random owner tokens, mode-0600 private
sibling temporaries, and GNU `mv -fT --` replacement. These protections prevent
many stale writes and partial file uploads, but they are not a universal
filesystem transaction. A process that ignores the plugin lock can still race
after final validation. Bash, MCP, other plugins, another module instance, and
external writers bypass this transaction.

Only content and numeric mode are guaranteed. Existing files use the numeric
mode observed at final validation; new files use `0600`. Owner, group, ACL,
xattr, capability, timestamp, hard-link identity, and other metadata are not
preserved. Do not use a package file tool where those semantics are required.

On `RemoteFileConflict`, do not repeat the stale write. Re-read the remote file,
show the concurrent change, and recalculate the edit against current content.

On `REMOTE_FILE_LOCKED`, do not delete `.opencode-lock-*` or try to clear the
lock automatically. Stop, tell the user, and determine whether another session
is active or a stale lock remains.

`apply_patch` supports add and update operations, including multi-file patches.
Delete, move, and rename are not supported. Perform an approved delete or move
only through a separate, narrowly scoped remote shell command after the
confirmation required above. Never imitate deletion by writing an empty file.

A multi-file patch is per-file atomic, not globally atomic. Its typed error
separates committed, failed, uncertain, and unattempted paths; it performs no
automatic rollback or retry. After any patch failure, inspect every intended
target and any reported temporary/lock artifact before taking further action.

Search and read tools have output limits. Narrow or paginate truncated results.
Never treat truncated output as proof that text is absent or that a file or
result was read completely. Avoid replacing a bounded file operation with an
uncontrolled shell read of a large or special file.

## 5. Timeouts And Uncertain Results

A timeout or cancellation closes the local SSH channel, but the remote process
or its descendants may continue running. Timeout, cancellation, conflict, lock
failure, transport failure, and partial multi-file failure all create an
uncertain remote state.

Automated cancellation tests prove only that local OpenCode Task/sessions and
local fake-SSH slave processes settle without retry. They do not prove universal
termination of descendants created by a real remote command.

Never automatically retry a mutating operation after an uncertain result.
Before considering any retry, inspect remotely:

- Whether the process or descendants still exist.
- Whether each target file changed.
- Whether the operation completed.
- The current service or job state.
- Whether temporary or lock files remain.

If the result cannot be verified, stop and report the uncertainty rather than
claiming success or failure.

## 6. Other Tools And Direct Children

Web and documentation tools should normally remain local. Never use a
filesystem or shell tool supplied by an MCP server or third-party plugin for the
remote project without separate proof of its execution location.

An LSP or formatter may inspect the local launcher workspace instead of remote
files. Its results may be advisory, but they do not verify the remote project.
Caller-directory project configuration is not discovered automatically because
OpenCode starts in a stable target-specific local workspace.

Same-process plugins, direct SDK/session API callers, and same-UID local
processes are trusted. They can inspect launch data or bypass package tools and
package-observed Task hooks; this package does not sandbox a hostile trusted
plugin. An enabled `mcp.remote` configuration is rejected for its known
`remote_status` namespace collision, not as general plugin isolation.

After package preflight, only the top-level root may use Task. It may launch
multiple foreground direct children sequentially or concurrently. Depth is a
nesting limit, not a sibling-count limit: explicit zero stays zero and absent or
positive values become one. Package runtime code rejects Task from a child even
if a trusted later config hook exposes it. `background: true` remains unsupported,
and the launcher forces background subagents off.

Task resume is package-controlled, not general OpenCode behavior. Callable
session lookup is required for every launch, and only explicitly
release-qualified OpenCode 1.18.18 enables resume. Another compatible
loader/runtime version keeps fresh foreground Task but rejects every `task_id`
before upstream execution. Read the generated OpenCode SSH system context before
considering resume:

- If the context says Task resume is disabled, never submit `task_id`. Start a
  fresh foreground Task and provide all required context.
- If the context says Task resume is enabled, resume only the exact `task_id` of
  a successfully completed foreground direct child created by this same root in
  this current `opencode-ssh` launch, and use exactly the same `subagent_type`.
- Preserve each eligible ID verbatim with its originating root and
  `subagent_type`. Never invent, guess, reconstruct, alter, or borrow a task ID.

The package keeps a launch-local ownership registry. Fresh admission is one-shot
for its root/Task call. Registration binds unchanged root permission and
security-epoch evidence across Task, preserves every inherited SSH-project deny,
and requires an explicit child agent matching `subagent_type` plus an explicit
permission array. Unknown IDs are rejected before upstream can reinterpret them
as fresh-child requests. Cross-launch, foreign-root, unknown/invented,
child-initiated, background, busy, failed, canceled, and uncertain resume
attempts are not allowed.

Before atomically reserving one resumer, the package revalidates exact launch,
caller root, direct child, type, observed agent, root/child permissions, and
security epochs.

When a resume is admitted, the child's old preflight is gone. Before any package
project tool, the resumed child MUST call package `remote_status`, then use
package Bash with no explicit workdir to run exactly
`hostname; whoami; pwd -P`. Earlier preflight from the child, root, or a sibling
does not count. This full new epoch is also required before successful registry
release for another sequential resume. Exact model continuity is not promised;
do not infer it from reuse of the child ID.

Once reserved, a failed, missing, malformed, aborted, canceled, or uncertain
admission/completion permanently locks the child for the launch. Never retry
that ID, race two resumes of one child, or try to make a rejected call pass by
changing the ID or type. Start a fresh foreground child and provide the needed
context instead.

OpenCode 1.18.18 does not inherit a parent session `ask` into Task children. If
the root session has an `ask` matching an SSH project permission, package code
rejects delegation instead of silently weakening it. Use stable reviewed global
or per-agent policy. Do not assume parent session `allow` or `ask` propagation;
inherited denies remain restrictive. Package requests offer no persistent
`always`, so per-call prompts are expected under `ask`.

Every fresh or resumed child receives this guidance and must separately satisfy
Section 1 before that child's package project tools. Package enforcement requires
that independent preflight for every child; a resumed child also must renew it
before successful registry release. Guidance still asks every fresh child to
preflight before remote project work. Parent
state is never copied, and resume clears the child's earlier state. A custom
child whose host policy hides a required tool cannot proceed through the
corresponding package project path or complete resumed release. Prompt
instructions do not substitute for package state.

Read-only siblings may overlap. Before starting mutation-capable siblings, the
root must give each one a disjoint path scope. Shared mutation operations may
serialize. Concurrent editing of the same path is unsupported; conflict and
lock checks are backstops, not a scheduler for cooperating children.

Guidance: the root must wait for every fresh and resumed run to settle. After
resumed work, independently repeat `remote_status`, remote Git status and diff,
or verification of every changed non-Git path. Report each fresh or resumed
run, every change, failure, cancellation, timeout, conflict, and unresolved
uncertainty. A child result alone is not final verification, and resume
settlement does not prove that real remote descendants have settled.

## 7. Completion

Before completing remote work:

1. Reconfirm the target if connection confidence was interrupted.
2. Inspect remote Git status and diff, or verify every changed non-Git file.
3. List every changed remote path, including changes from every fresh and
   resumed direct-child run.
4. Separately list every `sudo`, destructive, or high-impact operation.
5. Report every timeout, cancellation, transport error, conflict, lock, partial
   result, unresolved uncertainty, and verification that was not run.
6. Do not claim success for an unverified result.

Do not claim that no local operations occurred: OpenCode, provider traffic, the
TUI, web tools, MCP servers, plugins, and other facilities may remain local.
Report only that project mutations were verified remotely. Do not expose
credentials, tokens, private keys, or sensitive command output in reports.

Provider clients run from the local OpenCode environment, but configured
provider requests may leave the machine. Do not describe this mode as a
no-egress boundary.

The remote root `AGENTS.md` is not loaded automatically. If its guidance is
needed, explicitly read it after preflight and report that it was consulted.
Restart `opencode-ssh` after updating the package or changing launch-level local
configuration.
