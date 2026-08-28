# OpenCode SSH Direct Subagents Design

Status: HISTORICAL DESIGN superseded on 2026-08-22. Current source and
authoritative documentation, including the release-qualified same-launch resume
contract and fresh 2026-08-27 evidence, supersede every operational and release
claim below.

## Goal

Make direct OpenCode Task children work safely in an `opencode-ssh` launch.
The root session may launch multiple first-level children, including concurrent
siblings. A child must independently verify the SSH target and must not launch
another child.

## Current Failure

The production plugin registers `remote_status`, but OpenCode resolves and
filters tools independently for every agent. OpenCode 1.18.18's built-in
`explore` agent has a wildcard deny followed by a fixed read-only allowlist.
That allowlist includes the plugin replacements for `bash`, `read`, `glob`, and
`grep`, but not the custom `remote_status` tool.

The injected SSH safety instructions require every child to call
`remote_status` before project work. Consequently, the child correctly stops:
the safety contract requires a tool that the host filtered out.

## Supported Session Topology

- A root session may create any number of direct children.
- Direct children may run sequentially or concurrently.
- Maximum delegation depth is one.
- A user setting of `subagent_depth: 0` remains authoritative and disables all
  children for that launch.
- An absent setting becomes one.
- A setting greater than one is narrowed to one for the SSH launch without
  changing the user's configuration on disk.
- `task` is a primary-only tool. It must not appear in a newly created child's
  provider-facing tool catalog.
- Historical design relied on OpenCode's runtime depth check for a resumed or
  custom child. The superseding package runtime guard rejects resumed Task and
  every child Task call directly.

Depth limits nesting, not sibling count. Two or more Task calls made by the
root at depth zero remain valid when the effective depth is one.

## Resolved-Config Policy

The launcher must not inject raw permission or agent policy into
`OPENCODE_CONFIG_CONTENT`. That layer cannot see global, managed, environment,
legacy, or earlier plugin configuration and could override a stricter user
rule.

The active production plugin installs policy in its public `config` hook after
OpenCode has merged and normalized configuration:

1. Preserve effective `subagent_depth: 0`; otherwise set the effective value to
   one.
2. Add `task` once to `experimental.primary_tools`, preserving every existing
   value and experimental field.
3. Historical behavior added a launch-local global `remote_status: allow`
   default when no global or configured `explore` rule matched. The superseding
   hardening SDD changes this default to `ask`.

Explicit matching includes action-string policies and wildcard keys. Matching
must follow the tested OpenCode 1.18.18 rules: `*` matches any sequence, `?`
matches one character, path separators are normalized, and the last matching
rule wins. The default is inserted only when no matching explicit rule exists,
so existing rule order is never changed.

The superseded design assumed explicit `allow`, `ask`, and `deny`, including
session rules, would remain effective across delegation. The hardening audit
showed that OpenCode 1.18.18 drops parent session asks in Task children. Current
package code therefore rejects matching root-session asks and directs users to
stable global or per-agent policy. Restrictive custom-agent and primary-tool
policy still applies through OpenCode host policy.

The policy is in-memory and launch-scoped. It never writes an OpenCode config
file.

## Readiness Contract

The normal plugin-ready marker is published from the normal plugin's `config`
hook, after policy application succeeds. Publication is one-shot and
concurrency-safe. An incompatible resolved-config shape fails closed and leaves
the marker absent, causing the launcher to stop. Current normal readiness also
follows ControlMaster startup, workdir canonicalization, and bootstrap
`uname`/Git SSH; it is distinct from the target-free pre-SSH marker.

The isolated compatibility probe remains unchanged. Its marker proves that the
selected OpenCode can load the package and invoke a private config hook. The
normal ready marker proves normal plugin initialization and policy installation.
Neither marker proves a model request, Task execution, child tool invocation,
or TUI behavior.

## Child Preflight And Permissions

Every child independently performs both checks before project work:

1. Call `remote_status` and verify executor, alias, canonical workdir,
   connection ID, and ControlMaster health.
2. Run SSH-backed `hostname; whoami; pwd -P` and compare the result with the
   injected remote context.

The parent's evidence is not transferable. A child that cannot access either
required tool stops without reading or mutating the project.

`remote_status` calls `ToolContext.ask()` with permission `remote_status` before
opening an SSH channel. Under the historical `allow` default this resolved
without UI; current hardening defaults to `ask` when no explicit global/explore
match exists. Explicit `deny` prevents the SSH health command.

The status result also reports the effective direct-subagent policy, including
requested and effective depth when the configured value was narrowed.

There is no Bash fallback for a hidden or denied `remote_status`, and no parent
preflight inheritance.

## Concurrent Siblings

Read-only siblings may overlap. Each child has its own session, prompt, tool
context, permission evaluation, abort signal, and one-shot SSH channels.

All sessions in one launch share the plugin's `SyncEngine`, mirror, manifest,
and operation-wide mutation mutex. Concurrently requested mutations therefore
serialize at the local transaction boundary.

Mutation-capable siblings must receive disjoint path scopes. Concurrent edits
to the same path are not a supported coordination mechanism. A later whole-file
write can semantically replace an earlier result after pulling a fresh baseline.
Remote conflict and lock checks remain backstops against stale or external
writers; they are not a scheduler for cooperating children.

The root waits for all delegated work to settle, remotely verifies the final
status and diff, and reports every child change, conflict, cancellation, timeout,
and uncertainty.

## Cancellation

Canceling a foreground root Task invocation must propagate through OpenCode to
the child session and its local SSH slave process. No command is retried.
Local process settlement and launcher cleanup are automated-test boundaries.
Whether a real remote descendant survived transport cancellation remains an
explicit uncertainty requiring manual inspection.

## Automated Compatibility Test

A hermetic integration test runs the real installed OpenCode server through the
real launcher. It uses a loopback scripted OpenAI-compatible provider and the
existing fake SSH/SFTP executables. No external provider, credentials, or real
SSH target is required.

The provider captures final system prompts and post-filter tool catalogs. It
drives a root request that emits multiple Task calls, then drives each child to
perform its own status and Bash preflight. Fake SSH returns command-specific
canary output so a local built-in Bash fallback is detectable.

The release baseline is OpenCode 1.18.18. The automated test may exercise a
different installed identified version, but that does not create a support
claim. Release evidence must include a run against 1.18.18.

## Non-Goals

- Nested child-to-grandchild delegation.
- Unlimited or configurable SSH delegation depth.
- Inferring safe mutation scopes from arbitrary natural language.
- Safe simultaneous mutation of the same path by sibling agents.
- Per-path replacement of the existing operation-wide mutation mutex.
- Automatically deleting unknown remote locks.
- Enabling experimental background-subagent mode.
- Treating Task as an SSH-backed tool; orchestration remains local.
- Extending the startup compatibility probe to invoke a provider or Task.
- Claiming that a scripted provider proves real-model instruction compliance,
  TUI rendering, permission UI, or remote process termination.

## Acceptance Criteria

- Default OpenCode 1.18.18 `explore` children receive and execute
  `remote_status`.
- A root can run at least two direct sibling children concurrently.
- Historical remote-`AGENTS.md` propagation requirement removed by the
  audit-hardening SDD; current startup supplies generic safety instructions and
  generated target context without reading remote `AGENTS.md`.
- Every child independently executes `remote_status` and SSH-backed Bash.
- `task` is absent from child provider tool catalogs, including a custom child
  agent that explicitly allows it.
- No grandchild session is created.
- Historical blanket session-policy criterion replaced: current release claims
  distinguish stable global/per-agent policy, inherited deny, and the
  OpenCode 1.18.18 parent-session-ask delegation rejection.
- Explicit `remote_status: ask` requests permission before SSH.
- Explicit `remote_status: deny` causes no SSH health command.
- `subagent_depth: 0` remains zero; values above one become one for this launch.
- Concurrently requested distinct-file writes settle without cross-path data or
  leftover temporary/lock artifacts.
- Cancellation produces no retry and no locally running SSH slave afterward.
- The normal ready marker appears only after policy installation succeeds.
- Focused tests, `npm run lint`, complete `npm test`, package smoke, and the
  documented manual TUI gate pass or have an explicit recorded blocker.
