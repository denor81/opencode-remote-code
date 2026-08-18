# OpenCode SSH Fit Report

Status: automated real-host and live-output TUI checks passed; remaining interactive checks pending

## Environment

| Item | Tested value |
| --- | --- |
| OpenCode | 1.18.18 |
| opencode-ssh | 0.1.0 |
| Local OS | Linux x86_64 |
| Local Node.js | Node.js 22 compatible runtime |
| Local OpenSSH | System OpenSSH client |
| Remote OS | Linux x86_64 non-production target |
| Remote shell | POSIX `sh` command channel |
| SSH alias | Dedicated test alias |
| Canonical test workdir | Disposable directory under `/tmp` |
| Upstream commit | 68dd10ba9f91c66a09c2058110714dce7094cb7a |

## Results

| Capability | Pass/Fail | Evidence | Blocking for daily use? |
| --- | --- | --- | --- |
| Build and package install | Pass | Clean dependency set, successful build, 139 default-suite tests, and isolated package install | No |
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
| Live Bash automated coverage | Pass | 16 unit files and 128 tests passed; the default real-SSH-free suite passed 21 files and 139 tests | No |
| OpenCode 1.18.18 TUI live rendering | Pass | Timed streams rendered before settlement; failure, timeout, cancellation, and overflow retained the expected card state | No |
| OpenCode version advisory | Pass | Tested baseline continued immediately; a different version warned before SSH and continued after the configured delay | No |

## Live Bash Automated Gates

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

## Live Bash TUI Gate

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

Automated transport, tools, root workspace, and lifecycle fit: go. Daily-use
decision remains pending the remaining normal integration, permission UI, and
session checks.

Automated live Bash output coverage: go. Actual OpenCode 1.18.18 TUI live
rendering: go.
