# OpenCode SSH Audit Hardening Design

Status: HISTORICAL DESIGN dated 2026-08-22. Its task and acceptance status records
that cycle; current source and authoritative documentation, including fresh
2026-08-27 evidence, supersede operational and release status below.

## Context

The direct-subagent implementation passed its original automated gates, but an
independent six-agent audit found that several release claims relied on
OpenCode 1.18.18 behavior that is weaker than the package assumed. The audit
also found pre-existing file-commit and lifecycle risks that become more
important when multiple sessions share one SSH launch.

This specification supersedes the safety and acceptance claims in
`2026-08-22-opencode-ssh-direct-subagents-design.md`. That document remains a
historical implementation record.

## Goals

- Keep multiple foreground direct siblings available when the launch can
  enforce the required boundary.
- Prevent direct children, resumed sessions, and background Task calls from
  escaping the one-level topology.
- Enforce root and child SSH preflight in package code, not only in prompt text.
- Preserve restrictive session permission intent despite OpenCode 1.18.18 not
  inheriting parent `ask` rules into Task children.
- Prevent package-generated persistent approvals from crossing session
  boundaries.
- Fail closed when another tool occupies the `remote_status` identity.
- Stop automatic pre-permission ingestion of remote `AGENTS.md` content.
- Harden SFTP-backed file replacement, lock ownership, cancellation, and local
  manifest persistence.
- Make startup, disposal, and process cleanup evidence match the documented
  lifecycle.
- Make the exact OpenCode baseline gate non-skipping and self-attesting.
- Correct every capability and security claim to distinguish code enforcement,
  OpenCode host policy, operator procedure, and pending manual evidence.

## Trust Boundary

OpenCode itself, configured same-process plugins, and same-UID local processes
remain trusted. The package does not attempt to sandbox a hostile plugin that
can read the launch environment, mutate hook arguments, or invoke the owned
ControlMaster directly. Documentation must state this boundary explicitly.

Remote repository content is untrusted. It must not be read automatically
outside normal session tool permissions and preflight enforcement.

## Direct-Task Runtime Guard

Resolved policy remains launch-local:

1. Preserve explicit `subagent_depth: 0`; otherwise use effective depth one.
2. Add `task` once to `experimental.primary_tools`.
3. Add a default `remote_status: ask`, not `allow`, only when neither global nor
   configured `explore` policy explicitly matches `remote_status`.
4. Preserve explicit global and per-agent rules and their order.

The resolved policy improves catalogs and normal permission behavior but is
not the security backstop. A package `tool.execute.before` guard must validate
every Task call:

- The caller session must be retrievable; lookup failure denies Task.
- The caller must have no `parentID`.
- The caller must have completed this launch's package-enforced preflight.
- `task_id` resume is rejected because OpenCode 1.18.18 does not validate
  ownership or reshape an existing session.
- `background: true` is rejected. The launcher also forces
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` for its OpenCode child.
- A parent session rule with action `ask` that can match an SSH project
  permission rejects delegation because OpenCode 1.18.18 would drop that rule.
  The error must identify this compatibility limit and require a global or
  agent-level policy instead.

The project-permission set includes wildcard matches for `remote_status`,
`bash`, `read`, `edit`, `glob`, `grep`, and `external_directory`. Explicit
parent denies remain inherited by OpenCode and are not weakened.

This runtime guard remains authoritative if a later config hook changes depth
or removes `task` from `primary_tools`. Readiness therefore means this plugin
installed its guard and policy, not that no trusted later plugin changed config.

## Session Preflight State

The plugin owns an in-memory state machine keyed by OpenCode session ID:

1. `remote_status` may run without prior state.
2. A successful, healthy package `remote_status` call marks status complete for
   that session.
3. Before full preflight, package Bash permits only the exact command
   `hostname; whoami; pwd -P`, and only after status completed.
4. Identity succeeds only on exit zero, non-empty hostname and user lines, and
   a final path equal to the canonical launch workdir.
5. All other package project tools reject before path resolution, SSH, SFTP, or
   permission preparation until both states are complete.
6. The built-in `explore` agent may use package Bash only for the exact identity
   preflight. Its package `read`, `glob`, and `grep` tools remain available
   after preflight; arbitrary Bash mutation is denied.
7. Session deletion clears state. Parent state is never copied to a child.

If an MCP or other catalog entry overwrites `remote_status`, it cannot mark this
private state, so package project tools remain fail closed. Config containing
an enabled `mcp.remote` server is rejected because it can produce the exact
`remote_status` ID through a `status` tool. Other same-name plugin collisions
remain inside the documented trusted-plugin boundary.

## Permission Persistence

Every package permission request uses an empty `always` list. This removes the
package's contribution to OpenCode 1.18.18's instance-wide approved-rule array,
where an earlier approval can override a later session-specific patterned deny.
Users may still configure stable global or per-agent rules in OpenCode config.

`remote_status` continues to ask before its health SSH channel. Other tools may
need canonicalization or a baseline pull to build a permission request; docs
must describe that preparatory access accurately. No mutation may occur before
its corresponding edit or Bash permission succeeds.

## Remote Instructions

The plugin no longer auto-reads remote root `AGENTS.md` during startup. The
generic packaged safety instructions and bounded generated target context still
reach root and direct children. A session may explicitly read remote project
instructions after preflight through the normal permission-aware read tool.

This removes symlink escape, preflight bypass, and automatic provider egress of
untrusted remote instruction bytes.

## File Transaction Hardening

The existing operation-wide local mutex remains. The following invariants are
added:

- Waiting for the mutex is abort-aware. A canceled waiter rejects immediately
  without releasing a later waiter ahead of the active owner and without local
  or remote side effects.
- Canonical mutation paths are revalidated after queue admission and before
  remote commit. A changed canonical target or parent fails closed.
- Conflict baselines are validated before avoidable parent-directory changes
  and again under cooperative locks.
- Remote sibling temporaries are created with mode `0600` before SFTP upload.
- Existing-file mode is taken from the final validation immediately before
  replacement. Only numeric mode preservation is guaranteed; unsupported
  ownership, ACL, xattr, capability, timestamp, and hard-link semantics are
  documented and must not be overstated.
- Replacement uses no-target-directory semantics (`mv -fT --`) and rejects a
  directory target rather than reporting a false successful write.
- Every deterministic lock contains a random owner token. Acquisition,
  uncertain acquisition cleanup, and release operate only on a matching token.
- Cleanup failures preserve the primary error while reporting possible lock or
  temporary artifact paths.
- Multi-file replacement remains per-file atomic, not globally atomic. Errors
  identify committed, failed, and uncertain paths.
- Manifest saves serialize, write immutable snapshots through a sibling
  temporary, and atomically rename. Newer generations cannot be marked saved by
  an older concurrent write.

Descriptor-relative no-follow filesystem operations are outside the current
system-OpenSSH/SFTP architecture. Revalidation narrows but cannot eliminate a
malicious non-cooperating rename race; documentation must retain this residual
risk.

## Lifecycle Hardening

- Only one active production plugin factory may own a launch ID. Duplicate
  activation fails before mirror deletion and releases ownership on failure or
  disposal.
- `SSHPool` tracks active SSH/SFTP operations. Closing the pool rejects new
  calls, aborts active slaves, waits for settlement, and does not own the
  ControlMaster.
- The launcher observes ControlMaster exit both before and after readiness.
- Process supervision has an explicit process-tree policy for OpenCode and the
  compatibility child, with bounded TERM/KILL settlement on supported POSIX
  hosts.
- Cleanup attempts every owned resource and reports cleanup failure instead of
  silently returning success with known residue.

## Test And Release Gates

- Add strict no-emit type checking for TypeScript tests and helpers.
- Add a dedicated baseline Task command that requires an executable, records
  original and resolved paths, requires exact version `1.18.18`, runs all five
  or replacement scenarios, and fails on skip.
- Keep default installed-OpenCode tests skippable only for ordinary developer
  environments; release evidence must use the dedicated command.
- Repair ready-watcher lost notifications, bounded cleanup ownership, provider
  final completeness, exact SSH argv/cardinality, and cross-fixture environment
  scrubbing.
- Add hostile-order tests: project tool before preflight, unhealthy status,
  identity mismatch, child Task attempt, `task_id`, background Task, parent
  session ask, patterned deny after a prior interaction, and MCP collision.
- Add installed Task plus fake-SFTP disjoint mutation coverage if the fixture
  can model the production transaction faithfully. Otherwise keep that boundary
  explicitly pending rather than substituting a synthetic test.

No real SSH or manual TUI command is permitted in this SDD cycle. Those gates
remain pending until the user separately approves a disposable target.

## Documentation Rules

- Use “fail closed” only for behavior enforced by code or OpenCode host policy.
- Label prompt instructions and operator verification as guidance.
- Separate the pre-SSH compatibility marker from normal readiness after SSH
  bootstrap.
- State that package file transactions serialize only inside one plugin
  instance; Bash, MCP, other plugins, and non-cooperating writers are outside
  that mutex.
- State exact supported metadata and atomicity limits.
- Preserve historical test records but never present them as fresh evidence for
  the hardened worktree.

## Non-Goals

- Sandboxing trusted same-process plugins or same-UID local processes.
- Supporting Task resume or background Task in an SSH launch.
- Inferring mutation scopes from arbitrary natural language.
- Safe same-path sibling collaboration.
- Universal termination of real remote descendants.
- Automatic deletion of unknown or non-owned remote locks.
- Claiming formal real-SSH/TUI direct-child support without the pending manual
  gates.

## Acceptance Criteria

- Root project tools and Task reject before root preflight.
- Each direct child independently completes status and identity preflight.
- Project tools reject after missing, denied, unhealthy, or mismatched preflight.
- `explore` cannot use package Bash beyond identity preflight.
- Direct children cannot invoke Task even if a later config hook exposes it.
- `task_id` and background Task are rejected.
- A parent session project-permission `ask` cannot be silently weakened by
  delegation.
- Package permission requests cannot create cross-session `always` approvals.
- An MCP `remote_status` collision cannot satisfy package preflight.
- Startup does not read remote `AGENTS.md`.
- Focused path, commit, lock, manifest, lifecycle, and harness regressions pass.
- The exact 1.18.18 Task gate runs without skips and records its selected binary.
- `npm run lint`, strict test typecheck, unit, integration, complete default,
  smoke, package dry-run, and `git diff --check` pass.
- Documentation contains no claim contradicted by the hardened implementation.
- Real SSH and manual direct-child TUI gates remain explicitly pending.
