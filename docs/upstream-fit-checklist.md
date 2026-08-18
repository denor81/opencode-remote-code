# OpenCode SSH Fit Checklist

Use this checklist only with a separate non-production SSH target. Replace
`test-alias` and the test directory deliberately before running commands.

## Preconditions

- `ssh test-alias` succeeds through the intended `~/.ssh/config` entry.
- The host key is already reviewed, or its first confirmation is expected.
- The encrypted key is available through the current user's `ssh-agent`.
- `ssh test-alias 'sudo -n id -u'` prints `0` if sudo testing is required.
- The selected remote directory contains no valuable data.
- No passwords, passphrases, private keys, or provider tokens are recorded.

## Local Verification

Run from this checkout:

```bash
opencode --version
npm ci
npm run lint
npm run test:unit
npm run test:integration
npm run test:smoke
npm pack --dry-run
```

The actual OpenCode loader integration test must run, not skip. It accepts any
installed version and fails only when the observed loader behavior is
incompatible. A version other than the recorded baseline still requires the
manual TUI checks below.

Install the tested build only after these commands pass:

```bash
npm install -g .
opencode-ssh --version
```

## Remote Test Directory

Create a unique directory after reviewing the path:

```bash
ssh test-alias 'umask 077; mkdir -p /tmp/opencode-ssh-fit-YYYYMMDD'
```

Start the test OpenCode in a second local terminal:

```bash
opencode-ssh test-alias /tmp/opencode-ssh-fit-YYYYMMDD
```

The launcher must stop with an error if the remote plugin does not publish its
ready handshake. Do not continue if local built-in tools appear instead.

## Read-Only Checks

Ask the test session to perform these in order:

1. Call `remote_status` and report alias, workdir, connection ID, and health.
2. Run `pwd`, `uname -a`, and `whoami`; verify the remote host and workdir.
3. If sudo testing is required, run `sudo -n id -u`; expect `0` without a
   password prompt.
4. Create no files yet; list the empty test directory with `read` and `glob`.
5. Request a read of `/etc/os-release`; verify an external-directory permission
   prompt appears before access. Test deny once, then allow on a second request.
6. Run a normal local Serper/MCP action and verify that integration still works.

## Live Bash Output

Run these checks only through the agent's SSH-backed `bash` tool in the actual
OpenCode TUI. Manual shell commands entered with a leading `!` are local and do
not test this feature.
OpenCode 1.18.18 is the recorded baseline; repeat all five checks whenever the
launcher warns that a different or unidentifiable OpenCode version is active.

1. Ask the agent to run this command on the disposable target:

   ```sh
   for n in 1 2 3 4; do
     printf 'stdout %s\n' "$n"
     printf 'stderr %s\n' "$n" >&2
     sleep 1
   done
   ```

   Verify both streams advance in the existing Bash card before the command
   completes. Cross-stream ordering is not guaranteed.
2. Run `printf 'before failure\n'; exit 7` and verify `before failure` remains
   visible in the failed card.
3. Run `printf 'before timeout\n'; sleep 30` with a short Bash tool timeout.
   Verify the initial line remains visible, no automatic retry occurs, and the
   remote process state is inspected before any follow-up action.
4. Run a harmless command that emits more than 30,000 characters and ends with
   an identifiable newest line, for example:

   ```sh
   i=0
   while [ "$i" -lt 30100 ]; do
     printf x
     i=$((i + 1))
   done
   printf '\nnewest tail\n'
   ```

   Verify the card shows the truncation marker and newest tail without hanging
   the TUI.
5. Run this command:

   ```sh
   printf 'before cancellation\n'; sleep 30
   ```

   Use the configured OpenCode session-interrupt action (default `Escape`).
   Verify the partial line remains, no late output or automatic retry appears,
   and remote process state is inspected before any follow-up. Cancellation
   does not guarantee remote descendant termination.

Do not run a real package upgrade for this fit test.

## Disposable Mutations

Only inside the unique test directory:

1. Use `write` to create a UTF-8 text file and a path containing spaces.
2. Use `read` to verify exact content.
3. Use `edit` for one exact unique replacement.
4. Use `grep` with a known expression and include filter.
5. Use `glob` with a known pattern.
6. Use `apply_patch` to add one file and update one existing file.
7. Do not test patch delete or move; those operations are intentionally rejected.
8. Modify a test file from a separate SSH terminal after OpenCode reads it,
   then ask OpenCode to edit it; verify `RemoteFileConflict` preserves the
   second writer's content.

## Root Workspace

Exit the test TUI, then run a separate read-only session:

```bash
opencode-ssh test-alias /
```

Verify `remote_status`, `pwd`, and reading `/etc/os-release`. A root workspace
must not request external-directory permission, but Unix user permissions still
apply. Do not mutate system paths during this fit trial.

## Lifecycle

1. Exit OpenCode normally and verify the launcher exits.
2. Start it again with the same alias/workdir and verify the prior session is visible.
3. Interrupt one test run with Ctrl-C and verify no `opencode`, SSH master, or
   control socket remains for that launch.

## Cleanup

Review the exact unique path before deletion:

```bash
ssh test-alias 'rm -rf -- /tmp/opencode-ssh-fit-YYYYMMDD'
```

Record evidence in `docs/upstream-fit-report.md`. Never include credentials,
private key data, provider tokens, production content, real aliases, hostnames,
usernames, IP addresses, workdirs, target IDs, or exact OS/kernel fingerprints.
