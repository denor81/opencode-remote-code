# Installation And Usage

OpenCode SSH runs OpenCode and its TUI on the local machine while selected
project tools operate on a remote machine through system OpenSSH. The remote
machine needs only an SSH server and the standard utilities listed below; it
does not need Node.js, OpenCode, this package, or another agent runtime.

OpenCode SSH is tested against OpenCode 1.18.18. Other OpenCode versions are
allowed only after the installed OpenCode loads this package's server plugin in
an isolated preflight. A different version still requires the manual TUI checks
in this guide.

## Requirements

Local machine:

- Node.js 22.22.2 or newer.
- OpenCode installed as the `opencode` executable.
- System `ssh` and `sftp` clients.
- Linux or macOS. On Windows, use WSL and install every local requirement in
  the same WSL distribution.

Remote machine:

- Linux with an SSH server and SFTP enabled.
- POSIX `sh`.
- `realpath` and `pwd -P`.

The `@opencode-ai/plugin` dependency installed with this package is the plugin
SDK. It does not install the OpenCode CLI.

## Install The Tested OpenCode Version

The npm package provides a reproducible installation of the tested version:

```bash
npm install --global opencode-ai@1.18.18
opencode --version
```

The expected version output is:

```text
1.18.18
```

An existing OpenCode installation may be used instead. A different identified
version continues only after the loader preflight passes and produces an
advisory warning. An unidentifiable version or failed loader preflight is
blocked before SSH starts.

## Install OpenCode SSH From Source

Clone this repository using the HTTPS or SSH URL from its GitHub **Code** menu,
then run the verified installation:

```bash
cd opencode-remote-code
npm run install:verified
```

Verify both executables:

```bash
node --version
opencode --version
opencode-ssh --version
opencode-ssh --help
opencode-ssh self-test
```

`install:verified` checks Node.js, OpenCode, `ssh`, and `sftp`; installs the
locked dependencies; runs the real-SSH-free tests; installs the CLI; and runs
the installed self-test. The self-test needs no SSH alias, remote host, provider,
or project configuration. Its first run can take several seconds while OpenCode
initializes its matching plugin SDK in a private config under the local cache;
later runs normally take a few seconds.

`opencode-ssh --version` reports this package's version, not the OpenCode
version. Do not use `sudo npm install --global`; configure a user-owned npm
global prefix instead if the command reports a permission error. Installation
and the first self-test may use the configured npm registry.

## Automatic Compatibility Preflight

The automatic check is a focused behavioral startup probe, not the complete
`npm test` suite. It runs before every real launch and is also available without
a target through `opencode-ssh self-test`.

### What The Startup Probe Verifies

1. The selected `opencode` executable starts, completes `--version` within its
   five-second process timeout, exits successfully, and prints one identifiable
   semantic version.
2. The same executable runs `opencode debug config` with a temporary HOME,
   workspace, data, cache, state, runtime, and temporary directory. Normal
   OpenCode/project configuration, providers, default plugins, external skills,
   updates, sharing, and SSH configuration are not loaded.
3. OpenCode resolves and imports the installed package-root server plugin. This
   crosses the real package export, ESM module, production dependency, plugin
   tuple, and plugin-factory boundary rather than merely checking that a file
   exists.
4. The plugin receives a private tuple containing a random 256-bit nonce and
   returns a `config` hook. OpenCode itself must invoke that hook.
5. The hook atomically publishes a mode-0600 marker containing the expected
   protocol and nonce. The launcher validates both within 30 seconds. A stale,
   partial, missing, or mismatched marker cannot pass.
6. Only after that marker passes does a real launch create launch paths and
   start the SSH ControlMaster. If the executable exits, crashes, hangs, or
   returns an invalid result first, the command fails closed before any SSH
   startup.

The marker is the intended success boundary. Once the OpenCode host has invoked
the registered hook, the launcher terminates the diagnostic `debug config`
process instead of waiting for unrelated host shutdown work. The probe keeps one
package-owned config under the local cache so OpenCode can reuse its generated
plugin SDK dependencies. Its first initialization may use the caller's npm
registry, proxy, and CA transport settings; user OpenCode and provider settings
remain isolated.

### Regressions It Is Intended To Catch

- Removal or incompatible behavior of `opencode --version` or
  `opencode debug config`.
- OpenCode plugin-loader, package-export, ESM, or production dependency loading
  failures.
- Incompatible plugin tuple or server plugin-factory behavior.
- OpenCode no longer registering or invoking the returned `config` hook.
- Loader crashes, non-zero exits, hangs, missing markers, and invalid marker
  protocol or nonce values.
- A different OpenCode version that cannot load the installed plugin at all.

These are practical failures that would otherwise prevent this launcher from
bootstrapping its server plugin. They are checked against the actual installed
OpenCode executable and production package, not a mocked OpenCode API.

### What It Does Not Prove

The private probe branch returns before creating an SSH pool or constructing the
normal remote tools. It imports their modules, but it does not execute remote
commands or ask the host to invoke each tool. It therefore does not certify:

- runtime input/output behavior of every tool after registration;
- real SSH/SFTP connectivity, remote permissions, or remote filesystem behavior;
- TUI rendering, live Bash metadata, cancellation cards, or permission dialogs;
- provider, MCP, LSP, formatter, or user-plugin interaction;
- session persistence or every future OpenCode runtime behavior.

An identified version different from the tested 1.18.18 baseline may continue
only after the probe passes and always produces a warning. Passing means the
loader boundary is compatible; it is not a claim of universal compatibility.

### Related Gates

- `opencode-ssh self-test` runs exactly the same target-free startup probe.
- A normal launch subsequently requires a separate nonce-protected ready
  handshake after SSH startup. That proves the normal SSH-backed plugin reached
  its ready boundary before the launcher remains active; it is not part of the
  pre-SSH probe.
- `npm test` and `npm run install:verified` run the broader unit, integration,
  actual-loader, packaging, and installed-CLI suites. They run during validation
  or verified installation, not before every application launch.
- The manual checks in [Manual TUI Checks](#manual-tui-checks) remain mandatory
  before claiming support for another OpenCode version because automated loader
  checks cannot observe terminal behavior.

Implementation and regression anchors are `src/opencode-compatibility.ts`,
`src/opencode-probe.ts`, the ordering in `src/cli.ts`, and the focused tests in
`test/unit/opencode-compatibility.test.ts`, `test/unit/opencode-probe.test.ts`,
`test/integration/launcher-lifecycle.test.ts`,
`test/integration/opencode-loader.test.ts`, and
`test/smoke/package-install.test.ts`.

## Configure OpenSSH

Create an alias in `~/.ssh/config`. Keep hostnames, users, ports, key paths,
ProxyJump settings, and other connection details in OpenSSH configuration, not
in launcher scripts or Git:

```sshconfig
Host project-server
    HostName server.example.invalid
    User deploy
    IdentityFile ~/.ssh/id_ed25519
```

Verify the connection before using OpenCode SSH:

```bash
ssh project-server
ssh project-server 'pwd -P'
```

The alias passed to `opencode-ssh` must start with an alphanumeric character and
may contain only letters, digits, `.`, `_`, and `-`. Do not pass `user@host`,
inline SSH options, passwords, or private-key contents as launcher arguments.

The launcher disables account-password and keyboard-interactive fallback. It
can still display OpenSSH host-key and private-key passphrase prompts. Load an
encrypted key into `ssh-agent` when unattended reconnects are required.

## Automatic Safety Instructions

The installed `opencode-ssh-safety.md` is included automatically in the child
OpenCode instructions for every `opencode-ssh` launch. Existing OpenCode
instructions are preserved. Do not copy or link the generic file into each
remote project, and no safety reference is required in the project root
`AGENTS.md`.

A remote root `AGENTS.md` remains optional for repository-specific commands,
conventions, and narrower task or mutation boundaries. It is appended separately
to the remote system context and cannot weaken the generic SSH safety rules.

For projects configured with the previous manual workflow, remove the generic
safety-file reference from root `AGENTS.md`. Move any project-specific boundary
into the root guide itself, then remove the copied generic file if nothing else
uses it. Never commit real credentials or a personalized launcher script.

## Create A Local Launch Script

The CLI accepts exactly an SSH alias and an existing absolute remote workdir:

```text
opencode-ssh <ssh-alias> <absolute-remote-workdir>
```

Create a fixed-target script locally so the intended server and directory are
reviewable before every launch:

```bash
mkdir -p "$HOME/.local/bin"
${EDITOR:-vi} "$HOME/.local/bin/opencode-project"
```

Use this content, replacing the example alias and workdir with the intended
values:

```sh
#!/usr/bin/env sh
set -eu

exec opencode-ssh "project-server" "/srv/project"
```

Make the script executable:

```bash
chmod 700 "$HOME/.local/bin/opencode-project"
```

Ensure `~/.local/bin` is on `PATH`, then launch:

```bash
opencode-project
```

Do not append `"$@"`: `opencode-ssh` does not forward OpenCode arguments. Do
not set private `OPENCODE_SSH_*` environment variables; the launcher owns them.

## First-Launch Verification

Ask the agent to perform this preflight before project work:

```text
Call remote_status. Verify executor, targetAlias, remoteWorkdir, and
controlMaster, then use your SSH-backed bash tool to run:
hostname; whoami; pwd -P
```

Confirm that:

- `executor` is `ssh`.
- `controlMaster` is healthy.
- The alias and canonical workdir identify the intended target.
- The Bash result is from the remote machine and `pwd -P` matches
  `remoteWorkdir`.

Manual shell commands entered with a leading `!` in the TUI run locally. They
do not test the SSH-backed Bash tool.

## Manual TUI Checks

Run these checks after installation and whenever the launcher warns that the
local OpenCode version differs from the tested version.
Use a non-production SSH target and a disposable remote directory. The agent
must run each command, one at a time, through its SSH-backed `bash` tool. The
human operator observes the existing Bash card in the actual TUI.

### 1. Progressive stdout and stderr

```sh
for n in 1 2 3 4; do
  printf 'stdout %s\n' "$n"
  printf 'stderr %s\n' "$n" >&2
  sleep 1
done
```

Pass condition: both stdout and stderr advance approximately once per second,
before the command settles. Cross-stream ordering is not guaranteed. The final
model-facing result may group stdout and stderr; the live card is the evidence
for this check.

### 2. Non-zero exit retention

```sh
printf 'before failure\n'; exit 7
```

Pass condition: `before failure` remains visible after the card reports exit
code 7.

### 3. Timeout retention

Ask the agent to run this command with the Bash tool timeout set to 2,000 ms:

```sh
printf 'before timeout\n'; sleep 30
```

Pass condition: `before timeout` remains visible in the card, the timeout is
reported, and no automatic retry occurs. The line does not have to be repeated
inside the final model-facing error.

### 4. Preview overflow

```sh
i=0
while [ "$i" -lt 30100 ]; do
  printf x
  i=$((i + 1))
done
printf '\nnewest tail\n'
```

Pass condition: the card shows a truncation marker and `newest tail`, remains
responsive, and can still be expanded and collapsed.

### 5. Cancellation retention

```sh
printf 'before cancellation\n'; sleep 30
```

After the first line appears, the human operator invokes the configured session
interrupt action. The default in the tested OpenCode 1.18.18 setup is `Escape`.

Pass condition: the partial line remains visible, the card settles promptly as
aborted, and no automatic retry or late output appears.

After timeout and cancellation, ask the agent to inspect remote process state
before considering any retry. For this exact disposable test:

```sh
ps -eo pid,ppid,stat,etime,args | grep -E '[s]leep 30$' || true
```

No output means the test did not leave a matching `sleep 30` process. This check
does not change the general rule that timeout or cancellation cannot guarantee
termination of every remote descendant.

The detailed release checklist is in
[`upstream-fit-checklist.md`](upstream-fit-checklist.md).

## Configuration And Tool Boundaries

Global OpenCode configuration remains available. Caller-directory
`opencode.json` and `.opencode/` configuration are not discovered automatically
because OpenCode starts in a stable target-specific local workspace. Put remote
session settings in global configuration or an explicit absolute config path.
The launcher adds its installed safety document to the child-only
`OPENCODE_CONFIG_CONTENT.instructions` array while preserving existing entries.

Agent calls to these tools operate remotely after the ready handshake:

- `bash`
- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `apply_patch`

`remote_status` reports the active target. MCP servers, LSP servers, formatters,
web tools, provider traffic, manual `!` shell commands, the TUI, and other plugins may
remain local. OpenCode SSH is not a sandbox.

The remote workdir is the default project root and part of session identity; it
is not a chroot. `/` is valid but does not grant root privileges. File tools use
the SSH user's SFTP permissions. Administrative changes require explicit,
reviewed `sudo -n` shell commands and user confirmation. Read
[`SECURITY.md`](../SECURITY.md) for the complete boundary.

## Validate Another OpenCode Version

The actual-loader integration test runs with any installed OpenCode version and
fails on behavioral incompatibility rather than version mismatch. From the
OpenCode SSH checkout, run:

```bash
opencode --version
npm run lint
npm test
npm run test:smoke
npm pack --dry-run
```

Confirm that the actual OpenCode loader test ran; absence of the `opencode`
executable is the only condition that permits it to skip. Automated tests do not
observe terminal rendering, so all five manual TUI checks above remain required
before claiming compatibility with another OpenCode version.

`npm test` runs only the default real-SSH-free suites. Its package-install smoke
test may use the configured npm registry. The separate `npm run test:real`
command uses `OPENCODE_SSH_TEST_ALIAS` and `OPENCODE_SSH_TEST_WORKDIR`, connects
to that host, and mutates a disposable subdirectory. It also requires
`sudo -n id -u` to return `0` without a prompt. Run it only as an explicit
manual gate after reviewing the configured non-production target and sudo
policy.

Do not update the documented tested version or the pinned `@opencode-ai/plugin`
dependency until the automated and manual checks pass.

## Update Or Uninstall

After updating the source checkout:

```bash
npm run install:verified
```

To remove the launcher:

```bash
npm uninstall --global opencode-ssh
```

If `opencode-ssh` is not found after installation, inspect the user npm prefix
and ensure its `bin` directory is on `PATH`. If SSH fails, reproduce the problem
with ordinary `ssh project-server` first. If OpenCode exits before the plugin
ready handshake, keep the reported error and verify the installed OpenCode
version, global configuration, and package build before retrying.
