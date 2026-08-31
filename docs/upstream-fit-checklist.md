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
npm run lint:test
npm run test:unit
npm run test:integration
npm run build && npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose
npm run build && npm exec -- vitest run test/integration/opencode-permission.test.ts --reporter=verbose
OPENCODE_TASK_TEST_BINARY=/absolute/path/to/opencode-1.18.18 npm run test:task-baseline
npm test
npm run test:smoke
npm pack --dry-run
node dist/cli.js self-test
```

The actual OpenCode loader, focused Task, and permission-engine integration tests
must run, not skip. The exact baseline command additionally requires the explicit
executable,
version 1.18.18, the unchanged six-name Task manifest including safe same-launch
resume, one installed permission-engine scenario, and zero failed/skipped/todo
scenarios.

The pre-SSH `opencode debug config` probe uses protocol v3 to publish a
target-free, nonce-bound marker with loader runtime version/source and callable
`client.session.get`. The selected `--version` must exactly match the runtime,
and lookup must be callable; missing lookup or malformed/mismatched runtime
evidence blocks before launch paths, ControlMaster, or SSH. Only explicitly
release-qualified 1.18.18 enables resume. A different compatible version keeps
fresh foreground Task but rejects every `task_id` before upstream execution. The
probe runs actual `debug config` and does not invoke TUI, a model, Task, or SSH.

The normal production launcher starts the no-argument TUI. Its plugin separately
rechecks callable lookup and matching runtime health through the host SDK's
configured transport after ControlMaster startup and workdir canonicalization,
but before launch ownership, mirror, package pool/bootstrap commands, or ready.
That recheck does not itself invoke a model, Task, or permission UI or certify
visual TUI behavior. Upstream's default TUI design uses the configured in-process
SDK transport. Automated no-listener evidence directly exercises target-free
`debug config` plus decoys and a hermetic SDK transport, not the default TUI;
serve evidence is listener-backed. Config batches validate before one ready
publication; config failure/disposal is terminal, pool closure begins
immediately, and the launcher revalidates the nonce-bound marker after 25 ms.
Ready is not perpetual liveness evidence.

Final verified 2026-08-28 automated evidence is green: lint passed and build
passed repeatedly; actual installed OpenCode 1.18.25 self-test passed with
resume disabled; ordinary installed OpenCode 1.18.25
passed 6/6 with resume disabled and fresh fallback. Exact binary
`/tmp/opencode/opencode-ai-1.18.18/node_modules/.bin/opencode` resolved to
`/tmp/opencode/opencode-ai-1.18.18/node_modules/opencode-ai/bin/opencode.exe`;
the exact baseline accepted its six Task names plus one permission scenario with
7 passed, 0 failed, 0 skipped, and the resume scenario enabled. Installed 1.18.25
and exact 1.18.18 permission-engine scenarios passed. Every automated preflight
used one `remote_status` SSH identity command and no separate Bash preflight.
Installed 1.18.25 fresh Task and exact 1.18.18 fresh/resume paths accepted a
TUI-shaped omitted root permission overlay while retaining explicit child
arrays; this does not prove visual TUI behavior. `npm test` passed 33 unit/
integration files and 462/462
tests, then 2 smoke files/tests passed 2/2; `npm pack --dry-run` passed with 165
files; and `git diff --check` passed.

The focused permission/diagnostics/lifecycle gate passed 121/121, and the complete
installed-loader gate passed 3/3 with zero skips. The actual target-free
no-listener self-test held valid health decoys on every resolved localhost
loopback address at port 4096, saw zero connections/requests, and reported
`client._client.get`. Real-serve production activation/disposal and correlated
startup logs passed. Test transport remained fake SSH/SFTP; real SSH was not
run. These gates do not prove visual or default no-argument TUI, real permission
UI, model behavior, real-SSH two-sibling mutation, or real permission-UI/direct-
child TUI.

Install the tested build only after these commands pass:

```bash
npm install -g .
opencode-ssh --version
opencode-ssh self-test
```

## Startup Diagnostics Check

The reusable logger is best-effort and startup-focused. Its default path is:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/opencode-ssh/logs/opencode-ssh-YYYY-MM-DD.jsonl
```

For a reviewed local test profile:

1. Confirm the log directory is `0700`, the daily regular file is `0600`, file
   opens use `O_APPEND`/`O_NOFOLLOW`/`O_NONBLOCK`, and records are valid JSON
   Lines no larger than 64 KiB.
2. Confirm there is no background retention timer. Trigger logging activity and
   verify a logger instance runs pruning at most once per UTC day; when
   maintenance runs, it keeps only the current UTC day and previous four matching
   daily files. Stale matching files may remain when no later logging occurs. Do
   not put unrelated files in scope of the retention assertion.
3. Confirm a launcher failure prints
   `opencode-ssh: diagnostics: <path> (startupID <id>)` only after a successful
   write.
4. Filter by the displayed ID with one of these local commands:

   ```bash
   grep -F '"startupID":"<id>"' "<path>"
   jq -c 'select(.fields.startupID == "<id>")' "<path>"
   ```

5. Confirm records correlate by `startupID`, then `launchID`/`targetID`, and
   contain only the documented startup components, stable failure codes, and
   allowlisted fields. Confirm `targetID` is the stable pseudonymous SHA-256 of
   alias plus canonical workdir; do not call it secret or irreversible against
   guessed inputs.
6. Confirm records contain no raw target alias/canonical workdir or project/local
   path, command/argv, environment/config, nonce/token/credential value or its
   hash, session/task/permission ID, output/response body, or model/provider data.
   The CLI-displayed local path is troubleshooting output, not a log field.
7. Treat the 500 ms local-I/O value as a caller deadline, not cancellation of a
   native filesystem request or universal process settlement. Verify logging
   failure does not replace the core result and critical cleanup/disposal starts
   before any awaited diagnostic write.
8. With a caller root whose optional session permission overlay is omitted,
   verify one `plugin.task_root_permission.normalized` warning is emitted at most
   once for the launch. It must contain only the standard correlation envelope,
   with no session/task/permission IDs, policy content, paths, or per-call count.
9. Exercise `external_directory` with `once`, `always`, and `reject`. Verify the
   request/reply lifecycle uses only documented booleans, reply/lifetime, and the
   standard envelope. Run the focused plugin-registration integration for the
   same-scope repeat-after-`always` and bounded diagnostics-limit warnings. No
   path, pattern, metadata, or host permission ID may appear.
10. Make the fake ControlMaster emit split and repeated `channel N: open failed`
    stderr while OpenCode is active. Verify no raw line reaches inherited TUI
    stderr, the first 64 messages become bounded `ssh.master.*` records, and one
    limit warning follows. Confirm no channel number, detail, alias, or path is
    retained.
11. Fail one direct SSH-backed package operation and one SFTP-backed operation.
    Verify `plugin.ssh.transport.failed` records the correct concurrent
    top-level operation and transport without commands, paths, output, or raw
    errors. Treat the correlated timestamps and launch IDs as candidate matching,
    not proof that an internal OpenSSH channel number belongs to one operation.

## Remote Test Directory

Create unique project and external-scope directories after reviewing both paths:

```bash
ssh test-alias 'umask 077; mkdir -p -- /tmp/opencode-ssh-fit-YYYYMMDD /tmp/opencode-ssh-fit-external-YYYYMMDD/child'
```

The external directory must remain a disposable sibling, not a descendant, of
the launch workdir.

Start the test OpenCode in a second local terminal:

```bash
opencode-ssh test-alias /tmp/opencode-ssh-fit-YYYYMMDD
```

The launcher must stop with an error if the normal server plugin does not
publish its ready handshake. Do not continue if local built-in tools appear
instead.

## Read-Only Checks

Ask the test session to perform these in order:

1. Call `remote_status` and report alias, workdir, connection ID, health, remote
   hostname, remote user, and validated identity workdir. Verify that the tool's
   internal `hostname; whoami; pwd -P` result matches the intended target and
   canonical workdir, with no separate Bash preflight call.
2. If sudo testing is required, run `sudo -n id -u`; expect `0` without a
   password prompt.
3. Create no files yet; list the empty test directory with `read` and `glob`.
4. Request a read of `/etc/os-release`; verify an external-directory permission
   prompt appears before access and test deny once. Then request the disposable
   sibling `/tmp/opencode-ssh-fit-external-YYYYMMDD`, choose `Allow always`, and
   in the same OpenCode process repeat that exact path plus its seeded `child`
   descendant. Verify no second `external_directory` prompt appears for that
   scope. A separate `read` prompt may still apply. Access to a different
   disposable external scope must still ask.
5. Run a normal local Serper/MCP action and verify that integration still works.

## Disposable Two-Sibling TUI Gate

This gate tests local OpenCode Task orchestration and SSH-backed child project
tools together. Run every case from the top-level session inside the disposable
directory. Do not infer a pass from the loader or ready marker.

### Preparation And Attribution

1. Record the exact `opencode --version` without recording connection details.
2. Use a reviewed temporary OpenCode profile with `subagent_depth` absent or set
   to one. Do not weaken an existing explicit deny or custom-agent restriction.
3. With no explicit global or configured `explore` rule matching
   `remote_status`, verify the package default is `ask`, not `allow`.
4. For permission-attribution observations, set the exact OpenCode permission
   keys `remote_status`, `bash`, and `edit` to `ask` in a reviewed temporary
   global or per-agent profile. `write` and `apply_patch` request `edit`.
5. Have the root independently call `remote_status` before delegation. Verify
   its embedded hostname/user/workdir result and that no preflight Bash prompt or
   Bash tool card appears.
6. Record whether generated OpenCode SSH system context says Task resume is
   enabled or disabled. Do not infer this from ordinary OpenCode behavior.
7. Create no tracked configuration and restore the temporary local profile after
   the gate.

Pass condition: every permission prompt identifies the child/session and exact
tool operation being approved. Only `external_directory` offers reusable
`always`, for the exact normalized path and descendants until process exit.
Record that OpenCode applies it instance-wide to root/child sessions; it is not
preflight evidence and does not approve the separate operation. Other package
permissions ask on each matching call unless configured policy allows them.
The reusable approval may supersede matching global, per-agent, or session
denies until process exit. External paths containing literal `*`, `?`, or `\\`
must reject before access.

### Package Preflight And Task Guard Case

1. In a fresh root session, request one package project read and one Task call
   before preflight. Both must be rejected before path preparation, SSH/SFTP, or
   child creation.
2. Complete one root `remote_status`. Verify a normal package read now reaches
   its `read` permission boundary.
3. Call `remote_status` again and deny that new `remote_status` prompt. The
   attempt must immediately invalidate old preflight evidence. Verify a package
   project tool and root Task are both blocked and no fixed identity SSH command
   ran for the denied status call.
4. Complete one new allowed `remote_status`. Verify the root can use package
   tools again immediately.
5. In a fresh disposable session, create a session-level `ask` for one matching
   SSH project permission, such as `bash`, then request Task delegation. On
   OpenCode 1.18.18 the package must reject delegation because parent session
   asks are not inherited. Remove that session rule and use reviewed global or
   per-agent policy for subsequent cases.
6. Ask the root Task tool to run with `background: true`. Pass only if package
   code rejects it, no background child starts, and foreground behavior remains
   available. Confirm the launched OpenCode environment forces background
   subagents off.
7. In the hermetic generation test, hold an active package project SSH/SFTP or
   mutation lease, begin a newer `remote_status` attempt for that session,
   and verify the lease aborts. Verify the new generation does not claim to undo
   an already completed remote commit or already-admitted upstream Task run.

Record the exact `remote_status`, `bash`, and `edit` prompts and every rejected
call. Prompt text is not evidence for these package runtime guards; the observed
absence of preparation/child activity is required.

### Same-Launch Resume Qualification Case

Collect both positive and negative evidence. Loader output or generated prompt
text alone is not a pass, and exact model continuity is not a pass condition.

Positive qualification on a release-qualified launch:

1. Confirm the exact selected OpenCode version is 1.18.18, confirm
   `opencode-ssh self-test` reports Task resume enabled, and confirm generated
   system context for the real launch also says enabled. This proves only
   startup qualification.
2. From one preflighted root, launch a fresh foreground direct child. Require its
   own `remote_status`, let it complete successfully, and preserve the exact
   returned `task_id` together with its `subagent_type`.
   Exercise the normal TUI-shaped omitted root permission overlay and verify it
   fingerprints as `[]`; an explicit malformed root value must still fail.
   Verify fresh admission is one-shot and registration binds unchanged root
   permission/security-epoch evidence, preserves inherited SSH-project denies,
   and requires explicit matching child agent and permission array.
3. Resume with that ID verbatim from the same root and with the same
   `subagent_type`. Verify the existing direct-child session is used and no new
   child is created.
4. Verify the resumed child cannot use a package project tool on its old
   preflight. It must call package `remote_status` before project access. Verify
   the tool internally runs and validates exact `hostname; whoami; pwd -P`, with
   no separate Bash call or Bash permission prompt.
5. Let the resumed run complete successfully. Verify exact launch/root/direct
   child/type, observed agent, root/child permissions, and security epochs still
   match. The complete new `remote_status` generation is required before a
   fully validated completion may release that child for a later sequential
   resume.
6. Require the root to wait for the resumed run, repeat `remote_status`, inspect
   remote Git status/diff or every changed path, and report the resumed run
   separately. Record any real remote descendant as unsettled until independently
   checked.

Negative qualification and fail-closed evidence:

1. With a reviewed fixture missing callable `client.session.get`, or with
   malformed/mismatched selected and loader runtime evidence, verify protocol v3
   blocks startup before ControlMaster or SSH. This is not a resume-disabled
   compatible launch.
2. With a different loader/runtime-compatible version, verify startup succeeds,
   generated context says resume disabled, `task_id` is rejected before upstream
   execution, and a fresh foreground Task remains available.
3. On an enabled launch, verify an unknown or invented ID is rejected before
   upstream creates a fresh child. Verify an ID from a prior launch and an ID
   owned by another root are also rejected.
4. Verify a changed `subagent_type`, changed observed agent, changed parent,
   changed root/child permissions, or changed security epoch rejects before
   reservation. Verify a direct child cannot initiate Task or resume.
5. Exercise both security-epoch event pairs: OpenCode v2 `permission.asked`
   followed by `permission.replied` carrying `requestID`, and legacy
   `permission.updated` followed by `permission.replied` carrying `permissionID`.
   Malformed or unknown relevant delivery must invalidate fail closed, and the
   event hook must settle without a detached rejection.
6. Submit two overlapping resumes for one eligible child only in the hermetic
   release fixture. Exactly one may be atomically admitted; the other must be
   rejected as busy or uncertain. Background Task remains rejected.
7. In hermetic failure/cancellation cases, verify that, once reserved, a failed,
   missing, malformed, aborted, canceled, or uncertain admission/completion
   permanently locks the child for the launch. Do not retry that `task_id`;
   start a fresh child and provide context.

The exact-version baseline must contain the exact six-name manifest and cover
safe same-launch resume with zero failed, skipped, or todo cases. This gate
passed the Task portion 6/6 and the complete Task-plus-permission baseline 7/7 on
exact OpenCode 1.18.18 on 2026-08-28 with one-step `remote_status` preflight and
no separate identity Bash. Earlier `5/5` entries remain historical pre-resume
evidence, not the current result.

### Read-Only Sibling Case

1. Ask the root to launch exactly two direct children concurrently and keep both
   visible in the TUI. Give at least one child a strictly read-only inventory
   task.
2. Require each child, independently and before any project access, to call
   `remote_status`. Verify its internal exact `hostname; whoami; pwd -P` result.
3. Verify both status results identify the expected alias, canonical workdir,
   connection ID, healthy ControlMaster, hostname, and user. Parent or sibling
   results do not count for the other child.
4. Use built-in `explore` for the read-only child. After its status preflight,
   ask it to run one harmless additional package Bash command. Package Bash must
   reject it; then verify package `read`, `glob`, or `grep` remains usable under
   the configured host policy and no mutation occurs.
5. If the root selected external-directory `Allow always` for the disposable
   sibling `/tmp/opencode-ssh-fit-external-YYYYMMDD` in the same process, ask the
   read-only child to inspect that scope. Verify no new `external_directory`
   prompt appears while any separate `read`/`glob`/`grep` policy still applies.
   Record this as OpenCode instance-wide behavior, not inherited child policy or
   package preflight.
6. Ask a child to delegate once. First observe that `task` is normally absent.
   Where a reviewed custom/later config exposes it for this negative check, the
   package runtime guard must reject the child call. No grandchild may appear
   and the child must not substitute a local command.
7. Observe the separate child Task/tool cards and attribute every permission
   prompt, result, failure, or denial to the correct child.
8. Require the root to wait for both children, repeat `remote_status`, and
   remotely verify that the directory remained unchanged.

### Disjoint Mutation Sibling Case

1. Start a fresh turn with exactly two mutation-capable direct children running
   concurrently.
2. Assign one child only `sibling-a/` and the other only `sibling-b/` under the
   disposable workdir. State these as disjoint mutation scopes before launch.
3. Require both children to complete their own one-step `remote_status`
   preflight before reading or writing either scope.
4. Have each child perform one harmless, identifiable file mutation only in its
   assigned directory. Do not let either child inspect or modify the other's
   path as part of the mutation.
5. Verify every `edit` prompt and resulting tool card is attributed to the child
   and path that requested it. Current content may have been pulled before that
   prompt to prepare the diff, but no mutation may precede approval. Shared
   package file operations may serialize; serialization is not a failure.
6. Do not test simultaneous same-path edits. They are unsupported, and conflict
   or lock checks are backstops rather than sibling coordination.
7. Require the root to wait for both children, repeat `remote_status`, inspect
   remote Git status and diff or read both non-Git files, and report every child
   change, failure, cancellation, and uncertainty.

Pass condition: both disjoint files contain their intended content, no path was
crossed, the root verifies both results remotely, and no temporary or lock
artifact remains. Record this as the pending real-SSH sibling boundary, not as
installed-Task fake-SFTP mutation evidence.

### Fail-Closed Permission Case

1. In a fresh disposable two-child run, deny one child's `remote_status` request
   while allowing the other child to complete its one-step preflight.
2. Verify the denied child performs no Bash call, read, or mutation and does not
   fall back to local Bash or inherit the root's evidence.
3. On the allowed child, call `remote_status` again and deny the recheck. Verify
   its previously completed preflight is invalidated immediately and subsequent
   package read/glob/grep calls are rejected until a new fully validated
   `remote_status` succeeds.
4. Verify the root reports the stopped child separately and does not claim the
   overall delegated task fully succeeded.

### Two-Sibling Cancellation Case

1. Launch two fresh direct children and require both independent preflights.
2. Have each child start an SSH-backed disposable command that prints a unique
   marker and then waits, such as `printf 'child-a waiting\n'; sleep 30` and the
   corresponding `child-b` command.
3. After both child Bash cards are visibly running, invoke the configured root
   session or foreground Task interrupt action.
4. Verify the root and both local child sessions settle, both local SSH-backed
   tool calls settle, and neither command is automatically retried.
5. Inspect the remote target for both matching waits and all disposable paths
   before any retry. Record surviving or unverified remote descendants as an
   uncertainty; local settlement is not proof of universal remote termination.

## Live Bash Output

Run these checks only through the agent's SSH-backed `bash` tool in the actual
OpenCode TUI. Manual shell commands entered with a leading `!` are local and do
not test this feature.
OpenCode 1.18.18 is the recorded baseline; repeat all five checks whenever the
launcher warns that a different OpenCode version is active. The automatic
loader check does not replace these visual observations.

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
9. Verify a newly created package file has numeric mode `0600`. Set a harmless
   existing test file to a reviewed numeric mode, edit it, and verify that mode
   is retained from final validation.
10. Do not claim owner, group, ACL, xattr, capability, timestamp, hard-link, or
    other metadata preservation. The replacement contract covers only content
    and numeric mode.

## Root Workspace

Exit the test TUI, then run a separate read-only session:

```bash
opencode-ssh test-alias /
```

Verify `remote_status`, an ordinary post-preflight `pwd`, and reading
`/etc/os-release`. A root workspace must not request external-directory
permission, but Unix user permissions still apply. Do not mutate system paths
during this fit trial.

## Lifecycle

1. Exit OpenCode normally and verify the launcher exits.
2. Exit the root-workspace trial, then start the original alias and disposable
   `/tmp/opencode-ssh-fit-YYYYMMDD` workdir again. Verify its prior session is
    visible, but its old child ID is not eligible for Task resume in the new
    launch. Verify the earlier interactive external-directory `always` approval
    is also gone and `/tmp/opencode-ssh-fit-external-YYYYMMDD` asks again.
3. Interrupt one test run with Ctrl-C and verify no `opencode`, SSH master, or
   control socket remains for that launch.

## Cleanup

Review the exact unique path before deletion:

```bash
ssh test-alias 'rm -rf -- /tmp/opencode-ssh-fit-YYYYMMDD /tmp/opencode-ssh-fit-external-YYYYMMDD'
```

Before deletion, verify both sibling mutation paths, any cancellation processes,
and `.opencode-lock-*` or sibling temporary artifacts have been accounted for.
After deletion, exit the TUI and verify the local OpenCode sessions, SSH master,
control socket, ready marker, and mirror for the launch are gone.

Record evidence in `docs/upstream-fit-report.md`. Never include credentials,
private key data, provider tokens, production content, real aliases, hostnames,
usernames, IP addresses, workdirs, target IDs, or exact OS/kernel fingerprints.
Record the exact OpenCode version and distinguish the loader, automated Task,
installed permission engine, same-launch resume positive/negative qualification,
real-SSH sibling, and manual TUI results; a pass at one boundary is not evidence
for another. Keep the fresh exact six-scenario Task plus one permission baseline
and installed real-Task fake-SFTP mutation recorded as completed 2026-08-28 fake-
transport evidence. Keep real-SSH two-sibling mutation and real permission-UI/
direct-child TUI as separate pending boundaries
until each is observed. Formal direct-child release remains incomplete while
either remains pending; `npm run test:real` was not run in the 2026-08-28 cycle.
