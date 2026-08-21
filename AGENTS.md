# OpenCode SSH Agent Notes

## Commands

- `npm run lint` runs the fast strict TypeScript check.
- `npm run build` cleans `dist/`, compiles NodeNext ESM, and marks `dist/cli.js` executable.
- `npm run test:unit` runs hermetic unit tests with fake SSH/SFTP processes.
- `npm run test:integration` builds first and tests launcher lifecycle, plugin registration, and any installed real OpenCode loader; a cold isolated loader may initialize its matching SDK through the configured npm registry, and the loader test skips only when `opencode` is absent.
- `npm run test:smoke` builds, packs, installs into a temporary prefix, and checks the installed CLI; dependency installation may use the configured npm registry.
- `npm test` builds and runs every default real-SSH-free Vitest suite. It runs smoke packaging after unit/integration so two cold package installations do not compete for the npm registry.
- `npm run test:real` is the explicit opt-in real-SSH suite. It mutates its configured disposable target and requires the target to allow `sudo -n id -u`.
- Manual TUI and fit testing is opt-in through `docs/upstream-fit-checklist.md`. Use only a separate non-production target and disposable directory.

## Remote Session Safety

- `opencode-ssh` automatically includes `opencode-ssh-remote-use/opencode-ssh-safety.md` in the child OpenCode instructions; remote projects do not need a copy or an `AGENTS.md` reference.
- When this repository is launched through `opencode-ssh`, follow the injected safety instructions, call `remote_status`, and verify the active target before any project action.
- In an ordinary local checkout without an expected SSH session, the remote preflight does not apply. If an SSH session is expected but `remote_status` is absent, unhealthy, or inconsistent with the remote shell, stop.

## Runtime Shape

- `src/cli.ts` provides `opencode-ssh <ssh-alias> <absolute-remote-workdir>` and `opencode-ssh self-test`; it does not forward OpenCode arguments.
- Every real launch runs the isolated OpenCode loader probe before starting SSH. `self-test` runs that same local probe without a target.
- The launcher starts a system OpenSSH ControlMaster, resolves the canonical remote workdir, injects the safety-instruction path and package-root server plugin through `OPENCODE_CONFIG_CONTENT`, requires a nonce-protected ready handshake, and supervises cleanup.
- `src/index.ts` is the server plugin entrypoint. It overrides `bash`, `glob`, `grep`, `read`, `write`, `edit`, and `apply_patch`, and adds `remote_status`.
- Command tools use one-shot `ssh` channels through the owned socket. File tools use system `sftp` and a private launch-scoped mirror.
- Slave SSH/SFTP processes fail closed when the master socket is unavailable. They do not open a replacement connection or retry commands.
- `SyncEngine` uses operation-wide local transactions, per-file content baselines, deterministic remote lock directories, sibling temporary uploads, and atomic rename. It never pushes every manifest entry globally.
- OpenCode loads the generic safety file through its `instructions` configuration. The system transform separately appends compact remote context and an optional bounded remote root `AGENTS.md`; neither path replaces existing instructions.

## Compatibility Preflight Contract

- The canonical description is [`docs/installation-and-usage.md#automatic-compatibility-preflight`](docs/installation-and-usage.md#automatic-compatibility-preflight). Keep it synchronized with `src/opencode-compatibility.ts`, `src/opencode-probe.ts`, and the pre-SSH ordering in `src/cli.ts`.
- This is a focused behavioral startup probe, not the full test suite. Every real launch runs it without caching before launch paths or the SSH ControlMaster are created.
- Success requires the actual selected OpenCode to resolve the production package root, call the server plugin, register its hooks, invoke the private `config` hook, and return an atomically published nonce-bound marker. A version check or direct module import alone is not an equivalent replacement.
- The probe must remain independent of a remote target, SSH configuration, providers, normal OpenCode/project configuration, and user plugins. Preserve npm registry/proxy/CA transport settings needed for OpenCode to initialize its generated plugin dependencies.
- The marker is the loader success boundary; the diagnostic child is intentionally terminated afterward instead of delaying startup for unrelated `debug config` shutdown work.
- Do not claim that the probe verifies tool invocation, SSH/SFTP behavior, TUI rendering, permissions UI, provider/MCP interaction, or universal compatibility. The later ready handshake, full automated suites, and documented manual TUI gate cover separate boundaries.
- Changes to this contract require the focused compatibility/probe/lifecycle tests, the actual installed OpenCode loader integration, package-install smoke coverage, `npm run lint`, and the complete default `npm test` gate.

## Configuration And SSH

- SSH aliases are passed unchanged to system OpenSSH, so `~/.ssh/config`, `known_hosts`, keys, `ssh-agent`, encrypted-key prompts, and `ProxyJump` remain authoritative.
- Master startup disables account-password and keyboard-interactive fallback but allows host-key and private-key passphrase prompts. No password or sudo askpass support exists.
- Activation requires the complete private launcher environment and matching plugin tuple `launchID`. Without it, the plugin is dormant.
- Global OpenCode config, provider environment, plugins, and MCP remain available. Caller-directory project config is not discovered because OpenCode starts in a stable target-specific local workspace.
- Stable session identity is based on the SHA-256 of alias plus canonical workdir. Mirrors are launch-specific and removed during launcher cleanup.

## Permissions And Paths

- Remote paths reject control characters and are canonicalized with remote `realpath -e` before access. Missing mutation paths canonicalize their nearest existing ancestor.
- Canonical paths outside the configured workdir request `external_directory` permission. A workdir of `/` contains every absolute remote path.
- `read`, `glob`, `grep`, `edit`, and `bash` use their corresponding OpenCode permission checks. Arbitrary paths embedded inside shell text cannot be inferred reliably and remain governed by the bash permission.
- Each bash call is a separate POSIX `sh` process; `cd` does not persist.
- SFTP operations run with the SSH user's privileges. Root-owned files require explicit reviewed `sudo -n` shell commands.
- `apply_patch` add/update are supported. Delete and move are rejected until dedicated atomic implementations exist.

## Implementation Traps

- This is strict NodeNext ESM. TypeScript source imports local modules with `.js` suffixes.
- Never use `shell: true`, interpolate aliases into local command strings, or automatically retry a command after spawn.
- OpenSSH SFTP batch quoting differs from shell quoting. Keep glob characters escaped and reject CR/LF/NUL paths.
- Remote lock directories fail closed when stale. Do not auto-delete an unknown lock during a mutation.
- File conflicts are content-checked under cooperative plugin locks. Non-cooperating remote processes can still race after the final validation; never overstate this as a universal filesystem transaction.
- The package requires Node.js 22.22.2+ and is tested against OpenCode 1.18.18. Another identified version must pass the loader probe and receives an advisory warning; an unidentified version is blocked.
- `package-lock.json` is tracked. Do not run `npm audit fix --force` or change pinned dependencies without reviewing the lock diff.
- Never edit ignored `dist/` as source. Change `src/` or build scripts and run a full build.
- Tracked examples and documentation must never contain connection details or credentials.
- Dated implementation plans are historical records, not current instructions; use the source, tests, README, and security documentation as authoritative behavior.
