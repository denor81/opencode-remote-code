# Rules for Working Through OpenCode SSH

This document is automatically included in OpenCode's instructions when a
project is launched with:

```text
opencode-ssh <ssh-alias> <absolute-remote-workdir>
```

Users do not need to copy it into, reference it from, or customize it for each
remote project. A remote root `AGENTS.md` may add project-specific rules or
narrow the allowed work, but it cannot weaken these rules. User instructions,
OpenCode permissions, and Unix permissions also continue to apply; the most
restrictive applicable boundary wins.

## 1. Execution Boundary And Preflight

OpenCode, the model, TUI, provider authentication, MCP servers, and plugins run
on the local machine. These project tools are supplied by the OpenCode SSH
plugin and operate on the selected SSH server:

- `bash`
- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `apply_patch`
- `remote_status`

Other facilities may remain local, including manual TUI commands prefixed with
`!`, web tools, MCP servers, LSP servers, formatters, TUI file APIs, third-party
plugins, and OpenCode internals. Tool-card appearance alone does not prove where
a command ran. Do not use unknown project tools named `terminal`, `execute`,
`shell`, `run_command`, or similar unless their execution location is proven.

Before reading or changing the project:

1. Call `remote_status`.
2. Require `executor: ssh` and `controlMaster: healthy`.
3. Note `targetAlias`, `remoteWorkdir`, and `connectionId` as the active target.
4. Use the SSH-backed `bash` tool to run `hostname; whoami; pwd -P`.
5. Confirm that the shell is remote and that `pwd -P` equals `remoteWorkdir`.
6. Confirm that every planned mutation is inside all applicable task and
   project boundaries.

Repeat this verification after a reconnect, context compaction, unexpected
transport error, or loss of confidence in the execution location, and before a
dangerous administrative operation.

If `remote_status` is missing, reports a non-SSH executor or unhealthy
ControlMaster, or conflicts with the verified remote shell, stop immediately.
Name the conflicting tool or result and tell the user. Never compensate by
creating a matching local file, copying local data to the server, changing both
locations, or silently switching execution tools.

Use SSH-backed `read` or `bash` to verify remote files and results. A local
formatter, LSP, MCP tool, web tool, or manual `!` command cannot verify a remote
change. This mode is not a sandbox and does not make every OpenCode operation
remote.

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
subagents. Canonical paths and symlink targets must remain inside it. Neither an
`external_directory` approval nor approval for `sudo` broadens it. Ambiguous
scope requires asking before mutation.

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

File mutations use content baselines, cooperative locks, sibling temporary
uploads, and atomic rename. These protections prevent many stale writes and
partial file uploads, but they are not a universal filesystem transaction. A
process that ignores the plugin lock can still race after final validation.

On `RemoteFileConflict`, do not repeat the stale write. Re-read the remote file,
show the concurrent change, and recalculate the edit against current content.

On `REMOTE_FILE_LOCKED`, do not delete `.opencode-lock-*` or try to clear the
lock automatically. Stop, tell the user, and determine whether another session
is active or a stale lock remains.

`apply_patch` supports add and update operations, including multi-file patches.
Delete, move, and rename are not supported. Perform an approved delete or move
only through a separate, narrowly scoped remote shell command after the
confirmation required above. Never imitate deletion by writing an empty file.

A multi-file patch can be partially committed if transport fails after conflict
preflight. After any patch failure, inspect every intended target before taking
further action.

Search and read tools have output limits. Narrow or paginate truncated results.
Never treat truncated output as proof that text is absent or that a file or
result was read completely. Avoid replacing a bounded file operation with an
uncontrolled shell read of a large or special file.

## 5. Timeouts And Uncertain Results

A timeout or cancellation closes the local SSH channel, but the remote process
or its descendants may continue running. Timeout, cancellation, conflict, lock
failure, transport failure, and partial multi-file failure all create an
uncertain remote state.

Never automatically retry a mutating operation after an uncertain result.
Before considering any retry, inspect remotely:

- Whether the process or descendants still exist.
- Whether each target file changed.
- Whether the operation completed.
- The current service or job state.
- Whether temporary or lock files remain.

If the result cannot be verified, stop and report the uncertainty rather than
claiming success or failure.

## 6. Other Tools And Subagents

Web and documentation tools should normally remain local. Never use a
filesystem or shell tool supplied by an MCP server or third-party plugin for the
remote project without separate proof of its execution location.

An LSP or formatter may inspect the local launcher workspace instead of remote
files. Its results may be advisory, but they do not verify the remote project.
Caller-directory project configuration is not discovered automatically because
OpenCode starts in a stable target-specific local workspace.

A subagent acting on the remote project must receive these rules and all
applicable task and project boundaries. It must independently call
`remote_status`, verify the target with SSH-backed `bash`, and use the same
verified remote tool boundary. The parent's preflight is not transferable. If
remote execution cannot be established, the subagent must not mutate the
project. The parent remains responsible for verifying and reporting delegated
changes and uncertainties.

## 7. Completion

Before completing remote work:

1. Reconfirm the target if connection confidence was interrupted.
2. Inspect remote Git status and diff, or verify every changed non-Git file.
3. List every changed remote path, including known subagent changes.
4. Separately list every `sudo`, destructive, or high-impact operation.
5. Report every timeout, cancellation, transport error, conflict, lock, partial
   result, unresolved uncertainty, and verification that was not run.
6. Do not claim success for an unverified result.

Do not claim that no local operations occurred: OpenCode, provider traffic, the
TUI, web tools, MCP servers, plugins, and other facilities may remain local.
Report only that project mutations were verified remotely. Do not expose
credentials, tokens, private keys, or sensitive command output in reports.

The remote root `AGENTS.md` is loaded when the session starts. Restart
`opencode-ssh` after changing it or after updating `opencode-ssh`.
