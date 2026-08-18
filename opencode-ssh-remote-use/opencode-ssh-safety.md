# Rules for Working Through OpenCode SSH

This document is mandatory for agents working in a project launched with:

```text
opencode-ssh <ssh-alias> <absolute-remote-workdir>
```

Allowed mutation scope: `<ALLOWED_MUTATION_SCOPE>`

The mutation scope is optional. When the value above is the literal
`<ALLOWED_MUTATION_SCOPE>` placeholder, no additional mutation restriction is
configured, and the agent must not stop or ask the user to replace it. If the
placeholder is replaced with an explicit scope, that scope is mandatory for all
mutations. Project instructions and boundaries stated by the user always apply.

A Markdown link to this file is not sufficient by itself: the project
instruction must explicitly require the agent to read and follow it.

## 1. Purpose Of This Mode

OpenCode, the model, TUI, provider authentication, MCP servers, and plugins run
on the user's local machine.

The project tools `bash`, `read`, `write`, `edit`, `glob`, `grep`, and
`apply_patch` are overridden by the plugin and operate on the selected SSH
server. The `remote_status` tool reports the active SSH alias, canonical remote
workdir, connection ID, and ControlMaster health.

This mode is not a sandbox. It does not guarantee that every tool available to
OpenCode runs remotely.

## 2. Mandatory Verification At The Start

Before reading or changing the project:

1. Call `remote_status`.
2. Verify `executor: ssh`.
3. Verify `controlMaster: healthy`.
4. Note the reported `targetAlias` and `remoteWorkdir` as the active target.
5. Use the agent's `bash` tool to run `hostname; whoami; pwd -P`.
6. Confirm that the shell is remote and that `pwd -P` agrees with the reported
   `remoteWorkdir`.
7. If an explicit Allowed mutation scope is configured, confirm that every
   planned mutation is inside it.

Repeat this verification after a reconnect, context compaction, unexpected
transport error, and before a dangerous administrative operation.

If `remote_status` is missing, reports a non-SSH executor or unhealthy
ControlMaster, or conflicts with the verified remote shell state, stop
immediately. Never try to repair the mismatch by changing files on both the
local and remote machines.

## 3. Distinguishing Local And Remote Execution

Messages entered manually in the TUI with a leading `!` run a local shell.

Examples of local commands:

```text
!pwd
!whoami
!ls
```

They may display a local user and a launcher workspace such as:

```text
~/.local/state/opencode-ssh/<target-id>/workspace
```

This is expected, but those results say nothing about the remote workdir.

A command invoked by the agent through the `bash` tool runs remotely. Its tool
card may also be displayed as `$ command`, so appearance alone cannot identify
where a command ran.

Use only `remote_status` and the agent's verified `bash` tool to confirm remote
state.

Do not use unknown project tools named `terminal`, `execute`, `shell`,
`run_command`, or similar names supplied by other plugins or MCP servers. They
may execute locally.

## 4. Tool Boundary

These tools operate remotely when supplied by the OpenCode SSH plugin:

- `bash`
- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `apply_patch`
- `remote_status`

These facilities may operate locally:

- Manual TUI shell commands entered with a leading `!`
- Serper and other web tools
- MCP servers
- LSP servers
- Formatters
- TUI file APIs
- Third-party plugins
- Local references
- OpenCode internal operations

Never use a local tool to verify the result of a remote change. Re-read the file
with the remote `read` tool or verify it with the remote `bash` tool.

## 5. Remote Workdir

The workdir passed to the launcher is:

- The initial directory for remote shell commands.
- The project root for remote file tools.
- Part of the stable session identity.

It is not a chroot.

A file path outside the workdir is canonicalized with remote `realpath` and
normally triggers an `external_directory` permission request.

Arbitrary shell text cannot be parsed reliably. A command such as
`cd /etc && ...` is governed by the `bash` permission and may not trigger a
separate `external_directory` prompt. Never use shell text to bypass the path
boundary.

If the workdir is `/`, there are no paths outside it and no automatic
`external_directory` prompt. An explicitly configured Allowed mutation scope
still applies in that mode.

Technical access to a path is not permission to modify it.

## 6. Shell Semantics

Each `bash` call starts a separate remote POSIX `sh` process.

Commands such as `cd` and `export`, aliases, shell functions, and variables do
not persist between calls. The next command starts in the remote workdir unless
the tool call explicitly sets another working directory.

If Bash-specific syntax is required, first verify that Bash exists and invoke
it explicitly with `bash -lc ...`.

Do not use `sudo -i` to obtain a persistent root shell. State will not persist,
and an interactive shell may hang.

## 7. Permissions And Sudo

The SSH connection runs as the user configured in `~/.ssh/config`.

Obtain explicit user confirmation before every destructive or `sudo` operation.

SFTP-backed tools do not gain root privileges through sudo. Therefore `read`,
`write`, `edit`, and `apply_patch` may fail on root-owned files.

For an explicitly approved administrative operation, use only a reviewed,
non-interactive command:

```text
sudo -n -- <command>
```

For shell redirection, invoke a privileged shell explicitly:

```text
sudo -n sh -c '<reviewed command>'
```

Before using `sudo`, changing system configuration, installing packages,
restarting a service, changing firewall rules, rebooting, mounting filesystems,
or managing users, the agent MUST:

1. Show the exact command.
2. Explain its purpose and impact scope.
3. State how the result will be verified and how it can be rolled back.
4. Obtain explicit user confirmation.

The following require separate explicit confirmation:

- `rm -rf`
- Recursive `chmod` or `chown`
- Bulk deletion
- System or package upgrades
- Restarting production services
- Changes to SSH, firewall, sudoers, or network configuration

Never work around a permission error with broad `chmod`, broad `chown`, or by
running the entire session as root.

## 8. Safe File Modification

Before changing a file:

1. Canonicalize and verify the remote path.
2. Read the current remote content.
3. If an explicit Allowed mutation scope is configured, confirm that the path
   is inside it.
4. Prepare the smallest necessary change.
5. Review the intended diff.
6. Re-read the file after the change.
7. For a Git project, use remote `bash` to inspect `git status --short` and
   `git diff`.

File mutations use content baselines, sibling temporary uploads, cooperative
plugin locks, and atomic rename. These protections prevent many conflicts and
partial uploads, but they are not a universal filesystem transaction.

A process that does not honor the plugin lock can still change a file after the
last validation.

On `RemoteFileConflict`:

- Do not repeat the stale write.
- Re-read the remote file.
- Show the user the second writer's change.
- Recalculate the edit against the new content.

On `REMOTE_FILE_LOCKED`:

- Do not delete `.opencode-lock-*`.
- Do not attempt to remove the lock automatically.
- Stop and tell the user.
- Determine whether another session is active or a stale lock remains.

## 9. Apply Patch

For GPT models, OpenCode may hide `edit` and `write` while retaining
`apply_patch`. This is normal OpenCode tool filtering, not an SSH plugin error.

Supported operations:

- Add File
- Update File
- Multi-file add/update

Unsupported operations:

- Delete File
- Move or Rename File

Delete and move operations must use a separate, narrowly scoped remote shell
command after explicit user confirmation. Never imitate deletion by writing an
empty file.

A multi-file patch can be partially committed if transport fails after its
conflict preflight. After a patch failure, inspect every intended target before
taking further action.

## 10. Search And Read

`grep.path` must identify a directory. Passing a file as `grep.path` can produce
a failed tool call. To search one file, pass its parent directory and use a more
specific `include` or pattern.

`glob` and `grep` results have output limits. If the output is truncated, narrow
the directory, pattern, or include filter. Never treat a truncated result as
proof that a string is absent.

`read` limits line count and response size. Use `offset` and `limit` for large
files.

Binary and special files may not be supported by the file tools. Do not replace
a bounded file operation with an uncontrolled `cat` of a huge file through the
shell.

## 11. Timeout And Uncertain Results

A timeout or cancellation closes the local SSH channel, but the remote process
or its descendants may continue running.

Never immediately repeat a mutating command after a timeout. First verify
remotely:

- Whether the process still exists.
- Whether a file changed.
- Whether the operation completed.
- The current service or job state.
- Whether temporary or lock files remain.

Never automatically retry a mutating command after a timeout, cancellation,
conflict, lock error, transport failure, or uncertain result.

## 12. Other Tools

Serper, web search, and documentation MCP servers should normally remain local.

Never use a filesystem or shell tool supplied by an MCP server or third-party
plugin for the remote project without separate proof of its execution location.

A subagent must receive these execution rules and any explicitly configured
Allowed mutation scope, and must call `remote_status` before acting.

An LSP or formatter may see the local launcher workspace instead of the remote
files. Its lack of errors does not verify the remote project.

Caller-directory `opencode.json` and `.opencode/` configuration are not loaded
automatically. The launcher uses global OpenCode configuration and explicitly
configured absolute paths.

## 13. Diagnosing An Execution Mismatch

Possible signs of local or incorrect execution include:

- `pwd` reports `~/.local/state/opencode-ssh/.../workspace`.
- `whoami` reports the local user.
- `hostname` reports the local machine.
- An expected remote file is missing.
- A result differs from a check made with ordinary `ssh <alias>`.
- `remote_status` is missing or unhealthy.
- A tool unexpectedly accesses a local project checkout.

If any sign appears:

1. Stop all mutations.
2. Name the exact tool that was used.
3. Call `remote_status`.
4. Use the agent's `bash` tool to run `hostname; whoami; pwd -P`.
5. Do not create a matching local file as compensation.
6. Do not automatically copy local data to the server.
7. Tell the user about the mismatch.

## 14. Completing The Work

Before completion:

1. Inspect remote `git status` or the state of every changed file.
2. List all changed remote paths.
3. Separately list every `sudo` or destructive operation performed.
4. Report every timeout, conflict, lock, uncertain result, or check not run.
5. Do not claim that no local operations occurred: MCP, the TUI, and OpenCode
   internals remain local.

Changing this instruction or the remote root `AGENTS.md` requires restarting
`opencode-ssh`, because remote root instructions are loaded when the session
starts.

The three most important safeguards are:

1. The agent must verify that `remote_status` reports an SSH executor and a
   healthy ControlMaster.
2. When an Allowed mutation scope is explicitly configured, the agent must
   enforce it even with workdir `/`.
3. The agent must stop when remote execution cannot be verified. It must never
   attempt automatic recovery by switching execution locations.
