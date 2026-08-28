# OpenCode SSH Direct Subagents Implementation Plan

Status: SUPERSEDED on 2026-08-22 by the OpenCode SSH audit-hardening SDD;
historical implementation/test evidence retained, with real-SSH and manual TUI
gates still pending

> This plan's completed checkboxes record the prior implementation cycle, not
> current hardened release evidence. Use
> `2026-08-22-opencode-ssh-audit-hardening.md` and its shared ledger for current
> controls, tests, and release status. Superseded assumptions include automatic
> remote `AGENTS.md` propagation, an implicit `remote_status: allow`, broad
> session-policy inheritance, and catalog-only Task depth enforcement.

> **For agentic workers:** Implement only the assigned task. Read the linked
> spec and this entire plan before editing. Re-read the shared progress ledger
> immediately before and after work. Update the ledger yourself with files,
> RED/GREEN evidence, commands, results, risks, and the exact resume point.

**Goal:** Allow a root OpenCode SSH session to run multiple safe first-level
subagents while preventing nested delegation and preserving explicit user
permissions.

**Architecture:** Apply a narrow in-memory policy through the resolved OpenCode
`config` hook, publish readiness only after policy installation, and certify the
real Task child boundary with a scripted loopback provider and fake OpenSSH.
Keep Task orchestration local and retain the shared operation-wide SyncEngine
transaction mutex.

**Tech Stack:** TypeScript 5.9, Node.js 22.22.2+, OpenCode 1.18.18,
`@opencode-ai/plugin` 1.18.18, `@opencode-ai/sdk` 1.18.18, Vitest 3.2, system
OpenSSH interfaces with hermetic fixtures.

**Spec:** `docs/superpowers/specs/2026-08-22-opencode-ssh-direct-subagents-design.md`

**Progress:** `.superpowers/sdd/2026-08-22-opencode-ssh-direct-subagents/progress.md`

## Worker Protocol

- Do not edit files outside the assigned task except the shared progress ledger.
- Do not revert or rewrite unrelated worktree changes.
- Follow RED-GREEN-REFACTOR for production behavior.
- Record the focused failing command and failure before implementation.
- Record every verification command and exact result after implementation.
- Re-read the progress ledger before editing it; append only to your assigned
  task section and update the global resume point.
- Do not mark a task complete when tests are skipped, flaky, or blocked.
- Do not commit, amend, push, publish, install globally, or use a real SSH target.
- Return control to the orchestrator after the assigned task and ledger update.

## Global Constraints

- Preserve explicit user `allow`, `ask`, and `deny` semantics.
- Preserve `subagent_depth: 0`; narrow every positive depth to one.
- Multiple root-created siblings are supported; nested delegation is not.
- Do not add permission policy to raw launcher `OPENCODE_CONFIG_CONTENT`.
- Do not weaken preflight or add a Bash fallback for `remote_status`.
- Do not replace or wrap the host Task implementation unless actual integration
  evidence proves the resolved-config controls insufficient.
- Keep compatibility-probe scope and marker claims unchanged.
- Keep all tests real-SSH-free unless explicitly assigned to the manual fit gate.
- Do not add same-path sibling mutation guarantees.

---

### Task 1: Resolved Subagent Policy And Status Permission

**Owner scope:** production policy, status tool, normal ready timing, focused
unit and direct plugin integration tests.

**Files:**
- Create: `src/subagent-policy.ts`
- Create: `test/unit/subagent-policy.test.ts`
- Create: `test/unit/status-tool.test.ts`
- Modify: `src/tools/status.ts`
- Modify: `src/index.ts`
- Modify: `test/integration/plugin-registration.test.ts`
- Modify only if needed: `test/unit/launcher-config.test.ts`

**Interfaces:**
- Produces: a pure resolved-config policy applicator and immutable policy result
- Produces: effective depth zero or one
- Produces: conditional launch-local `remote_status` default
- Produces: deduplicated `experimental.primary_tools: [..., "task"]`
- Produces: permission-aware `remote_status`
- Changes: normal ready publication occurs from the normal config hook

- [x] **Step 1: Add failing permission and depth policy tests**

Cover empty config; action-string permission; exact allow/ask/deny; global and
`agent.explore` wildcard rules; `remote_*`; `remote?status`; rule order;
disabled explore; malformed shapes; idempotence; preservation of unrelated
agents and experimental fields; absent/zero/one/greater-than-one depth; and
deduplicated primary tools.

- [x] **Step 2: Run policy tests and record RED**

Run: `npm run test:unit -- test/unit/subagent-policy.test.ts`

- [x] **Step 3: Implement the minimal pure policy helper**

Use a small local structural type because the legacy plugin `Config` type omits
newer fields. Reproduce only the tested OpenCode wildcard semantics needed to
detect an explicit matching rule. Throw on an incompatible resolved shape.

- [x] **Step 4: Add failing status permission tests**

Assert `ctx.ask()` occurs before SSH; rejected permission performs no SSH;
allowed execution preserves target metadata and adds subagent policy metadata.

- [x] **Step 5: Run status tests and record RED**

Run: `npm run test:unit -- test/unit/status-tool.test.ts`

- [x] **Step 6: Implement status permission and policy reporting**

Request permission `remote_status` with target metadata before `sshPool.exec()`.
Do not request Bash or external-directory permission.

- [x] **Step 7: Add failing normal config-hook readiness tests**

Assert the ready file is absent immediately after plugin factory settlement,
policy is installed by `hooks.config`, readiness then appears with mode 0600,
explicit restrictions are preserved, repeated hook calls are safe, and a policy
failure leaves readiness absent.

- [x] **Step 8: Integrate policy and move readiness**

Keep the compatibility-probe branch unchanged. Apply policy on every normal
config-hook call and guard only the ready publication with a shared one-shot
promise.

- [x] **Step 9: Verify Task 1**

Run: `npm run lint`

Run: `npm run test:unit -- test/unit/subagent-policy.test.ts test/unit/status-tool.test.ts`

Run: `npm run build && npm exec -- vitest run test/integration/plugin-registration.test.ts`

- [x] **Step 10: Update the progress ledger and return to the orchestrator**

### Task 2: Hermetic Real OpenCode Task Harness

**Owner scope:** reusable scripted provider, installed OpenCode server fixture,
command-routed fake SSH support, and one minimal root-to-child harness smoke.

**Files:**
- Create: `test/helpers/scripted-openai-provider.ts`
- Create: `test/helpers/installed-opencode-task-fixture.ts`
- Create: `test/integration/opencode-subagent.test.ts`
- Modify: `test/fixtures/bin/opencode-debug`
- Modify: `test/fixtures/bin/ssh`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: strict loopback OpenAI-compatible streaming fixture
- Produces: isolated real `opencode serve` lifecycle fixture
- Produces: exact fake-SSH stdin response routing and fail-unmatched mode
- Declares: direct exact dev dependency `@opencode-ai/sdk: 1.18.18`

- [x] **Step 1: Add fixture-level tests for scripted provider and SSH routing**

Use predicate-matched queued responses, strict unmatched failure, SSE text and
tool-call chunks, request capture, loopback-only binding, and deterministic
shutdown. Preserve existing fake SSH behavior when routing is absent.

- [x] **Step 2: Run fixture tests and record RED**

Run the narrowest new Vitest files without a real OpenCode session.

- [x] **Step 3: Implement provider and SSH fixture extensions**

Never execute response-table input as a local shell command. Require exact
stdin matches, validate JSON shape, and optionally require a live fake master.

- [x] **Step 4: Add opt-in serve mode to the debug wrapper**

Keep `--version` and compatibility `debug config` behavior unchanged. On empty
argv plus a test-only flag, start the installed executable as
`serve --hostname=127.0.0.1 --port=0`, preserve signal forwarding, and expose
the listening URL to the parent test.

- [x] **Step 5: Build the isolated installed-OpenCode fixture**

Use isolated HOME/XDG/TMP paths, a provider-only config, disabled updates/share/
project config/default plugins/external skills/LSP/model fetches, existing fake
SSH/SFTP, seeded offline config dependencies, bounded diagnostics, and complete
cleanup. Skip only when OpenCode is absent, matching the existing loader test.

- [x] **Step 6: Prove one real Task child can complete**

Drive a root session through the v2 SDK. Script root Task, child
`remote_status`, child SSH-backed Bash, child completion, and root completion.
Assert parent/child identity, injected safety and remote context, plugin Bash
description, SSH canary output, and no local Bash canary.

- [x] **Step 7: Verify Task 2**

Run: `npm run lint`

Run: `npm run build && npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose`

- [x] **Step 8: Update the progress ledger and return to the orchestrator**

### Task 3: Multiple Siblings, Depth Boundary, And Cancellation

**Owner scope:** extend the real OpenCode harness with the complete supported
session topology and permission cases. Do not redesign Task or fixtures unless a
recorded harness defect requires it.

**Files:**
- Modify: `test/integration/opencode-subagent.test.ts`
- Modify only as required: `test/helpers/scripted-openai-provider.ts`
- Modify only as required: `test/helpers/installed-opencode-task-fixture.ts`
- Modify only as required: `test/fixtures/bin/ssh`

- [x] **Step 1: Add a failing concurrent sibling scenario**

Have one root model response emit two Task calls. Use a deterministic barrier to
hold the first child until the second provider request arrives. Use one
`explore` and one `general`/custom child that explicitly allows Task.

- [x] **Step 2: Assert child policy and independent preflights**

Both children share the root parent ID, neither has children, and both
independently call status and Bash; this historical cycle also asserted remote
`AGENTS.md` context, which the superseding hardening SDD deliberately removes.
Both provider catalogs omit `task`. The root receives both results and performs
final remote verification.

- [x] **Step 3: Add restrictive policy cases**

Cover inherited/session `remote_status` deny with no health SSH call,
`subagent_depth: 0` with no child creation, and configured depth greater than
one narrowed to one. Assert explicit restrictions are not silently weakened.

- [x] **Step 4: Add cancellation propagation**

After two children start long fake SSH-backed commands, cancel the root session.
Assert local slave PIDs terminate, no tool part remains running, no retry occurs,
and cleanup diagnostics are bounded. Do not claim real remote descendants died.

- [x] **Step 5: Verify Task 3**

Run: `npm run build && npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose`

- [x] **Step 6: Update the progress ledger and return to the orchestrator**

### Task 4: Shared SyncEngine Sibling Mutation Coverage

**Owner scope:** focused deterministic tests of already intended shared-engine
serialization and abort cleanup. Production SyncEngine changes require explicit
orchestrator review before implementation.

**Files:**
- Modify: `test/unit/sync-engine.test.ts`
- Modify only if required by a demonstrated defect: `src/sync-engine.ts`
- Modify only if required: relevant write-tool test/helper

- [x] **Step 1: Add a concurrent distinct-file mutation test**

Invoke two mutation operations with distinct child session IDs and paths. Use a
barrier inside the first transaction. Assert the second cannot mutate the mirror
until the first settles, both remote files retain intended content, manifest
entries are correct, and no temporary/lock artifact remains.

- [x] **Step 2: Add abort-after-upload cleanup coverage**

Abort after a sibling temporary upload but before final validation/rename.
Assert destination remains unchanged, owned temp and lock paths are removed,
local transaction directories are removed, and no retry occurs.

- [x] **Step 3: Preserve same-path non-guarantee**

Keep or strengthen stale-baseline/lock tests without claiming that cooperating
same-engine writes always conflict. Record the disjoint-scope requirement.

- [x] **Step 4: Verify Task 4**

Run: `npm run test:unit -- test/unit/sync-engine.test.ts`

- [x] **Step 5: Update the progress ledger and return to the orchestrator**

### Task 5: Safety Contract And Documentation

**Owner scope:** documentation only after verified production and automated
behavior is available. Do not claim a gate that was not run.

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/installation-and-usage.md`
- Modify: `SECURITY.md`
- Modify: `opencode-ssh-remote-use/opencode-ssh-safety.md`
- Modify: `docs/upstream-fit-checklist.md`
- Modify only with fresh evidence: `docs/upstream-fit-report.md`
- Modify: `AGENTS.md`

- [x] **Step 1: Document the exact supported topology**

State that the root may run multiple direct siblings, Task orchestration is
local, children cannot delegate, and depth is not sibling count.

- [x] **Step 2: Document preflight and permission behavior**

Require independent status and Bash checks, preserve explicit deny/ask, forbid
local fallback, and explain that a restricted custom child must explicitly
allow required tools.

- [x] **Step 3: Document concurrent mutation limits**

Require disjoint child mutation scopes, parent final verification, and complete
reporting of child changes and uncertainty. Do not promise same-path safety.

- [x] **Step 4: Preserve compatibility-probe boundaries**

Explicitly state that loader and ready markers do not invoke Task or certify TUI
behavior. Add the separate real Task automated and manual gates.

- [x] **Step 5: Add manual fit cases**

Cover two visible siblings, per-child preflight and permissions, two disjoint
disposable mutations, no child Task, cancellation, parent verification, and
cleanup. Keep real connection details out of tracked files.

- [x] **Step 6: Verify documentation consistency**

Search all current capability, limitation, and compatibility claims. Update the
fit report only for commands actually executed during this work.

- [x] **Step 7: Update the progress ledger and return to the orchestrator**

### Task 6: Full Verification And Release Evidence

**Owner:** orchestrator.

- [x] **Step 1: Review all worker diffs against the spec**

- [x] **Step 2: Run static and focused gates**

Run: `npm run lint`

Run: `npm run test:unit`

Run: `npm run test:integration`

- [x] **Step 3: Run the complete default gate**

Run: `npm test`

Run: `npm run test:smoke`

Run: `npm pack --dry-run`

Run: `git diff --check`

- [x] **Step 4: Run the exact OpenCode 1.18.18 baseline gate**

Record the executable and version. Run the real Task integration with no skip.
Do not install globally without explicit user approval; use an already approved
or isolated test binary.

- [ ] **Step 5: Run opt-in real SSH and manual TUI gates only on an approved disposable target**

If unavailable, record them as pending and do not broaden documentation claims.

- [x] **Step 6: Finalize the progress ledger**

Record final files, commands, results, skipped/manual gates, remaining risks,
and the exact next action. Do not commit unless explicitly requested.
