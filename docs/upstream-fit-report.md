# OpenCode SSH Fit Report

Status: HARDENING RELEASE INCOMPLETE. The final verified 2026-08-28 automated evidence is green. Formal direct-child release remains incomplete only for real-SSH two-sibling mutation and real permission-UI/direct-child TUI behavior. Real SSH was not run; visual/default no-argument TUI, real permission UI, and model behavior remain unproven by these gates. Earlier `5/5`, real-host, packaging, and live-output TUI results are retained below as historical evidence only.

## Environment

| Item | Recorded value |
| --- | --- |
| OpenCode manual TUI baseline | 1.18.18 |
| OpenCode automated loader observation | The normal installed-loader harness passed with a real serve process on a dynamically selected, test-only IPv4-loopback port; runtime health used the host-configured SDK transport through that process-owned listener, no fixed fixture port is a production trust input, and the separate pre-SSH probe remains no-listener `opencode debug config` |
| OpenCode automated direct-child Task baseline | Exact explicit 1.18.18 passed the exact six-name manifest, 6/6 with zero failed/skipped; resume scenario enabled |
| OpenCode automated direct-child Task observation | Ordinary installed 1.18.25 passed 6/6; resume disabled and fresh fallback passed |
| opencode-ssh | 0.1.0 |
| Local OS | Linux x86_64 |
| Local Node.js | Node.js 22 compatible runtime |
| Local OpenSSH | System OpenSSH client |
| Historical remote OS | Linux x86_64 non-production target; not contacted on 2026-08-28 |
| Historical remote shell | POSIX `sh` command channel |
| Historical SSH alias | Dedicated test alias |
| Historical canonical test workdir | Disposable directory under `/tmp` |
| Upstream commit | 68dd10ba9f91c66a09c2058110714dce7094cb7a |

## Evidence Scope

The 2026-08-28 results below are the latest complete default-suite, packaging,
exact Task, runtime-health, and startup-logging evidence. Focused boundaries are
recorded separately from aggregate suite counts and are not interchangeable.
The prior direct-subagent SDD and dated fit runs remain useful historical
observations, but they do not prove the current hardened worktree.
No real SSH, `npm run test:real`, publish, or manual TUI action ran in these
cycles. Package smoke used its isolated temporary install. Task and project-tool
transport remained hermetic fake SSH/SFTP.

Control claims are also separate: package-enforced preflight/Task/file behavior,
OpenCode host permission policy, and prompt/operator guidance are not
interchangeable evidence boundaries.

## Final Verified 2026-08-28 Hardening Evidence

| Command/boundary | Recorded result |
| --- | --- |
| `npm run lint` | Pass; strict production and test/helper TypeScript checks |
| `npm run build` | Pass repeatedly |
| Normal installed OpenCode Task observation | OpenCode 1.18.25; all 6/6 scenarios passed, resume remained disabled, `task_id` was rejected before upstream execution, and fresh fallback passed |
| `OPENCODE_TASK_TEST_BINARY=/tmp/opencode/opencode-ai-1.18.18/node_modules/.bin/opencode npm run test:task-baseline` | Exact explicit 1.18.18 selected; the command path resolved to `/tmp/opencode/opencode-ai-1.18.18/node_modules/opencode-ai/bin/opencode.exe`; exact six-name manifest accepted; 6 passed, 0 failed, 0 skipped; resume scenario enabled |
| Exact sixth Task scenario | Root used the model-visible Task result ID and cross-checked the actual child; an identical package write was blocked before renewed preflight with zero SSH/SFTP preparation; one renewed `remote_status` then completed atomic fake-SFTP get, private put, and `mv -fT --` with expected final content |
| One-step package preflight | Every automated root, direct child, and resumed child used one `remote_status` SSH invocation of `hostname; whoami; pwd -P`; no separate Bash preflight tool call or `bash` permission was used |
| Installed real-Task fake-SFTP mutation | Pass in the exact sixth scenario; this is real installed OpenCode Task with fake SFTP transport, not real-host SFTP evidence |
| Omitted root permission overlay | Installed OpenCode 1.18.25 fresh Task and exact 1.18.18 fresh/resume paths accepted the normal TUI-shaped omitted root overlay as `[]` while retaining explicit child arrays; this API-shaped evidence is not a visual/default-TUI gate |
| Actual installed loader integration | Pass, 3/3 with zero skips; launches a real OpenCode serve process on a dynamically selected, test-only IPv4-loopback port, observes runtime health through the host-configured SDK transport using that process-owned listener, crosses plugin activation and the 25 ms stable-ready boundary, and verifies production activation/disposal with correlated startup logs; no fixed fixture port is trusted by production, the pre-SSH probe remains no-listener `opencode debug config`, and SSH/SFTP transport is fake |
| `npm test` | Pass; 32 unit/integration files and 456/456 tests, then 2 smoke files/tests passed 2/2 |
| `npm run test:smoke` | Pass; 2/2 |
| `npm pack --dry-run` | Pass; 165 files listed; volatile tarball hashes and sizes are not release claims |
| `git diff --check` | Pass |
| `npm run test:real` | Not run |
| Real-SSH two-sibling mutation | Pending approved disposable target |
| Real permission UI/direct-child TUI | Pending manual gate |

The exact six-name manifest was:

1. `real installed OpenCode Task through opencode-ssh runs one real root-to-general-child Task with SSH-backed tools`
2. `real installed OpenCode Task through opencode-ssh runs concurrent direct siblings and clamps configured depth seven`
3. `real installed OpenCode Task through opencode-ssh preserves an inherited session deny for read`
4. `real installed OpenCode Task through opencode-ssh preserves explicit subagent depth zero without creating a child`
5. `real installed OpenCode Task through opencode-ssh propagates root session abort to two child SSH slaves without retry`
6. `real installed OpenCode Task through opencode-ssh resumes one completed direct child only when startup qualification enables it`

## Verified Runtime-Health And Logging Evidence

These focused gates passed in the same final 2026-08-28 cycle:

| Gate/boundary | Result |
| --- | --- |
| Lint and build | Pass |
| Actual installed OpenCode self-test | Pass on 1.18.25; Task resume disabled |
| Focused merged gate | 101/101 passed |
| Installed loader gate | 3/3 passed with zero skips |
| Exact target-free no-listener self-test | Valid health decoys held every resolved localhost loopback address at port 4096; OpenCode made zero connections and zero requests; health used the configured in-process SDK path and reported `client._client.get` |
| Real-serve production lifecycle | Activation, SDK-transport health through the process-owned listener, disposal, and cross-process correlated startup logs passed |
| Logging contract | One private JSONL file per UTC day, activity-triggered pruning with no background timer, append/no-follow/nonblocking flags, record limit, best-effort deadline behavior, failure suppression, safe fields, startup correlation, and one allowlisted root-permission normalization warning at most once per launch passed focused coverage; maintenance keeps the current UTC day plus four previous days, while stale files may remain without later logging activity |

The correlated records were limited to documented startup components and
non-secret `startupID`, then `launchID`/`targetID`. `targetID` is the stable
pseudonymous SHA-256 of alias plus canonical workdir; it is not secret or claimed
irreversible against guessed inputs. Production assertions covered stable
failure fields without raw errors/messages and excluded raw target alias/
canonical workdir and project/local paths, commands, configuration, nonce/token/
credential values and their hashes, session/task/permission IDs, output/bodies,
and model/provider data. The 500 ms logger value is a caller deadline, not
cancellation or universal bounded native-filesystem settlement.

OpenCode 1.18.18/1.18.23 do not expose public `client.global.health`; the tested
source is their shared own legacy `_client.get({ url: "/global/health" })`
transport. The observer did not raw-fetch `PluginInput.serverUrl` or contact
fallback localhost:4096. No executable fallback is available in production; the
target-free probe may use strict `process.execPath --version` only if no actual
health transport exists.

The target-free compatibility evidence runs actual `debug config` and does not
invoke TUI, a model, Task, or SSH; its decoy result and the hermetic SDK transport
are the automated no-listener evidence. Upstream's default no-argument TUI design
uses the configured in-process transport, and the production launcher starts
that TUI, but these gates do not directly exercise or certify it. The plugin
recheck does not itself invoke a model, Task, or permission UI or certify visual
TUI behavior. Serve evidence is listener-backed. These focused gates are
included alongside, not substituted for, the refreshed full-suite record above;
they are not visual TUI, real permission UI, model, or real-SSH evidence.

## Historical Pre-Hardening Results

The following table preserves earlier real-host/direct-subagent-cycle evidence.
It is not a fresh pass of the hardened worktree and does not close any pending
boundary listed above.

| Capability | Pass/Fail | Evidence | Blocking for daily use? |
| --- | --- | --- | --- |
| Build and package install | Pass | Successful build, 203 unit/integration tests, 2 package smoke tests, isolated package install, and installed package export import | No |
| SSH alias and key authentication | Pass | System OpenSSH connected to the dedicated target without account-password fallback | No |
| Plugin-ready handshake | Pass | Installed launcher plus real OpenCode 1.18.18 and real SSH target | No |
| Remote status | Pass | Health reported through the real ControlMaster | No |
| Remote bash | Pass | Remote `pwd`, `whoami`, `uname`, and literal shell data | No |
| Remote read/glob/grep | Pass | Real files, spaces, include filter, and literal SFTP glob characters | No |
| Remote write/edit/patch add/update | Pass | Disposable `automated` directory; atomic sibling upload | No |
| Conflict detection | Pass | A second writer changed a file; stale upload was rejected and second content remained | No |
| External-directory permission | Partial | Canonical external request verified; interactive allow/deny UI pending | Pending TUI check |
| Root workspace `/` | Pass | Installed launcher, real OpenCode loader, canonical root, and root permission scope verified | No |
| Reviewed administrative shell command | Pass | A non-interactive `sudo -n` boundary check completed on the disposable target | No |
| Existing plugins/MCP/Serper | Pending | Requires normal interactive user configuration | Pending TUI check |
| Session persistence | Pending | Requires exit and relaunch of TUI | Pending TUI check |
| Normal exit and Ctrl-C cleanup | Pass | Real SSH lifecycle returned `130` on SIGINT and removed master socket, ready file, and mirror | No |
| Remote cleanup | Pass | Automated subdirectory removed; approved parent retained for TUI trial | No |
| Live Bash automated coverage | Pass | The then-current real-SSH-free default suite passed 24 unit/integration files with 203 tests, then 2 smoke files with 2 tests | No |
| OpenCode 1.18.18 TUI live rendering | Pass | Timed streams rendered before settlement; failure, timeout, cancellation, and overflow retained the expected card state | No |
| OpenCode compatibility preflight | Pass | Every launch performs a bounded isolated package-root loader check before SSH; OpenCode 1.18.19 passed and produced the expected baseline-difference warning | No |
| Direct-child Task harness | Pass on 1.18.18 and 1.18.21 | Exact 1.18.18 and additional 1.18.21 installed-Task runs each passed all 5 scenarios with fake SSH/SFTP on 2026-08-22 | Real-SSH sibling and direct-child manual TUI gates pending |

## Historical Compatibility Preflight Gate

The automated compatibility and installation gate passed on 2026-08-21 with
the locally installed OpenCode 1.18.19. This verifies package loading and launch
ordering, not a model, Task, child session, permissions UI, project tool call,
SSH/SFTP behavior, or TUI rendering on that version.

| Command | Result |
| --- | --- |
| `npm run lint` | Pass; `tsc --noEmit` reported no diagnostics |
| `npm test` | Pass; 20 unit/integration files with 144 tests, then 2 smoke files with 2 tests |
| `npm pack --dry-run` | Pass; package contents contained 142 files |
| `node dist/cli.js self-test` | Pass; package-root loader marker returned before SSH, with the expected 1.18.19 warning |
| `npm run install:verified` with an isolated npm prefix | Pass; locked install, complete tests, global-prefix install, and installed self-test |

## Historical Direct-Child Automated Task Gate

The prior direct-subagent SDD exact-baseline gate passed on 2026-08-22:

```bash
npm run build && env PATH="/tmp/opencode/opencode-1.18.18/node_modules/.bin:$PATH" npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose
```

The selected binary version was 1.18.18. The build succeeded, and the one test
file passed all 5 scenarios with no skip in 60.55 seconds. Repeated targeted
exact-version starts and an earlier complete exact 5/5 pass after the
fake-ControlMaster publication-race correction provide additional fixture
stability evidence.

The additional installed-version observation also passed on 2026-08-22 against
OpenCode 1.18.21:

```bash
npm run build && npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose
```

That build succeeded, the installed-OpenCode test did not skip, and the one test
file passed all 5 scenarios in 53.58 seconds. Both version runs use the real
installed local OpenCode server and built-in Task implementation with a scripted
loopback provider and hermetic fake SSH/SFTP. They do not contact a real SSH
target or prove behavior outside the scripted provider/model harness,
permissions UI behavior, or TUI behavior.

The five scenarios passed on both versions and covered:

1. One root-to-general-child Task whose child independently ran
   `remote_status` and SSH-backed Bash.
2. Two concurrent direct siblings with independent preflights, no child Task,
   no grandchildren, requested depth seven narrowed to one, and root final
   verification.
3. An inherited `remote_status` deny that stopped the child without an SSH
   health command or project tool call.
4. Explicit `subagent_depth: 0` rejecting Task without creating a child.
5. Root-session cancellation settling both local child sessions and fake-SSH
   slave processes with no SSH retry.

The cancellation result is evidence only for local OpenCode session and local
SSH-slave settlement under the harness. It is not evidence that every real
remote descendant would terminate.

This historical automated exact OpenCode 1.18.18 Task boundary passed before the
audit-hardening SDD. The final 2026-08-28 exact six-scenario gate above
supersedes it as current installed-Task evidence. These historical five-scenario
runs did not cover installed-Task SFTP mutation; the new exact sixth scenario now
closes only the installed real-Task fake-SFTP boundary. Neither historical nor
current fake-transport evidence closes real-SSH siblings, permission UI, or
direct-child TUI. It also does not rewrite the earlier historical real-host and
live-output TUI evidence.

## Historical Live Bash Automated Gates

The automated release gate passed on 2026-08-18 with these actual
results:

| Command | Result |
| --- | --- |
| `npm run lint` | Pass; `tsc --noEmit` reported no diagnostics |
| `npm run test:unit` | Pass; 16 test files, 128 tests |
| `npm run test:integration` | Pass; 3 test files and 9 tests, including the installed real OpenCode loader |
| `npm test` | Pass; 21 test files and 139 default-suite tests |
| `npm run test:smoke` | Pass; 2 test files, 2 tests |
| `npm pack --dry-run` | Pass; 138 package files listed |

## Historical Live Bash TUI Gate

The operator completed the interactive OpenCode 1.18.18 TUI gate on 2026-08-17
using the globally installed `opencode-ssh` 0.1.0 package and the disposable
target recorded above.

| Case | Result | Observation |
| --- | --- | --- |
| Timed stdout/stderr | Pass | Both streams advanced incrementally at one-second intervals before command settlement; cross-stream ordering was not asserted |
| Non-zero exit | Pass | `before failure` remained visible after exit 7 |
| Timeout | Pass | `before timeout` remained visible after the 2,000 ms timeout and no automatic retry appeared |
| Preview overflow | Pass | The card showed the truncation marker and `newest tail`, remained responsive, and expanded/collapsed normally |
| Cancellation | Pass | `before cancellation` remained visible and `Escape` immediately settled the card as `Tool execution aborted` without retry |

The post-cancellation read-only inspection
`ps -eo pid,ppid,stat,etime,args | grep -E '[s]leep 30$' || true` returned no
matching process. This observation does not change the documented boundary that
timeout or cancellation cannot universally guarantee remote descendant
termination.

## Observed Defects

1. OpenSSH SFTP preserves backslashes before glob characters inside double
   quotes. The initial implementation therefore uploaded a temporary file under
   a different literal name. Batch paths now use unquoted backslash escaping;
   the real-host regression with `literal[1]?.txt` passes.
2. Canonicalizing an already external symlink path initially produced two
   permission requests. It now asks once for a lexical external path and still
   asks for hidden symlink escapes originating inside the workspace.

## Known Compatibility Risk

`anomalyco/opencode#37877` affects the OpenCode 1.18.18 metadata callback used
for live Bash updates. The package contains an isolated Effect bridge for that
host behavior. Automated coverage and the actual pinned TUI gate pass, but a
different OpenCode release must be revalidated rather than assumed compatible.

## Decision

Current audit-hardening decision: **NO-GO for formal direct-child release** until
the two separately approved real/manual boundaries are observed.

Final 2026-08-28 automated Task evidence is green on exact OpenCode 1.18.18 and
ordinary installed OpenCode 1.18.25. The exact six-scenario baseline, installed
real-Task fake-SFTP mutation, default tests, smoke, and package dry-run are no
longer pending. Historical real-host transport/file/lifecycle and OpenCode
1.18.18 live-Bash TUI evidence remains recorded, but it does not prove the
hardened direct-child permission UI or real-SSH sibling mutation path.

Runtime-health/logging evidence is also green as recorded above; it does not
close the two real/manual release gaps.

Pending boundaries remain explicit:

- real-SSH two-sibling mutation on a disposable target;
- real permission UI and direct-child TUI behavior.

`npm run test:real` exists and mutates a configured disposable real target. It
is transport/file/lifecycle evidence only, not Task/OpenCode/TUI evidence, and
was not run in this hardening cycle.
