# OpenCode SSH

[English](README.md)

在本机运行 OpenCode 和 TUI，同时通过系统 OpenSSH 在远程主机上执行常用项目工具。
远程主机无需安装 OpenCode、Node.js、插件或其他 agent runtime。

本项目以 OpenCode 1.18.18 为测试基线。每次建立 SSH 连接前，launcher 都会在
隔离的本地环境中要求已安装的 OpenCode 加载本项目的 server plugin，并要求所选
`--version` 与 nonce-bound loader runtime 证据准确一致。每次启动都必须提供可调用的
session lookup。安全的同次启动 Task resume 由 package 控制，且只对明确获得发布资格
的 OpenCode 1.18.18 启用；其他 loader/runtime 兼容版本仍可运行新的前台直接 Task，
但每个 `task_id` 都会在 upstream 执行前被拒绝。

2026-08-28 的最终证据已包括精确 1.18.18 六场景 resume gate 和已安装真实 Task 的
fake-SFTP 修改。正式直接子会话发布目前只剩真实 SSH 双兄弟修改和真实权限界面及
直接子会话 TUI 行为尚未完成；本轮未运行真实 SSH suite。

```bash
opencode-ssh staging /srv/app
opencode-ssh staging /
```

`staging` 会原样传递给系统 `ssh` 和 `sftp`。`~/.ssh/config`、SSH key、
`ssh-agent`、`known_hosts`、`ProxyJump` 和算法配置均由 OpenSSH 处理。

## 安装

```bash
npm run install:verified
```

该命令会安装锁定的依赖、运行本地测试、构建并全局安装 CLI，最后运行已安装的
`opencode-ssh self-test`。它不需要 SSH 服务器、provider 或项目配置。

要求 Node.js 22.22.2+、本机已安装 OpenCode，以及可用的 `ssh` 和 `sftp`。
当前本机发布证据来自 Linux x86_64；macOS 是预期本机平台，但不在本轮已记录证据
中，Windows 应通过 WSL 运行。远端要求 GNU/Linux、SFTP、POSIX `sh`，并使用
`pwd -P`、`hostname`、`whoami`、`uname`、GNU `realpath -e --`、`stat -c`、
`mv -fT --` 及常用 GNU 文件/搜索工具。`git`、`file` 和 `rg` 可选并有降级路径；
`remote_status` 会在内部运行 `hostname; whoami; pwd -P`。启动不再读取远程
`AGENTS.md`，因此不要求 `head`。不支持把 macOS 作为远端目标。

完整的英文安装、SSH 配置、本地启动脚本、安全说明和手动 TUI 测试请参阅
[Installation And Usage](docs/installation-and-usage.md)。

## 用法

命令只接受 SSH alias 和远程绝对路径，不转发额外 OpenCode 参数：

```bash
opencode-ssh <ssh-alias> <absolute-remote-workdir>
```

模型、provider、权限、插件和 MCP 配置继续使用普通 OpenCode 配置。

若要让每个 session 的固定 `remote_status` 预检无需反复提示，可在本机全局
`~/.config/opencode/opencode.json` 中加入以下顶层配置，然后完全重启 OpenCode：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "remote_status": "allow"
  }
}
```

应把 `permission` 合并进现有配置而不是覆盖其他设置。该规则只允许
`remote_status` 内部固定执行并验证 `hostname; whoami; pwd -P`，不会允许任意
Bash、文件读取或修改。完整合并方式见
[Installation And Usage](docs/installation-and-usage.md#configure-the-remote-status-permission)。

启动 SSH 之前，launcher 会检查本机 `opencode --version`，并在隔离的 HOME、
config 和 workspace 中运行 `opencode debug config` 真实 loader 检查。Probe
protocol v3 必须加载 plugin，
再原子发布包含 loader runtime version、观察来源和可调用 `client.session.get` 的
nonce-bound marker。所选版本必须与 loader runtime version 准确一致；缺少 session
lookup，或 runtime 证据缺失、格式错误、不匹配，都会在创建 launch path、启动
ControlMaster 或任何 SSH 之前阻止启动。其他可识别版本只有通过上述全部检查才能显示
警告并继续；它仍可运行新的前台直接 Task，但 resume 保持禁用。只有明确获得发布
资格的 1.18.18 才启用 resume。生成的 system context 会说明本次启动的决定。

SSH 启动前的 v3 loader marker 不依赖目标，也不会打开 SSH。正常 production
初始化是另一个边界：launcher 已启动 ControlMaster 并通过 SSH 规范化 workdir 后，
plugin 会通过 OpenCode host SDK 已配置的 transport 复查可调用的
`client.session.get` 和 runtime health/version。该复查发生在取得 launch ownership、
创建 mirror、打开 package SSH pool、运行 bootstrap SSH 或发布 ready 之前；但它并不
早于已经发生的 ControlMaster 和 workdir 规范化 SSH。

OpenCode 1.18.18 和 1.18.23 的 PluginInput 使用没有公开
`client.global.health` 的 legacy client。若未来 host 提供该 callable API，observer
优先使用它；否则要求 root `client`、`client.global` 和 `client.session` 共享同一个
own `_client` transport，并调用 `_client.get({ url: "/global/health" })`。SDK envelope
必须包含真实 `Request`/`Response` 对象、成功 GET、HTTP 200，以及准确的
`{ healthy: true, version }` payload；版本必须与 selected/loader runtime 一致。
Observer 绝不会 raw-fetch `PluginInput.serverUrl`，也绝不会信任 fallback
`localhost:4096`。

Target-free compatibility probe 实际运行 `debug config`，不会调用 TUI、model、Task 或
SSH。Upstream 的普通 no-argument TUI 设计使用 OpenCode 已配置的 in-process SDK
transport，production launcher 会启动该 TUI；其 plugin health recheck 使用 host SDK
transport，但 recheck 本身不会调用 model、Task 或 permission UI，也不证明 visual TUI
行为。自动 release evidence 直接覆盖 target-free `debug config`、decoy 和 hermetic SDK
transport，不直接覆盖 default no-argument TUI；serve evidence 由 listener-backed path
提供。Production 不提供 executable fallback。只有 target-free compatibility probe 可在
完全没有 health transport 时严格使用 `process.execPath --version`；可用 transport 一旦
失败或返回 malformed response，仍会直接 fail closed。

同一批并发 config call 会先全部验证，再只发布一次 nonce-bound ready。Config 失败
或 dispose 都是 terminal 状态，dispose 开始时会立即启动 pool closure。Launcher
首次看到 ready 后等待 25 ms，再重新读取并验证 marker。Ready 只证明该启动边界，
不保证 plugin 永久存活。完整 resume 行为由六场景已安装 Task 发布 gate 验证，而不是
每次启动调用模型。

等待期间终端会简短显示 checking、testing、passed 和 starting SSH。
`opencode-ssh self-test` 可在任意目录中单独运行，不需要 SSH alias 或远程主机，
并会报告 Task resume 为 enabled 或 disabled。

`~/.config/opencode` 下的全局配置以及绝对路径的显式配置会保留。由于 OpenCode
从稳定的 launcher workspace 启动，调用命令目录中的 `opencode.json` 或
`.opencode/` 不会自动加载；远程会话所需设置应放入全局配置或绝对路径的
`OPENCODE_CONFIG`。launcher 会自动把已安装的
[`opencode-ssh-safety.md`](opencode-ssh-remote-use/opencode-ssh-safety.md) 加入
root 会话和每个直接子会话的 instructions，并保留已有 instructions。无需向远程
项目复制或链接该文件。启动时不会自动读取或注入远程根目录的 `AGENTS.md`。
完成 package 预检后，用户或会话可通过普通 SSH-backed `read` 及相应 OpenCode
权限显式读取它。

远程 workdir 是默认项目目录，但不是 chroot。直接访问 workdir 外的文件会请求
`external_directory` 权限。`/` 可作为 workdir，此时整个远程文件系统都在项目
范围内，但实际权限仍取决于 SSH 用户。

管理操作应使用明确的 `sudo -n` shell 命令。SFTP 支持的 `read`、`write`、
`edit` 和 `apply_patch` 不会通过 sudo 自动提权。

## 控制分类

- **Package 代码强制执行：** 每会话一步式 `remote_status` 预检及内置远程身份验证、项目工具和 root Task gate、
  仅 root 可启动前台直接 Task、子会话/background Task 拒绝、深度 0/1、经启动资格
  检查的同次启动 resume、launch-local 所有权 registry 和原子准入、`mcp.remote`
  冲突拒绝，以及 SSH/SFTP 和文件事务检查。
- **OpenCode host policy：** 工具可见性和全局、per-agent、session 权限规则求值；
  package 不替代 OpenCode 权限引擎。
- **Prompt/操作员指导：** 注入的安全说明、兄弟会话路径分工、受审查的 `sudo`、
  最终远程验证和手动 fit 流程；这些指导不是 sandbox 控制。

同进程 plugin、直接 SDK/session API 调用者和同 UID 本地进程属于受信任 TCB，
可以读取启动状态，或绕过 package 工具及 package 可观察的 Task hook；本项目不
隔离恶意的受信任 plugin。启用名为 `mcp.remote` 的配置会因可能占用
`remote_status` 命名空间而被拒绝，但这不是通用 plugin sandbox。

## 直接 Task 子会话

root 完成 package 预检后，可通过本机 OpenCode Task 顺序或并发启动多个**前台**
直接子会话。深度表示嵌套层数而非兄弟数量：未设置或任意正值变为一，显式零保持
为零。即使受信任的后续 config hook 再次暴露 Task，package runtime guard 也会
拒绝子会话调用 Task。`background: true` 仍不受支持；launcher 还强制
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false`。OpenCode process、Task
编排和子会话状态留在本机；模型/provider request 按 provider 配置执行并可能离开
本机。

Task resume 由 package 控制，不是 OpenCode 一般行为的承诺。每次启动都要求可调用的
session lookup；只有明确获得发布资格的 OpenCode 1.18.18 才启用 resume。其他
loader/runtime 兼容版本仍可运行新的前台直接 Task，但每个 `task_id` 都会在 upstream
执行前被拒绝。生成的 system context 会说明本次启动的决定；只有它说明 enabled 时，
以下规则才适用：

- 只能使用同一 root 在当前 `opencode-ssh` 启动中创建、且已成功完成的前台直接
  子会话所返回的准确 `task_id`，并使用完全相同的 `subagent_type`。
- 必须原样保留 ID、其所属 root 和 type；绝不能编造、猜测、重建、修改，或借用
  其他 root、其他启动中的 ID。
- Fresh-child 准入对该 root/Task call 是 one-shot。注册会绑定 Task before 和 after
  之间的 root permission fingerprint 与 security epoch，要求 root 证据不变、保留
  每个继承的 SSH-project deny，并要求 child 显式提供与 `subagent_type` 匹配的 agent
  和显式 permission array。
- launch-local 所有权 registry 只记录上述经过验证的成功子会话。跨启动、foreign-root、
  unknown/invented、child-initiated、background、busy、failed、canceled 或 uncertain
  resume 均不符合资格。未知 ID 会在 upstream OpenCode 把它解释成新子会话之前被
  package 拒绝。
- 原子 reservation 之前，package 会复查准确 launch、caller root、direct child、
  `subagent_type`、observed agent、root/child permission fingerprint 和相关 security
  epoch；同一时刻只能准入一个 resumer。
- 准入会清除 child 旧的 package 预检。使用任何项目工具前，并且在 registry 可再次
  release 该 child 之前，resumed child 必须完成一个全新的 package `remote_status`
  预检；该工具会在 canonical launch workdir 内部运行并验证准确
  `hostname; whoami; pwd -P`。
- Reservation 一旦完成，失败、缺失、格式错误、中止、取消或 uncertain 的准入或
  completion 会让该 child 在本次启动中永久锁定。不得重试该 ID；应启动新的前台
  direct child 并提供所需上下文。
- Package 不承诺准确的模型连续性。

只有当全局和已配置 `explore` 策略都没有显式匹配 `remote_status` 时，package 才
默认加入 `remote_status: ask`。稳定的全局/per-agent `allow`、`ask`、`deny` 受
支持。Package 权限请求不提供持久 `always`，因此 `ask` 可能每次调用都提示。
OpenCode 1.18.18 不会把父 session 的 `ask` 继承给 Task 子会话；若 root session
的 `ask` 匹配 SSH 项目权限，package 会拒绝委派并要求改用全局或 per-agent 策略。
不要依赖父 session `allow`/`ask` 的传播；继承的 deny 仍保持限制。

Task security epoch 同时观察两组 event：OpenCode v2 `permission.asked`，随后是携带
`requestID` 的 `permission.replied`；legacy `permission.updated`，随后是携带
`permissionID` 的 `permission.replied`。格式错误或未知的相关 delivery 会 fail closed
并使安全证据失效；fire-and-forget permission event hook 保持 non-throwing，不会产生
detached rejection。

Package 代码为每个 session 保存独立预检状态。每个 session 在使用自己的 package
project tool 前必须完成预检；root 在调用 Task 前也必须完成。Fresh-child registration
验证 owner before/after 证据以及 child metadata、agent、permission 和继承的 deny，
并不无条件要求 child 预检。因此，fresh child 若未使用 package project tool 就返回，
仍可完成注册。操作员指导仍要求每个 child 在远程项目工作前执行预检。Resume 更严格：
准入会清除 child 旧状态，成功 registry release 前必须完成新的预检。

每次 `remote_status` 尝试都会推进 per-session generation；新 generation 会撤销旧
预检，并中止 active package project SSH、SFTP 和 mutation lease。该工具内部运行
`hostname; whoami; pwd -P`，并要求零退出、未截断、准确三行输出、非空 hostname/user
以及匹配 canonical launch workdir。拒绝、失败、取消、非零、截断、格式错误或身份
不匹配都会让 package 项目工具和 root Task 保持阻塞，直到新的 `remote_status` 完全
成功。已经完成的远程 commit 和已经准入的 upstream Task execution 不会被追溯撤销。
父会话证据不会复制。Package Bash 不是预检机制；内置 `explore` 不能使用 package
Bash，但可在预检后按 host policy 使用 package `read`、`glob`、`grep`。

只读兄弟会话可以重叠。可修改项目的兄弟会话必须使用互不重叠的路径。一个 plugin
实例中的 package 文件修改共享 operation-wide mutex，但不支持并发编辑同一路径；
Bash、MCP、其他 plugin、另一 module 实例和不协作的远程写入者会绕过该 mutex。
操作指导要求 root 等待每次 fresh 和 resumed run，resumed work 后再次检查
`remote_status` 和每个变更路径/diff，并分别报告每次 run 的变更、失败、取消和
不确定状态。resume 已结束并不能证明真实远程后代进程已经结束。

## 工具边界

以下工具通过 SSH 工作：`bash`、`read`、`write`、`edit`、`glob`、`grep`、
`apply_patch`。`remote_status` 会检查并报告连接状态、验证远程身份并完成 session
预检。

Task 未列入这些通过 SSH 执行的工具，因为它是本机 OpenCode 的编排工具。

其他 OpenCode 工具、插件、MCP、LSP、formatter、provider client 和 TUI 内部功能
从本机 OpenCode 环境运行；provider request 仍可能按 provider 配置离开本机。本项目
不是 sandbox，也不保证所有 OpenCode 操作都在远端执行或不发生数据外发。

### 权限时序

Package 预检会在路径解析、baseline 读取、SSH/SFTP 准备或工具专属权限请求之前
拒绝项目工具。启动 `remote_status` 会推进 session generation、清除旧预检并中止
active package project lease；它会先请求自己的权限，再运行内部固定 identity SSH
命令，不会产生单独的预检 `bash` 请求。预检完成后，路径规范化可发生在 `bash`、
`read`、`glob`、`grep` 专属提示之前；
`write`、`edit`、`apply_patch` 还会在 `edit` 提示前拉取当前内容以生成 diff。
词法路径已在 workdir 外时，会先请求 `external_directory` 再规范化。对应批准前
不会执行请求的 Bash 命令或文件修改。准备阶段内容保存在私有 launch mirror 中，
直到 cleanup；受信任的同 UID 本地进程可访问它。

### 文件事务边界

一个 plugin 实例中的 package 文件路径使用可感知取消的 operation-wide 队列、
逐文件内容 baseline、重复 canonical path 检查、带随机 owner token 的确定性锁、
预先设为 `0600` 的随机同目录临时文件，并用 GNU `mv -fT --` 替换。不协作写入者
仍可能在最后检查后产生 race。

只保证内容和数值 mode：现有文件使用最终验证时观察到的 mode，新文件为 `0600`。
owner、group、ACL、xattr、capability、timestamp、hard-link identity 等均不保留。
单文件替换原子，多文件操作不具备全局原子性；typed partial error 会区分 committed、
failed、uncertain、unattempted 路径，不自动 rollback 或 retry。未知锁不会自动删除，
cleanup 错误会报告可能残留的锁或临时路径。

## SSH 密钥

launcher 禁用 SSH 账户密码和 keyboard-interactive fallback，但不启用
`BatchMode`。因此 OpenSSH 仍可请求确认 host key 或 key passphrase。若 key 已加载
到当前用户的 `ssh-agent`，launcher 会继承 `SSH_AUTH_SOCK`，通常不会再次询问。

## 生命周期

Launcher 先完成 pre-SSH protocol-v3 marker、所选版本/runtime 一致性和 callable
session lookup 检查，再启动 ControlMaster 并规范化 workdir。随后启动的正常 plugin
会在 claim launch、创建 mirror、打开 package pool 和 bootstrap SSH 之前复查 callable
lookup，并通过 host SDK 已配置的 transport 复查匹配的 runtime health/version。
Config batch 全部验证后只发布一次 ready；launcher 在 25 ms 后重新读取并验证同一
nonce-bound marker。

一个已加载 module 内，每个 launch ID 只允许一个 active production plugin
factory。Config 失败和 dispose 都是 terminal；dispose 一开始即启动 pool closure，
拒绝新 SSH/SFTP 调用、取消 active slave 并等待其结束。Ready 证明启动边界，但不
保证永久 liveness。本机 POSIX 环境中，只有明确请求 process group 的 owned local
launcher child，也就是 OpenCode、version 和 compatibility probe，使用独立 process
group 和有界 TERM/KILL；该结论不覆盖其他 local child。SSH/SFTP slave settlement 是
上述 package pool 自己的独立行为。cleanup 会尝试 OpenCode、ready marker、mirror、
master、socket 和 listener，并暴露已知失败。这不防御恶意的重复 module 实例，也不
保证任意真实远程后代进程终止。

## 启动诊断

Best-effort JSON Lines 默认写入：

```text
${XDG_STATE_HOME:-$HOME/.local/state}/opencode-ssh/logs/opencode-ssh-YYYY-MM-DD.jsonl
```

Logger 按 UTC 每天一个文件，但没有 background retention timer。Logging activity 最多
使每个 logger instance 在每个 UTC 日执行一次 pruning；maintenance 运行时保留当前
UTC 日和之前四天。如果之后没有 logging，stale matching file 可以继续存在。目录 mode
为 `0700`，regular file 为 `0600`，并使用 append、no-follow、nonblocking open flag。
每条 record 上限 64 KiB。Caller 使用 500 ms local-I/O deadline，但该 deadline 不会取消
已经提交的 native filesystem request；在 pathological 或 non-local filesystem 上，底层
工作可能随后才结束。Logging failure 永远不会替代 launch、probe、cleanup 或 disposal
的核心结果。

只有至少一次 log write 成功后，CLI 才会在失败时显示：

```text
opencode-ssh: diagnostics: <path> (startupID <id>)
```

可按显示的 ID 过滤当天 JSONL：

```bash
grep -F '"startupID":"<id>"' "<path>"
jq -c 'select(.fields.startupID == "<id>")' "<path>"
```

当前 instrumentation 仅覆盖 compatibility version/probe、launcher
SSH/canonicalization/OpenCode/ready/cleanup、probe health/marker，以及 production
plugin lookup/health/source/version/mirror/pool/bootstrap/config/ready/disposal。记录先用
非 secret `startupID` 关联，再用 `launchID`/`targetID`。`targetID` 是 alias 加 canonical
workdir 的稳定 pseudonymous SHA-256；它不是 secret，也不声称对可猜测的 alias/workdir
输入不可逆。Production 只写 stable failure code 和经过审查的 field，不写 raw
error/message。不得记录 raw target alias/canonical workdir 或 project/local path、
command/argv、environment/config、nonce/token/credential 值或这些值的 hash、
session/task/permission ID、output/response body 或 model/provider data。唯一显示的 path
是上面的本机 diagnostic path。

仓库代码可从相对 `./logger.js` 风格的 NodeNext path import `createFileLogger`。Event
name 应稳定并匹配 `[A-Za-z0-9][A-Za-z0-9._:-]*`，field 必须是 allowlisted non-secret
data；critical cleanup/disposal 必须先启动，再 await diagnostic write。不得把该 module
扩展成一般 project/tool/session telemetry。

## 测试

```bash
npm run lint
npm run lint:test
npm run build
npm run test:unit
npm run test:integration
npm run build && npm exec -- vitest run test/integration/opencode-subagent.test.ts --reporter=verbose
OPENCODE_TASK_TEST_BINARY=/absolute/path/to/opencode-1.18.18 npm run test:task-baseline
npm test
npm run test:smoke
npm pack --dry-run
```

`test:task-baseline` 必须显式设置 `OPENCODE_TASK_TEST_BINARY`，并只接受准确的
OpenCode 1.18.18、包含安全同次启动 resume 的准确六场景 manifest 全通过，并要求
failed、skipped、todo 都为零。2026-08-28 的最终证据如下：

- `npm run lint` 通过，`npm run build` 重复运行均通过。
- 真实已安装 OpenCode 1.18.25 self-test 通过；Task resume disabled。
- focused merged diagnostics/lifecycle gate 为 100/100。
- 完整 installed-loader gate 为 3/3、零 skip。其真实 target-free self-test 在 port
  4096 为每个已解析 localhost loopback 地址持有有效 health decoy，connections 和
  requests 均为零，观察来源为 `client._client.get`；real-serve production
  activation/disposal 和 correlated startup log 也通过。
- 普通已安装 OpenCode 1.18.25 的 Task suite 为 6/6；resume disabled，每个
  `task_id` 都在 upstream 执行前被拒绝，新的 Task fallback 通过。
- 精确 baseline binary
  `/tmp/opencode/opencode-ai-1.18.18/node_modules/.bin/opencode` 解析为
  `/tmp/opencode/opencode-ai-1.18.18/node_modules/opencode-ai/bin/opencode.exe`；
  baseline 接受准确六名称 manifest：6 passed、0 failed、0 skipped，并启用了 resume
  scenario。
- 第六个精确场景从 root model-visible Task result 取得 `task_id`，与实际 direct child
  交叉验证，证明相同 package write 在新预检前被阻止且 SSH/SFTP preparation 为零；
  随后通过一个新的 `remote_status`，并通过 fake-SFTP get、private put 和
  `mv -fT --` 原子完成预期最终内容。
- 每个自动化 root、child 和 resumed-child 预检都只使用一个 `remote_status` SSH
  identity 命令，没有单独的 Bash 预检。
- `npm test` 通过 32 个 unit/integration file 和 453/453 个 test，随后 2 个 smoke
  file、2 个 test 以 2/2 通过。
- `npm pack --dry-run` 通过并列出 166 个文件，`git diff --check` 通过。
- 实际 installed-loader integration 通过动态选择的 test-only IPv4 loopback port
  运行真实 OpenCode serve process；serve mode 的 host-configured SDK transport 使用
  该 process-owned listener。该 harness 不会把固定 fixture port 变成 production 输入
  或 trust boundary，而且它与 no-listener pre-SSH `opencode debug config` probe 相互
  独立；其 transport fixture 和 Task suite 仍使用 fake SSH/SFTP，不是真实主机证据。

本轮未运行真实 SSH。自动 no-listener case 是 target-free `debug config` 加 hermetic
SDK path，不是 default no-argument TUI automation；这些 gate 不证明 visual TUI、
真实 permission UI、model 或 real-SSH 行为。

真实远程写入测试必须使用独立的非生产服务器和一次性目录。当前
`npm run test:real` 确实存在，会修改配置的一次性目标并要求经审查的
`sudo -n id -u`；它不是 Task、OpenCode、权限 UI 或 TUI 证据。patch 删除和移动
仍会被拒绝。详细边界请参阅 [SECURITY.md](SECURITY.md)。

兄弟会话的修改范围必须互不重叠，不支持并发编辑同一路径；冲突和锁检查仍只是
最后防线。取消会结束本地 OpenCode Task/会话并关闭本地 SSH 通道，但远程后代
进程可能继续运行，必须在远端检查后才能重试。

普通真实 loader 和 Task 集成测试使用已安装的 OpenCode；只有未显式选择 binary
且找不到 `opencode` 时才允许开发环境 skip。正式直接子会话发布目前只剩真实 SSH
双兄弟修改及真实权限界面/直接子会话 TUI 手动验证尚未完成。精确六场景 baseline
和已安装真实 Task 的 fake-SFTP 修改已完成；2026-08-28 未运行 `npm run test:real`。
历史 live-output TUI 通过只证明 Bash card，不证明上述两个剩余边界。
