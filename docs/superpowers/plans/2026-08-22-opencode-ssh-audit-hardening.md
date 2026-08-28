# OpenCode SSH Audit Hardening Implementation Plan

Status: Tasks 1-6 complete; Task 7 orchestrator verification and independent
review pending

> **Worker contract:** Work only on the assigned task. Before editing, read the
> complete spec, this complete plan, and the shared progress ledger. Re-read the
> ledger immediately before updating it. Every agent must update the ledger with
> ownership, files, RED/GREEN evidence, risks, and an exact resume point before
> returning to the orchestrator.

**Goal:** Resolve the independent audit blockers while preserving safe
foreground direct siblings and the existing system-OpenSSH architecture.

**Spec:** `docs/superpowers/specs/2026-08-22-opencode-ssh-audit-hardening-design.md`

**Progress:** `.superpowers/sdd/2026-08-22-opencode-ssh-audit-hardening/progress.md`

## Worker Protocol

- Agents run sequentially because every worker updates one shared ledger.
- Do not edit files outside the assigned scope except the shared ledger.
- Do not revert or rewrite inherited dirty-worktree changes.
- Follow RED-GREEN-REFACTOR for production behavior.
- Record the narrow failing command and observed failure before implementation.
- Record exact verification commands, pass/fail/skip counts, and diagnostics.
- Re-read the ledger immediately before editing it; update only the assigned
  task report and global resume fields.
- Do not mark a task complete when a required test skipped, flaked, or failed.
- Do not commit, amend, push, publish, install globally, use real SSH, or run a
  manual TUI gate.
- Return to the orchestrator after the ledger is durable.

## Global Constraints

- OpenCode 1.18.18 is the release baseline.
- Preserve compatibility-probe pre-SSH ordering and isolation.
- Keep OpenCode Task orchestration local and project tools SSH/SFTP-backed.
- Preserve explicit depth zero and direct foreground siblings.
- Reject Task resume and background Task for SSH launches.
- Do not trust prompt compliance as a security control.
- Do not add local shell fallback or SSH command retry.
- Preserve literal alias argv and owned ControlMaster fail-closed behavior.
- Preserve unknown-lock fail-closed behavior.
- Keep same-path sibling mutation unsupported.

---

### Task 1: Session Safety And Direct-Task Guard

**Owner scope:** policy, package-enforced preflight state, Task hook guard,
permission persistence, and focused unit/plugin tests.

**Primary files:**

- Create: `src/session-safety.ts`
- Create: `test/unit/session-safety.test.ts`
- Modify: `src/subagent-policy.ts`
- Modify: `src/index.ts`
- Modify: `src/tools/status.ts`
- Modify: `src/tools/bash.ts`
- Modify: tool construction or a shared tool wrapper as required
- Modify: `src/cli.ts` only for the background-subagent environment override
- Modify: focused policy/status/plugin tests

- [x] Add RED tests for root/child preflight ordering, unhealthy status,
  identity mismatch, explore Bash denial, state cleanup, `task_id`, background,
  child Task, parent session project `ask`, and MCP collision.
- [x] Change the implicit status default from allow to ask while preserving
  explicit global/agent policies.
- [x] Remove package-generated `always` approval patterns from all permission
  requests.
- [x] Implement per-session status/identity state and gate every package project
  tool before remote preparatory access.
- [x] Implement the Task before-hook guard using the current session record.
- [x] Force background subagents off in the launched OpenCode environment.
- [x] Verify focused unit and plugin integration tests and update the ledger.

### Task 2: Remote Context And Instruction Containment

**Owner scope:** remove automatic remote instruction ingestion and update
target-context tests without weakening packaged safety instructions.

**Primary files:**

- Modify: `src/remote-system-prompt.ts`
- Modify: `src/index.ts` if its context contract changes
- Modify: remote context/unit/loader/Task integration tests

- [x] Add RED coverage proving startup does not issue an `AGENTS.md` SSH read or
  include remote instruction bytes in provider context.
- [x] Remove automatic remote `AGENTS.md` loading.
- [x] Preserve bounded generated target context and generic safety injection.
- [x] Verify focused loader/context/Task tests and update the ledger.

### Task 3: SyncEngine Commit And Manifest Hardening

**Owner scope:** mutation queue, canonical revalidation, secure temp creation,
replacement semantics, owned locks, partial errors, and manifest persistence.

**Primary files:**

- Modify: `src/sync-engine.ts`
- Modify: `src/manifest.ts`
- Modify: `src/remote-path-resolver.ts`
- Modify: `src/path-mapper.ts` only if manifest mapping requires it
- Modify: mutation tools only for cancellation/path interfaces
- Modify: relevant unit tests

- [x] Add deterministic RED tests for canceled queued waiters, canonical-path
  change, preflight directory side effects, temp mode, concurrent chmod,
  destination-directory replacement, uncertain lock acquisition, token-safe
  release, cleanup error reporting, concurrent manifest saves, and a second-file
  partial commit.
- [x] Make queue admission abort-aware without permitting successor overlap.
- [x] Revalidate canonical path/parent at queue admission and final commit.
- [x] Precreate remote temporary files privately and use final validated mode.
- [x] Use no-target-directory replacement semantics.
- [x] Add owner tokens and conditional lock cleanup.
- [x] Return actionable partial/cleanup uncertainty.
- [x] Serialize and atomically publish manifest generations.
- [x] Verify focused path/SyncEngine/manifest suites and update the ledger.

### Task 4: Lifecycle And Process Supervision

**Owner scope:** per-launch plugin ownership, active slave settlement, pre-ready
master monitoring, process trees, and cleanup reporting.

**Primary files:**

- Modify: `src/index.ts`
- Modify: `src/ssh-pool.ts`
- Modify: `src/process.ts`
- Modify: `src/cli.ts`
- Modify: control-master/process/lifecycle/plugin tests

- [x] Add RED tests for duplicate active factory ownership, pool close during
  active SSH/SFTP, calls after close, pre-ready master death, TERM/KILL process
  descendants, and each launcher cleanup failure.
- [x] Claim launch ownership before mirror deletion and release it on every
  failure/disposal path.
- [x] Track, abort, and await active pool operations without owning the master.
- [x] Observe master exit throughout startup and active runtime.
- [x] Add bounded process-tree termination on supported POSIX systems.
- [x] Attempt every cleanup and surface known residue without masking the
  primary failure.
- [x] Verify focused lifecycle/process suites and update the ledger.

### Task 5: Exact Baseline And Harness Reliability

**Owner scope:** non-skipping exact-version command, strict test typecheck,
fixture watchers, provider/launcher cleanup, SSH attribution, and environment
isolation.

**Primary files:**

- Create: `tsconfig.test.json`
- Modify: `package.json`
- Modify: `test/helpers/**`
- Modify: `test/fixtures/bin/opencode-debug`
- Modify: `test/fixtures/bin/ssh`
- Modify: installed Task and fixture unit tests
- Modify: integration fixture environment scrub lists

- [x] Add a strict no-emit test/helper TypeScript gate.
- [x] Add an expected-version/no-skip baseline command and diagnostics for
  original path, resolved path, version, and actual wrapper child.
- [x] Repair ready/PID lost-notification races and align outer timeout budgets.
- [x] Keep fixtures owned until cleanup settles; independently bound provider,
  launcher, process-tree, and root cleanup.
- [x] Validate exact SSH argv and expected route cardinality.
- [x] Scrub every fake-fixture environment variable from companion tests.
- [x] Strengthen cancellation assertions without claiming remote descendants.
- [x] Verify repeated race gates and exact 1.18.18 Task scenarios; update ledger.

### Task 6: Documentation And Release Contract

**Owner scope:** synchronize all public, security, safety, operator, and fit
documents after verified behavior exists.

**Primary files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `docs/installation-and-usage.md`
- Modify: `docs/upstream-fit-checklist.md`
- Modify only with fresh evidence: `docs/upstream-fit-report.md`
- Modify: `opencode-ssh-remote-use/opencode-ssh-safety.md`
- Modify: `AGENTS.md`
- Mark the prior direct-subagent spec/plan as superseded where appropriate

- [x] Classify each safety claim as code-enforced, host-policy, prompt guidance,
  operator procedure, automated evidence, or pending manual evidence.
- [x] Correct readiness, permission timing, local TCB, data egress/retention,
  metadata, transaction, process, and utility requirements.
- [x] Remove automatic remote `AGENTS.md` propagation claims.
- [x] Document unsupported Task resume/background and session-ask fail-closed
  delegation behavior.
- [x] Keep real SSH/direct-child TUI gates explicitly pending.
- [x] Verify cross-document terminology and update the ledger.

### Task 7: Orchestrator Verification And Independent Review

**Owner:** orchestrator.

- [ ] Re-read every worker ledger report and inspect all diffs against the spec.
- [ ] Run `git diff --check` and production plus test strict type checks.
- [ ] Run focused unit/integration gates for every changed subsystem.
- [ ] Run repeated race/cancellation gates without retry masking.
- [ ] Run the exact OpenCode 1.18.18 baseline with no skips.
- [ ] Run normal installed-version observation and record its exact version.
- [ ] Run `npm run test:unit`, `npm run test:integration`, `npm test`, and the
  separate `npm run test:smoke`.
- [ ] Run `npm pack --dry-run` and inspect package contents.
- [ ] Launch independent read-only policy, security, sync, lifecycle, harness,
  and documentation reviewers. Resolve every P0/P1 finding.
- [ ] Finalize the recovery ledger with exact commands, results, residual risks,
  manual gates, and next action. Do not commit unless requested.
