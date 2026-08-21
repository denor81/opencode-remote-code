# OpenCode SSH

[English](README.md)

在本机运行 OpenCode 和 TUI，同时通过系统 OpenSSH 在远程主机上执行常用项目工具。
远程主机无需安装 OpenCode、Node.js、插件或其他 agent runtime。

本项目已针对 OpenCode 1.18.18 完成测试。每次建立 SSH 连接前，launcher 都会在
隔离的本地环境中要求已安装的 OpenCode 加载本项目的 server plugin。其他可识别
版本只有通过该检查后才能继续；手动 TUI 检查仍由用户完成。

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
OpenCode 1.18.18 是当前测试基线。Windows 用户应在 WSL 中运行。远端初始支持
Linux、SFTP、POSIX `sh` 以及 `realpath`/`pwd -P`。

完整的英文安装、SSH 配置、本地启动脚本、安全说明和手动 TUI 测试请参阅
[Installation And Usage](docs/installation-and-usage.md)。

## 用法

命令只接受 SSH alias 和远程绝对路径，不转发额外 OpenCode 参数：

```bash
opencode-ssh <ssh-alias> <absolute-remote-workdir>
```

模型、provider、权限、插件和 MCP 配置继续使用普通 OpenCode 配置。

启动 SSH 之前，launcher 会检查本机 `opencode` 版本，并在隔离的 HOME、config
和 workspace 中运行真实 loader 检查。loader 未能加载 plugin 时不会建立 SSH
连接。其他可识别版本通过检查后会显示警告并继续；无法识别的版本会被阻止。
该检查无法观察 TUI 绘制，因此版本变更后仍需完成人工检查。

等待期间终端会简短显示 checking、testing、passed 和 starting SSH。
`opencode-ssh self-test` 可在任意目录中单独运行，不需要 SSH alias 或远程主机。

`~/.config/opencode` 下的全局配置以及绝对路径的显式配置会保留。由于 OpenCode
从稳定的 launcher workspace 启动，调用命令目录中的 `opencode.json` 或
`.opencode/` 不会自动加载；远程会话所需设置应放入全局配置或绝对路径的
`OPENCODE_CONFIG`。launcher 会自动把已安装的
[`opencode-ssh-safety.md`](opencode-ssh-remote-use/opencode-ssh-safety.md) 加入子
OpenCode 的 instructions，并保留已有 instructions。无需向远程项目复制或链接该
文件。远程根目录的 `AGENTS.md`（若存在）会另外追加，只用于项目特定规则。

远程 workdir 是默认项目目录，但不是 chroot。直接访问 workdir 外的文件会请求
`external_directory` 权限。`/` 可作为 workdir，此时整个远程文件系统都在项目
范围内，但实际权限仍取决于 SSH 用户。

管理操作应使用明确的 `sudo -n` shell 命令。SFTP 支持的 `read`、`write`、
`edit` 和 `apply_patch` 不会通过 sudo 自动提权。

## 工具边界

以下工具通过 SSH 工作：`bash`、`read`、`write`、`edit`、`glob`、`grep`、
`apply_patch`。`remote_status` 用于报告连接状态。

其他 OpenCode 工具、插件、MCP、LSP、formatter、provider 流量和 TUI 内部功能
仍在本机运行。本项目不是 sandbox，也不保证所有 OpenCode 操作都在远端执行。

## SSH 密钥

launcher 禁用 SSH 账户密码和 keyboard-interactive fallback，但不启用
`BatchMode`。因此 OpenSSH 仍可请求确认 host key 或 key passphrase。若 key 已加载
到当前用户的 `ssh-agent`，launcher 会继承 `SSH_AUTH_SOCK`，通常不会再次询问。

## 测试

```bash
npm run lint
npm run build
npm run test:unit
npm run test:integration
npm run test:smoke
```

远程写入测试必须使用独立的非生产服务器和一次性目录。当前版本会在上传前检测
单文件内容冲突并通过同目录临时文件原子替换；多文件 patch 在传输故障时仍可能
部分完成。patch 删除和移动操作会被拒绝。详细边界请参阅
[SECURITY.md](SECURITY.md)。

真实 loader 集成测试会使用任意已安装的 OpenCode 版本；只有找不到 `opencode`
时才允许跳过。自动测试无法观察 TUI 绘制，因此版本变更后仍需执行英文安装指南中
的五项手动检查。
