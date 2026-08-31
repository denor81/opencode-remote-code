# Installation And Usage

OpenCode SSH runs OpenCode and its TUI on the local machine while selected
project tools operate on a remote machine through system OpenSSH. The remote
machine needs only an SSH server and the standard utilities listed below; it
does not need Node.js, OpenCode, this package, or another agent runtime.

OpenCode SSH is tested against OpenCode 1.18.18. Other OpenCode versions are
allowed only after the installed OpenCode loads this package's server plugin in
an isolated preflight. A different version still requires the manual TUI checks
in this guide and runs with Task resume disabled. Callable session lookup is
required for every launch; same-launch resume is package-controlled and enabled
only for explicitly release-qualified OpenCode 1.18.18. Another compatible
loader/runtime version keeps fresh foreground direct Task but rejects every
`task_id` before upstream execution.

Final 2026-08-28 evidence passed the exact six-scenario 1.18.18 Task portion and
one permission-engine scenario, making the complete exact baseline 7/7, plus
installed real-Task fake-SFTP mutation. Formal direct-child release remains
incomplete only for real-SSH two-sibling mutation and real permission UI and
direct-child TUI behavior. The real-SSH suite was not run.

## Requirements

Local machine:

- Node.js 22.22.2 or newer.
- OpenCode installed as the `opencode` executable.
- System `ssh` and `sftp` clients.
- A POSIX local host. Current release evidence is Linux x86_64. macOS is an
  intended local platform but is not part of the recorded hardening evidence.
  On Windows, use WSL and install every local requirement in the same WSL
  distribution rather than using native Windows.

Remote machine:

- GNU/Linux with an SSH server and SFTP enabled. A macOS remote is not supported
  by the current command contract.
- POSIX `sh`.
- Startup/preflight commands: `pwd -P`, `hostname`, `whoami`, and `uname`.
  Package `remote_status` invokes `hostname; whoami; pwd -P` internally.
- GNU path/mutation behavior: `realpath -e --`, `stat -c`, `mv -fT --`,
  `mkdir --`, `rmdir --`, `chmod --`, `rm --`, and `cat --`.
- Read/search fallback utilities: `ls`, `dd`, `od`, GNU `grep`, GNU `find`,
  `sort`, and `cut`. `rg` is an optional preferred search path; `file` is an
  optional first binary check; `git` is optional startup repository detection.
  `head` is no longer required because startup does not read remote
  `AGENTS.md`.

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

## Configure The Remote Status Permission

Every root and direct-child session must run the package `remote_status`
preflight before using remote project tools. It internally executes and
validates `hostname; whoami; pwd -P` in the canonical launch workdir, then
completes that session's preflight. The package defaults this permission to
`ask`, and its requests intentionally cannot create a reusable `always`
approval. To let this fixed read-only SSH identity check run without a prompt,
add the following top-level rule to the local machine's global OpenCode
configuration at `~/.config/opencode/opencode.json` or
`~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "remote_status": "allow"
  }
}
```

Merge the `permission` entry into an existing configuration instead of
replacing unrelated settings. This rule grants only the package
`remote_status` permission and its fixed remote
`hostname; whoami; pwd -P` command; it does not allow general Bash commands or
any read, write, edit, search, Task, or external-directory operation. No
separate `bash` permission is requested for this preflight. The rule applies to
`remote_status` on every OpenCode SSH target configured for that local user.

OpenCode loads configuration only at startup. Quit and restart it after adding
or changing the rule. Leave the package default at `ask`, or configure an
explicit `deny`, when each preflight attempt should remain interactive or
blocked.

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
5. Probe protocol v3 observes the loader runtime version and its source, checks
   for callable `client.session.get`, then atomically publishes a mode-0600
   marker containing exactly the protocol, nonce, runtime version/source, and
   lookup result. The launcher validates the complete marker within 30 seconds.
   A stale, partial, missing, additional-field, or mismatched marker cannot pass.
6. The selected `opencode --version` must exactly equal the marker's loader
   runtime version, and callable session lookup must be present. Missing lookup
   or malformed/mismatched runtime evidence blocks startup; it is not a
   loader-compatible launch with resume merely disabled.
7. Loader compatibility and resume qualification are separate only after those
   mandatory checks pass. Task resume is enabled exclusively when the selected
   and loader runtime versions also equal the explicitly release-qualified
   version, currently 1.18.18. Another identified compatible version continues
   with fresh foreground direct Task available, every `task_id` rejected before
   upstream execution, and generated context saying resume is disabled.
8. Only after the marker passes does a real launch create launch paths and start
   the SSH ControlMaster. If the executable exits, crashes, hangs, or returns an
   invalid result first, the command fails closed before any SSH startup.

The marker is the intended loader-success boundary. Once the OpenCode host has
invoked the registered hook, the launcher terminates the diagnostic
`debug config` process instead of waiting for unrelated host shutdown work. The
probe keeps one package-owned config under the local cache so OpenCode can reuse
its generated plugin SDK dependencies. Its first initialization may use the
caller's npm registry, proxy, and CA transport settings; user OpenCode and
provider settings remain isolated.

### Runtime Health Transport

OpenCode 1.18.18 and 1.18.23 PluginInput use a legacy client without public
`client.global.health`. Runtime observation prefers that method if a future host
exposes it as callable. Otherwise the observer requires root `client`,
`client.global`, and `client.session` to expose the same own `_client` transport,
then invokes `_client.get({ url: "/global/health" })` through that host-configured
SDK transport.

Validation is fail-closed. An SDK envelope must have its exact expected shape,
real `Request` and `Response` objects, a GET whose URL pathname is
`/global/health`, a successful HTTP 200 response, and an exact
`{ healthy: true, version }` payload with a valid version. The selected CLI,
loader marker, and normal runtime versions must match.

The observer never raw-fetches `PluginInput.serverUrl`, and it never treats
fallback `localhost:4096` as authoritative. The target-free compatibility probe
runs actual `debug config` and does not invoke TUI, a model, Task, or SSH.
Upstream's normal no-argument TUI design uses OpenCode's configured in-process
SDK transport, and the production launcher starts that TUI. Its plugin recheck
uses the host SDK transport but does not itself invoke a model, Task, or
permission UI or certify visual TUI behavior. Automated no-listener evidence
directly covers target-free `debug config` plus decoys and a hermetic SDK
transport, not default no-argument TUI. In serve mode, the SDK transport may use
the OpenCode process's owned listener; the serve evidence is listener-backed.
The guarantee is health through the host SDK's configured transport, not the
existence of a listener or a fixed port.

Production has no executable fallback. Only the isolated target-free
compatibility probe may use strict `process.execPath --version`, and only when no
actual public or legacy health transport exists. If an available transport
throws, times out, aborts, or returns a malformed response, observation fails;
it never falls back to the executable after such a failure.

### Regressions It Is Intended To Catch

- Removal or incompatible behavior of `opencode --version` or
  `opencode debug config`.
- OpenCode plugin-loader, package-export, ESM, or production dependency loading
  failures.
- Incompatible plugin tuple or server plugin-factory behavior.
- OpenCode no longer registering or invoking the returned `config` hook.
- Loss or incompatible shape of the callable session lookup required for Task
  safety on every launch.
- Selected-version/loader-runtime mismatch or malformed runtime health evidence.
- Loader crashes, non-zero exits, hangs, missing markers, and invalid marker
  protocol or nonce values.
- A different OpenCode version that cannot load the installed plugin at all.

These are practical failures that would otherwise prevent this launcher from
bootstrapping its server plugin. They are checked against the actual installed
OpenCode executable and production package, not a mocked OpenCode API.

### What It Does Not Prove

The private probe branch returns before creating an SSH pool or constructing the
normal remote tools. It imports their modules, but it does not execute remote
commands or ask the host to invoke each tool. Its marker is target-free and
pre-SSH.

Normal production initialization is separate. The launcher has already started
the ControlMaster and used SSH to canonicalize the workdir when the plugin again
requires callable `client.session.get`, observes runtime health through the host
SDK's configured transport, and requires that runtime version to match the
loader evidence. This recheck is before launch ownership, plugin mirror
creation, package SSH pool/bootstrap commands, and ready publication, but it
does not precede all SSH. The plugin then batch-validates concurrent config calls
before one ready publication. A config failure or disposal is terminal,
disposal starts pool closure immediately, and the launcher re-reads and
revalidates the nonce-bound ready marker after 25 ms. Ready proves the startup
boundary rather than perpetual plugin liveness.

The target-free compatibility probe does not invoke TUI, a model, Task, or SSH.
The production launcher does start the normal no-argument TUI, but its plugin
recheck does not itself invoke a model, Task, or permission UI. Normal readiness
does not certify visual TUI behavior, a runtime package project-tool call, or
SFTP mutation. These startup checks therefore do not certify:

- runtime input/output behavior of every tool after registration;
- root-to-child Task execution, safe same-launch resume, child tool filtering,
  or child instruction compliance;
- real SSH/SFTP connectivity, remote permissions, or remote filesystem behavior;
- TUI rendering, live Bash metadata, cancellation cards, or permission dialogs;
- provider, MCP, LSP, formatter, or user-plugin interaction;
- session persistence or every future OpenCode runtime behavior.

An identified version different from the tested 1.18.18 baseline may continue
only after the probe passes and always produces a warning, but Task resume stays
disabled. Passing means the loader boundary is compatible; it is not a claim of
universal compatibility.

### Related Gates

- `opencode-ssh self-test` runs exactly the same target-free startup probe and
  reports whether that selected executable qualifies Task resume.
- A normal launch subsequently requires a separate nonce-protected ready
  handshake after the post-ControlMaster SDK-transport runtime/session lookup
  recheck, bootstrap `uname`/Git SSH, tool construction, hook registration, and
  batch-validated launch-policy installation. The launcher confirms the marker
  again after 25 ms. This is not part of the pre-SSH probe and does not certify
  model, Task, child, permission-UI, runtime tool, resume, SFTP-mutation, TUI, or
  perpetual plugin behavior.
- `npm test` and `npm run install:verified` run the broader unit, integration,
  actual-loader, packaging, and installed-CLI suites. They run during validation
  or verified installation, not before every application launch.
- The ordinary focused installed-Task developer gate is
  `npm run build && npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose`.
  It uses the actual installed local OpenCode Task implementation with fake
  SSH/SFTP; it does not contact a real SSH target.
- The focused installed permission-engine gate is
  `npm run build && npm exec -- vitest run test/integration/opencode-permission.test.ts --reporter=verbose`.
  It uses the actual installed OpenCode permission engine with fake SSH and API
  replies; it is not visual permission-UI evidence.
- The exact non-skipping release-baseline gate is
  `OPENCODE_TASK_TEST_BINARY=/absolute/path/to/opencode-1.18.18 npm run test:task-baseline`.
  Its updated contract requires that explicit executable, exact version 1.18.18,
  the unchanged six-name Task manifest including safe same-launch resume, one
  installed permission-engine scenario, and zero failed, skipped, or todo
  scenarios. This release integration gate exercises full Task and permission
  behavior; startup does not replace it with a model call on every launch.
- Final 2026-08-28 evidence passed the exact 1.18.18 Task portion `6/6` and the
  complete baseline `7/7` with its permission scenario, plus installed real-Task
  fake-SFTP mutation. The remaining release boundaries are the real-SSH two-
  sibling mutation case and real permission-UI/direct-child TUI behavior in the
  detailed fit checklist. Automated loader and fake-transport checks cannot
  observe those behaviors.

Implementation and regression anchors are `src/opencode-compatibility.ts`,
`src/opencode-probe.ts`, `src/session-safety.ts`,
`src/task-resume-registry.ts`, the ordering in `src/cli.ts`, and the focused
tests in
`test/unit/opencode-compatibility.test.ts`, `test/unit/opencode-probe.test.ts`,
`test/integration/launcher-lifecycle.test.ts`,
`test/integration/opencode-loader.test.ts`,
`test/integration/opencode-subagent.test.ts`,
`test/integration/opencode-permission.test.ts`, and
`test/smoke/package-install.test.ts`.

## Startup Diagnostics And Reuse

`src/logger.ts` provides a reusable best-effort JSONL logger. Its default daily
path is:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/opencode-ssh/logs/opencode-ssh-YYYY-MM-DD.jsonl
```

The logger uses one file per UTC day and has no background retention timer.
Logging activity may run pruning at most once per UTC day per logger instance.
When maintenance runs, it keeps the current UTC day plus the previous four;
stale matching files can remain if no later logging occurs. The logger creates
or corrects private directories to `0700`, requires a regular log file at `0600`,
and opens each append with `O_APPEND`, `O_NOFOLLOW`, and `O_NONBLOCK`. Each
complete JSONL record is written with one append operation and is limited to 64
KiB.

The default caller deadline for logging is 500 ms and assumes the ordinary local
state filesystem. A deadline returns best-effort failure to the caller and
suppresses the logger instance's later writes, but it cannot cancel an already
issued native filesystem request. On a pathological or non-local filesystem,
native work may finish after the caller has continued. Do not describe this as
universal cancellation or bounded process settlement. Serialization,
filesystem, maintenance, and deadline failures resolve as logging failure and
never replace the compatibility, launch, cleanup, or disposal result.

The CLI reports diagnostics on failure only after at least one write succeeded:

```text
opencode-ssh: diagnostics: <path> (startupID <id>)
```

Use either local command to select that startup from the daily JSONL file:

```bash
grep -F '"startupID":"<id>"' "<path>"
jq -c 'select(.fields.startupID == "<id>")' "<path>"
```

`startupID` is a non-secret cross-process correlation value. Launcher-created
records add `launchID` and then `targetID` when those values become available.
`targetID` is the stable pseudonymous SHA-256 of alias plus canonical workdir. It
is not secret and is not claimed irreversible against guessed alias/workdir
inputs. The current instrumentation is deliberately narrow:

- compatibility version detection, loader probe, session lookup, version match,
  and completion/failure;
- launcher SSH master, canonicalization, OpenCode host, ready observation and
  stability, cleanup, exit, and failure;
- probe activation, runtime health, config, and marker publication;
- production plugin session lookup, health source/version match, launch claim,
  mirror, pool, bootstrap, hook/config/ready, initialization failure, and
  disposal;
- one at-most-once-per-launch `plugin.task_root_permission.normalized` warning
  when an omitted caller-root permission overlay is accepted as empty. The
  warning contains only the standard startup/launch/target correlation envelope
  and is not per-call or per-session telemetry;
- `plugin.permission.external_directory.requested` and
  `plugin.permission.external_directory.replied` lifecycle records, plus
  `plugin.permission.external_directory.repeated_after_always` when the same
  scope unexpectedly asks again after an observed reusable approval, and one
  `plugin.permission.external_directory.diagnostics_limited` warning if bounded
  tracking reaches its 64-request-per-launch or evidence-size limit. Fields are
  limited to reply/lifetime, a bounded reason enum, and boolean reusable/
  coverage/pending/repeat state. Paths, patterns, metadata, and host permission
  IDs are never recorded.
- the first 64 classified ControlMaster stderr messages per launch, followed by
  one `ssh.master.diagnostics_limited` warning. Channel-open failures use
  `ssh.master.channel_open.failed` with only a bounded reason and launcher phase;
  other lines use `ssh.master.diagnostic` with only a bounded category and
  phase. The master stderr pipe is continuously drained instead of inherited by
  the OpenCode TUI;
- failed package SSH/SFTP transports, up to 64 per plugin launch plus one
  `plugin.ssh.transport.diagnostics_limited` warning. The
  `plugin.ssh.transport.failed` record contains only the top-level operation
  category, `ssh`/`sftp`, a bounded failure kind, exit/termination state, and
  output-truncation booleans. Successful package operations are not logged.

Raw OpenSSH lines, internal OpenSSH channel numbers, commands, paths, and output
are not retained in those transport records. The launcher and plugin records can
be correlated by timestamp and `startupID`/`launchID`/`targetID`. OpenSSH does
not expose a stable mapping from a master channel number to the requesting slave
process, so concurrent failures identify the candidate top-level operations but
do not prove a one-to-one channel-to-operation match.

Production records stable failure categories/codes and allowlisted fields. It
does not write raw errors/messages, raw target alias/canonical workdir or project/
local paths, commands/argv, environment/config content, nonce/token/credential
values or their hashes, session/task/permission IDs, output/response bodies, or
model/provider data. The local path printed by the CLI is operator-facing
troubleshooting output; it is not stored as a log field.

For new source instrumentation, use the NodeNext `.js` relative import that
matches the caller's location, for example:

```ts
import { createFileLogger } from "./logger.js"

const logger = createFileLogger()
async function logCompleted(startupID: string): Promise<boolean> {
  return await logger.log({
    level: "info",
    event: "component.stage.completed",
    fields: { startupID, outcome: "completed" },
  })
}
```

Event names must be stable and match `[A-Za-z0-9][A-Za-z0-9._:-]*`. Treat every
field as an explicit allowlist decision; do not pass arbitrary objects or raw
errors from production startup paths. Start critical cleanup, pool closure, or
disposal before awaiting a log write so diagnostics cannot delay initiation of
the security/lifecycle action. Keep this facility startup-focused apart from the
documented narrow runtime boundaries above rather than expanding it into general
successful project, tool, permission, session, model, or provider telemetry.

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

The installed `opencode-ssh-safety.md` is included automatically in the root and
every direct child session's instructions for an `opencode-ssh` launch. Existing
OpenCode instructions are preserved. Do not copy or link the generic file into
each remote project, and no safety reference is required in the project root
`AGENTS.md`.

A remote root `AGENTS.md` remains optional for repository-specific commands,
conventions, and narrower task or mutation boundaries, but the launcher does not
read or inject it. After package preflight, a user or session may explicitly
read it through the normal SSH-backed `read` tool and applicable OpenCode
permissions. Remote repository bytes are not otherwise ingested as startup
instructions.

For projects configured with the previous manual workflow, remove the generic
safety-file reference from root `AGENTS.md`. Move any project-specific boundary
into the root guide itself, then remove the copied generic file if nothing else
uses it. Never commit real credentials or a personalized launcher script.

## Direct Task Children

After the root completes package preflight, it may use local Task orchestration
to launch multiple foreground direct children sequentially or concurrently.
Depth is the nesting limit, not a child-count limit. The OpenCode process, root
and child session state, and Task orchestration stay local; model/provider requests
follow provider configuration, and package project tools use SSH.

Package-enforced Task behavior:

- An absent or positive `subagent_depth` has effective depth one. Explicit zero
  remains zero. The policy is launch-local and does not rewrite config files.
- A runtime hook retrieves the caller and rejects Task unless it is a
  preflighted root. Every child Task call is rejected even if a trusted later
  config hook re-exposes Task.
- OpenCode keeps global/per-agent policy separate from its optional
  session-local permission overlay. An omitted caller-root
  `session.permission` is normalized to an empty overlay for package
  fingerprinting, matching OpenCode's own effective permission merge. This
  grants nothing by itself. Explicit malformed root permissions, incompatible
  root-session `ask` rules, changed root evidence, and missing or malformed
  child permission arrays remain fail-closed.
- `background: true` is unsupported. The launcher also forces
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false`.
- `task_id` is accepted only under the package-controlled same-launch resume
  contract below. It is not accepted when startup qualification disables resume.
- An enabled `mcp.remote` config is rejected because it can collide with the
  package `remote_status` identity.

### Safe Same-Launch Resume

Do not infer support from general OpenCode `task_id` behavior. The launch's
generated system context is authoritative: if it says Task resume is disabled,
do not submit `task_id`. Start a fresh foreground Task and include the context
that child needs.

When generated context says resume is enabled, the package applies this exact
contract:

1. The only eligible ID is the exact `task_id` of a successfully completed
   foreground direct child created by the same root during the current
   `opencode-ssh` launch. The resume call must use the same `subagent_type`.
2. Preserve that ID verbatim with its originating root and type. Never invent,
   reconstruct, guess, or reuse an ID from a prior launch or another root.
3. Fresh admission is one-shot for the root and Task call. It binds the root
   permission fingerprint, inherited SSH-project deny projection, and root
   security epoch before upstream Task to the evidence observed after Task.
4. A launch-local ownership registry records a child only after successful Task
   completion, valid result metadata, and session lookup prove direct ownership.
   The root evidence must be unchanged, every inherited SSH-project deny must be
   present, and the child must expose an explicit agent matching
   `subagent_type` plus an explicit permission array. Replay or duplicate
   registration is denied. A fresh child that returns without using package
   project tools is not required to complete child preflight merely to register.
5. Cross-launch, foreign-root, unknown/invented, child-initiated, background,
   busy, failed, canceled, and uncertain resumes are denied or ineligible.
   Unknown IDs are rejected before upstream OpenCode can reinterpret them as a
   fresh-child request.
6. Before reservation, asynchronous validation rechecks the exact launch,
   caller root, direct child, `subagent_type`, observed agent, root and child
   permission fingerprints, and root/child security epochs. The registry then
   atomically reserves the child, so only one resumer is admitted.
7. Admission clears the resumed child's prior package preflight. Before any
    project tool and before successful registry release, that child must complete
    a full new package `remote_status` preflight. The tool internally runs and
    validates `hostname; whoami; pwd -P` in the canonical launch workdir. Parent
    or earlier child evidence does not count.
8. Once reserved, a failed, missing, malformed, aborted, canceled, or uncertain
   admission/completion permanently locks the child for that launch.
9. Exact model continuity is not promised; the resumed run follows what
   OpenCode/provider selection supplies. Trusted same-process plugins and direct
   SDK/session API calls that bypass package-observed Task hooks remain trusted
   computing-base limits.

Never retry a rejected, failed, or aborted resume, and never try to make a
rejected call pass by changing the ID or type. Start a fresh foreground child
and give it the required context instead.

OpenCode host-policy behavior:

- The package adds a global `remote_status: ask` default only when neither the
  global policy nor configured `explore` policy explicitly matches it.
- Stable global and per-agent `allow`, `ask`, and `deny` remain supported.
  Package requests other than `external_directory` contain no reusable `always`
  pattern, so an `ask` may prompt on every call. For a supported normalized
  external path, `Allow always` covers the exact path and its descendants until
  the current OpenCode process exits. External paths containing literal `*`,
  `?`, or `\\` are rejected because OpenCode cannot represent those POSIX names
  literally. The approval does not grant the
  separate operation permission. OpenCode applies the approval instance-wide,
  including other root/child sessions, and may supersede a matching global, per-
  agent, or session deny. Use `Allow once` when policy isolation matters,
  restart OpenCode to clear an approval that became too broad, and use reviewed
  config for durable policy across restarts.
- OpenCode 1.18.18 does not inherit parent session asks into Task children. If
  a root-session `ask` matches `remote_status`, `bash`, `read`, `edit`, `glob`,
  `grep`, or `external_directory`, package code rejects delegation. Configure
  the intended stable rule globally or per agent instead. Do not rely on parent
  session `allow`/`ask` propagation. Package validation still requires inherited
  deny arrays, subject to the instance-wide external approval caveat above.
- Task security epochs consume both event pairs: OpenCode v2 `permission.asked`
  followed by `permission.replied` carrying `requestID`, and legacy
  `permission.updated` followed by `permission.replied` carrying `permissionID`.
  Malformed or unknown relevant delivery invalidates fail closed. The
  fire-and-forget event hook remains non-throwing rather than creating a detached
  rejection.

Package code gives every session independent preflight state. To complete it,
the current session calls package `remote_status` once. The tool requests only
the `remote_status` permission, runs `hostname; whoami; pwd -P` in the canonical
launch workdir, and verifies executor, alias, connection ID, ControlMaster
health, a zero exit, non-truncated exact three-line output, non-empty
hostname/user, and exact canonical workdir. There is no separate package Bash
call or `bash` permission request for preflight.

Package enforcement requires completed preflight before that session's package
project tools and additionally before root Task. Fresh-child registration
instead validates owner-before/after evidence and child metadata, agent,
permissions, and inherited denies. A fresh child that returns without package
project tools can register without preflight. Operator guidance still directs
every child to perform preflight before remote project work. A resumed child is
different: admission clears its old state, and a full new preflight is required
before project tools and successful registry release.

Every `remote_status` attempt advances a per-session generation. The new
generation invalidates earlier preflight and aborts active package project SSH,
SFTP, and mutation leases. Denial, cancellation, thrown transport, non-zero or
truncated output, malformed identity, or mismatch keeps package project tools
and root Task blocked until a new `remote_status` fully succeeds. Completed
remote commits and already-admitted upstream Task execution are not
retroactively undone. Parent evidence is never copied. Package Bash is not a
preflight mechanism. Built-in `explore` cannot use package Bash for project
commands, though package read/glob/grep remain available after preflight subject
to its host policy.

Prompt/operator guidance remains separate from enforcement: give every
mutation-capable sibling a disjoint path scope, do not use same-path concurrent
editing, and wait for every fresh and resumed run. After resumed work, the root
must repeat `remote_status` and inspect every changed path or remote Git status
and diff. One plugin instance serializes package file transactions, but Bash,
MCP, other plugins, other module instances, and non-cooperating remote writers
bypass that mutex. Report every run, result, failure, cancellation, and
uncertainty. A settled resume does not prove settlement of real remote
descendants.

Automated cancellation evidence covers local OpenCode Task/session and fake-SSH
slave settlement with no retry. It does not prove universal termination of real
remote descendants.

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

Package enforcement requires the root to perform this preflight before package
project work or Task, and requires any child to perform it before that child's
package project tools. As operator guidance, require every fresh child to
preflight before remote work even if it could return without using a package
project tool. A resume always revokes the child's previous preflight, and the
resumed child must repeat it before project tools and successful registry
release. Ask the current session to perform:

```text
Call remote_status once. Verify executor, targetAlias, remoteWorkdir,
controlMaster, and the returned identity hostname, user, and workdir.
```

Confirm that:

- `executor` is `ssh`.
- `controlMaster` is healthy.
- The alias and canonical workdir identify the intended target.
- The returned identity has a non-empty hostname and user, and its workdir
  matches `remoteWorkdir`.
- No separate Bash tool call or `bash` permission was used solely for preflight.
- The generated system context says whether Task resume is enabled. If disabled,
  do not attempt `task_id`; use a fresh foreground Task.

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
It also contains the separate disposable two-sibling Task gate; the five live
output checks above do not certify child-session behavior.

## Configuration And Tool Boundaries

Global OpenCode configuration remains available. Caller-directory
`opencode.json` and `.opencode/` configuration are not discovered automatically
because OpenCode starts in a stable target-specific local workspace. Put remote
session settings in global configuration or an explicit absolute config path.
The launcher adds its installed safety document to the launch-scoped
`OPENCODE_CONFIG_CONTENT.instructions` array while preserving existing entries.

Agent calls to these tools operate remotely after the ready handshake and that
session's package preflight:

- `bash`
- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `apply_patch`

`remote_status` reports the active target, validates remote identity, and
completes session preflight. MCP servers, LSP servers, formatters, web tools,
provider clients, manual `!` shell commands, Task orchestration, child sessions,
the TUI, and other plugins execute from the local OpenCode environment. Provider
requests may leave the machine according to provider configuration. Task is
intentionally not an SSH-backed tool. OpenCode SSH is not a sandbox or
no-egress boundary.

Same-process plugins, direct SDK/session API callers, and same-UID local
processes are trusted. They can inspect launch data or bypass package tools and
package-observed Task hooks; hostile trusted plugins are not sandboxed. Provider
clients execute locally but may send data to the configured provider.

The remote workdir is the default project root and part of session identity; it
is not a chroot. `/` is valid but does not grant root privileges. File tools use
the SSH user's SFTP permissions. Administrative changes require explicit,
reviewed `sudo -n` shell commands and user confirmation. Read
[`SECURITY.md`](../SECURITY.md) for the complete boundary.

### Permission Timing And Local Data

Package preflight gates all package project tools before path resolution,
baseline reads, SSH/SFTP preparation, or tool-specific permission preparation.
Starting `remote_status` advances the session generation, invalidates prior
state, and aborts active package project leases. It asks for its own permission
before running the fixed identity SSH command; no separate preflight `bash`
request occurs. After preflight, path canonicalization can run before the
corresponding `bash`, `read`, `glob`, `grep`, or `edit` prompt. Write/edit/patch
pull current content before `edit` approval to construct their diff; mutation
occurs only after approval. A lexical external path asks for
`external_directory` before its canonicalization probe. A different canonical
external target receives a separate permission check.

Only `external_directory` offers reusable `always` patterns: the exact
normalized external path plus its descendants. External paths containing
literal `*`, `?`, or `\\` are rejected rather than represented as broader
wildcard rules. The approval lasts for the current OpenCode process, is shared
across its sessions, and does not grant the subsequent operation-specific
permission. Other repeated `ask` calls can prompt again. Baselines, diff
preparation, and manifests use a private launch mirror; normal cleanup removes
it, but a reported cleanup failure can leave same-UID-readable residue.

### File And Lifecycle Semantics

One plugin instance serializes package file transactions through an abort-aware
queue. It uses content baselines, repeated canonical revalidation, random
owner-token locks, mode-0600 sibling temporaries, and GNU `mv -fT --`. A
non-cooperating writer can still race after final validation. Bash, MCP, other
plugins, other module instances, and external writers bypass this transaction.

Only content and numeric mode are guaranteed. Existing files use the final
observed mode; new files use `0600`. Owner, group, ACL, xattr, capability,
timestamp, hard-link identity, and other metadata are not preserved. Multi-file
changes are per-file atomic, not globally atomic. Typed partial failures report
committed, failed, uncertain, and unattempted paths without rollback or retry.

Within one loaded module, only one active production factory can own a launch
ID. Config failure and disposal are terminal. Disposal starts pool closure
immediately; close aborts and settles active SSH/SFTP slaves through its own
closure path. The nonce-bound ready marker and its 25 ms launcher revalidation
prove startup, not perpetual plugin liveness. On supported POSIX local hosts,
process-group coverage is limited to owned launcher children that explicitly
request it: OpenCode, version, and compatibility-probe processes. It does not
cover every local child. Cleanup attempts every owned resource and surfaces
failures. None of this guarantees termination of arbitrary real remote
descendants or protects against a hostile duplicate module instance.

## Validate Another OpenCode Version

The actual-loader integration test runs with any installed OpenCode version and
fails on behavioral incompatibility rather than version mismatch. From the
OpenCode SSH checkout, run:

```bash
opencode --version
npm run lint
npm run lint:test
npm test
npm run build && npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose
npm run build && npm exec -- vitest run test/integration/opencode-permission.test.ts --reporter=verbose
OPENCODE_TASK_TEST_BINARY=/absolute/path/to/opencode-1.18.18 npm run test:task-baseline
npm run test:smoke
npm pack --dry-run
```

Confirm that the actual OpenCode loader test ran; absence of the `opencode`
executable is the only condition that permits it to skip. Automated tests do not
observe terminal rendering or a real SSH sibling launch. Confirm that the
focused installed-Task and permission-engine tests also ran without a skip
against the selected version. The baseline command is stricter: it requires the
explicit executable,
exact 1.18.18, the exact six Task scenarios including safe same-launch resume,
one permission-engine scenario, and zero failed/skipped/todo scenarios.

Final verified 2026-08-28 evidence is:

- `npm run lint` passed, and `npm run build` passed repeatedly.
- The actual installed OpenCode 1.18.25 self-test passed; Task resume was
  disabled.
- The focused permission/diagnostics/lifecycle gate passed 121/121.
- The complete installed-loader gate passed 3/3 with zero skips. Its actual
  target-free self-test held valid health decoys on every resolved localhost
  loopback address at port 4096, saw zero connections/requests, and reported
  `client._client.get`. Real-serve production activation/disposal and correlated
  startup logs passed.
- Ordinary installed OpenCode 1.18.25 passed all 6/6 Task scenarios with resume
  disabled; `task_id` rejection before upstream and fresh fallback both passed.
- Installed OpenCode 1.18.25 and exact 1.18.18 each passed the real permission-
  engine scenario for exact/descendant external reuse, separate Bash prompts,
  an unrelated-scope ask, instance-wide second-session reuse despite that
  session's agent-level deny, and privacy-safe lifecycle logs. This is not
  visual permission-UI evidence.
- Exact binary `/tmp/opencode/opencode-ai-1.18.18/node_modules/.bin/opencode`
  resolved to
  `/tmp/opencode/opencode-ai-1.18.18/node_modules/opencode-ai/bin/opencode.exe`.
  The exact baseline accepted its six-name Task manifest plus one permission
  scenario with 7 passed, 0 failed, and 0 skipped; the resume scenario was
  enabled.
- Its sixth scenario obtained `task_id` from the root model-visible Task result,
  cross-checked the actual child, proved the identical package write was blocked
  before renewed preflight with zero SSH/SFTP preparation, then completed one
  renewed `remote_status` and atomic fake-SFTP get, private put, and `mv -fT --`
  with the expected final content.
- Every automated root, child, and resumed-child preflight used one
  `remote_status` SSH identity command and no separate Bash preflight.
- Installed 1.18.25 fresh Task and exact 1.18.18 fresh/resume paths accepted the
  normal TUI-shaped omitted root permission overlay while retaining explicit
  child permission arrays. This API-shaped evidence is not a visual TUI gate.
- `npm test` passed 33 unit/integration files and 462/462 tests, then 2 smoke
  files/tests passed 2/2.
- `npm pack --dry-run` passed with 165 files listed, and `git diff --check`
  passed.
- The actual installed-loader integration used a real OpenCode serve process on
  a dynamically selected, test-only IPv4-loopback port. In serve mode the
  host-configured SDK transport uses that process-owned listener. The harness
  does not make a fixed fixture port a production input or trust boundary, and
  it is separate from the no-listener pre-SSH `opencode debug config` probe.
  Test transport remains fake SSH/SFTP.

Real SSH was not run. The automated no-listener case is target-free `debug
config` plus a hermetic SDK path, not default no-argument TUI automation. These
gates do not prove visual TUI, real permission-UI, model, or real-SSH behavior.

Formal direct-child release remains incomplete only for real-SSH two-sibling
mutation and real permission-UI/direct-child TUI behavior. The five historical
live-output TUI checks above do not substitute for direct-child TUI evidence.
`npm run test:real` was not run on 2026-08-28.

`npm test` runs only the default real-SSH-free suites. Its package-install smoke
test may use the configured npm registry. The separate `npm run test:real`
command uses `OPENCODE_SSH_TEST_ALIAS` and `OPENCODE_SSH_TEST_WORKDIR`, connects
to that host, and mutates a disposable subdirectory. It also requires
`sudo -n id -u` to return `0` without a prompt. Run it only as an explicit
manual gate after reviewing the configured non-production target and sudo
policy. It is real-host transport/file/lifecycle evidence, not evidence for
OpenCode Task, a direct child, the permission UI, or TUI rendering.

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
