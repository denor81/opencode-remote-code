# OpenCode SSH

Run OpenCode and its TUI locally while the normal project tools operate on a
remote machine through system OpenSSH. The remote host needs no OpenCode,
Node.js, plugin, or agent installation.

Tested against OpenCode 1.18.18. Before every SSH connection, the launcher asks
the installed OpenCode to load this server plugin in an isolated local check.
An identified different version may continue only when that check passes. Manual
TUI checks remain required before relying on a different version.

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
- Linux or macOS locally. Windows users should run the launcher in WSL.
- System `ssh` and `sftp` clients.
- A Linux SSH target with SFTP, POSIX `sh`, and `realpath`/`pwd -P` behavior.

## Install

```bash
npm run install:verified
```

This installs the locked dependencies, runs the local test suite, builds and
installs `opencode-ssh`, then runs the installed compatibility self-test. It
requires OpenCode, `ssh`, and `sftp`, but no SSH target or provider. See the complete
[installation and usage guide](docs/installation-and-usage.md) for OpenCode
installation, SSH setup, a fixed-target local script, project safety
instructions, and first-launch verification.

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

Before SSH startup, the launcher checks the selected local `opencode` version
and runs `opencode debug config` with an isolated HOME, config, and workspace.
The check must load this package's server plugin and return its private marker;
otherwise the launcher stops before opening SSH. A different identified version
may continue after a successful check and prints a warning. An unidentifiable
version is blocked. This check does not observe TUI rendering, so run the
documented manual TUI checks before relying on a new version. See the
[automatic compatibility preflight](docs/installation-and-usage.md#automatic-compatibility-preflight)
for the exact checks, regression coverage, and intentional limitations.

The terminal reports `checking`, `testing`, `passed`, and `starting SSH` while
the launcher is busy. `opencode-ssh self-test` runs the same local check without
an SSH alias, remote host, project configuration, or provider. The verified
installation runs it once to initialize a private probe config; later checks
normally take a few seconds.

Global configuration under `~/.config/opencode` and absolute explicit config
paths are preserved. Caller-directory project config (`opencode.json` or
`.opencode/`) is intentionally not discovered because OpenCode starts in the
stable launcher workspace rather than the directory where the command was
typed. Put settings needed by remote sessions in global config or an absolute
`OPENCODE_CONFIG` file. The launcher automatically adds the installed
[`opencode-ssh-safety.md`](opencode-ssh-remote-use/opencode-ssh-safety.md) to the
child OpenCode instructions without replacing existing instructions. No copy,
link, or remote project setup is required. The remote root `AGENTS.md`, when
present, is appended separately for project-specific rules.

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

## Remote Tools

The plugin overrides these familiar OpenCode tools:

| Tool | Execution |
| --- | --- |
| `bash` | One-shot POSIX `sh` command through the OpenSSH ControlMaster |
| `glob`, `grep` | Remote command through the ControlMaster |
| `read`, `write`, `edit`, `apply_patch` | Private local mirror plus system SFTP |
| `remote_status` | Target and ControlMaster health diagnostics |

Other tools, plugins, MCP servers, LSPs, formatters, provider traffic, and TUI
internals remain local. This package is not a sandbox and does not guarantee
that every OpenCode operation is remote.

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

1. Requires the local OpenCode version and isolated server-plugin loader check.
2. Starts a private OpenSSH ControlMaster only after that check passes.
3. Resolves the canonical remote workdir.
4. Creates a stable local OpenCode session directory from the alias and workdir.
5. Adds the safety instructions and this plugin to `OPENCODE_CONFIG_CONTENT`
   for the child process only.
6. Starts the ordinary local OpenCode TUI without modifying global config.
7. Requires a nonce-protected plugin-ready handshake.
8. Closes OpenCode, the ControlMaster, socket, and ready file on exit.

Runtime data is private to the local user:

```text
${XDG_STATE_HOME:-~/.local/state}/opencode-ssh/<target-id>/
${XDG_CACHE_HOME:-~/.cache}/opencode-ssh/<target-id>/
${XDG_RUNTIME_DIR:-/tmp}/opencode-ssh-<uid>/
```

## Testing

```bash
npm run lint
npm run build
npm run test:unit
npm run test:integration
npm run test:smoke
npm pack --dry-run
node dist/cli.js self-test
```

Use a separate non-production SSH target for manual mutation tests. Legacy
destructive real-host suites have been removed; the opt-in checklist is kept
separate from the default real-SSH-free tests in
[`docs/upstream-fit-checklist.md`](docs/upstream-fit-checklist.md).
The actual-loader integration test runs with any installed OpenCode version and
skips only when no `opencode` executable exists. Terminal rendering still
requires the five short human-observed checks in the
[installation guide](docs/installation-and-usage.md#manual-tui-checks).

## Current Trial Limitations

- File transfers are full-file rather than delta-based.
- Per-file content conflicts are detected before upload, and replacement uses a
  same-directory temporary file plus atomic rename. A multi-file patch can
  still be partially committed if transport fails after its conflict preflight.
- `apply_patch` delete and move operations are rejected until atomic remote
  delete/move support is implemented. Use explicit reviewed shell commands.
- Cancellation closes the local SSH channel; remote descendants may survive.
- Mirrors are launch-scoped; concurrent launchers do not share local files.

See [SECURITY.md](SECURITY.md) for the exact boundary.

## Upstream And License

This work adapts `zz6zz666/opencode-remote-code` at the commit recorded in
[UPSTREAM.md](UPSTREAM.md). It is distributed under the MIT license.
