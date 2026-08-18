# Security Boundary

When the launcher handshake succeeds, `bash`, `read`, `write`, `edit`, `glob`,
`grep`, and `apply_patch` are SSH-backed. `remote_status` reports the selected
alias, canonical workdir, target ID, and connection health.

Other OpenCode tools, external plugins, MCP servers, LSPs, formatters, provider
traffic, TUI file APIs, and OpenCode internals remain local. This package is not
a sandbox and does not provide a universal no-local-execution guarantee.

Projects using this launcher should add and explicitly require the packaged
[`opencode-ssh-safety.md`](opencode-ssh-remote-use/opencode-ssh-safety.md).
That document is operational guidance, not sandbox enforcement.

## SSH

- SSH aliases are passed to system OpenSSH as literal process arguments.
- The launcher never uses a local shell to spawn `ssh`, `sftp`, or `opencode`.
- The selected `opencode --version` probe is bounded and uses no shell. Its
  warning is advisory and does not certify compatibility or executable identity.
- `~/.ssh/config`, `known_hosts`, `ssh-agent`, key passphrases, and `ProxyJump`
  remain under OpenSSH control.
- SSH password and keyboard-interactive authentication are disabled.
- The package does not store SSH or sudo passwords and creates no remote
  askpass script.
- Remote commands are never automatically retried after spawn.

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

Mutations compare the current remote content with the freshly pulled baseline,
upload to a random sibling, and rename within the target directory. Patch
delete and move operations are rejected. Multi-file replacement is preflighted
for conflicts, but a later transport failure can still leave a partial set of
completed files. Use only disposable data for the initial mutation trial.

## Live Command Output

Live Bash output is session-visible data. Commands must not print credentials,
tokens, private keys, or other secrets. The latest partial output is
intentionally retained in the Bash card on command failure, timeout, and
cancellation.

Seeing progress is not proof that a mutating command completed successfully.
Verify remote state before treating an uncertain operation as complete or
retrying it.

## Cancellation

Timeout or cancellation sends TERM and then KILL to the local SSH channel. The
remote process or its descendants may survive loss of that channel. Inspect the
remote host before retrying a command whose completion is uncertain.

## Reporting

Do not include private keys, passphrases, passwords, provider tokens, expanded
configuration secrets, or production file contents in reports or logs.
