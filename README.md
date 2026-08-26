# ChatGPT Codex Primary

让 ChatGPT Desktop 自带的 `Resources/codex app-server` 成为本机唯一的交互式
Codex App Server，并让普通 `codex` CLI 与指向同一台 Mac 的 ChatGPT Remote SSH
以 fail-closed 方式连接它。

> [!IMPORTANT]
> 本项目目前仅支持 macOS。安装流程依赖 macOS 的 `launchctl`、ChatGPT Desktop 的
> `.app` 目录结构和 Unix domain socket；Linux、Windows、WSL 及跨物理主机连接均不在
> 当前支持范围内。

## 背景与动机

ChatGPT Desktop、Codex CLI 和 ChatGPT Remote 都可以作为 Codex 的前端，但会话和运行
状态实际由它们连接的 App Server 管理。默认情况下，不同入口可能解析到不同的 Codex
可执行文件：桌面端使用应用包内的 `Resources/codex`，本地 CLI 使用 standalone，Remote
SSH 又可能通过 `CODEX_INSTALL_DIR` 或固定的 `~/.local/bin/codex` 启动 proxy。

一旦这些入口各自启动或连接不同的 App Server，就会出现看似同一台电脑、实际状态却不
相通的情况：桌面端已有的会话无法从手机继续，CLI 可能额外启动 standalone App Server，
甚至留下没有实际内容的空会话记录。单独设置一个环境变量也不足以覆盖所有入口，因为
Remote SSH 可能直接使用固定路径。

本项目选择 ChatGPT Desktop 包内的 App Server 作为这台 Mac 上交互式 Codex 的运行期
唯一真相源。桌面端负责它的生命周期，本地 CLI 与 Remote SSH 只作为客户端连接同一个
Unix socket。这样可以共享会话和运行状态，同时继续使用桌面端内嵌 Codex 所带的完整配置
与 App Tools。若桌面端没有运行，普通 CLI 会明确失败，而不是悄悄创建另一套状态。

## 系统要求

必需条件：

- macOS；当前实现没有声明或验证其他操作系统支持。
- ChatGPT Desktop 安装在默认位置 `/Applications/ChatGPT.app`。
- ChatGPT Desktop 包内存在可执行的 `Contents/Resources/codex` 和
  `Contents/Resources/cua_node/bin/node`。
- Node.js 22 或更高版本以及 npm。它们用于从源码运行安装、检查和测试；安装后的管理
  入口默认改用 ChatGPT Desktop 内嵌的 Node.js。
- 当前用户可写入 `~/.local`、`~/.codex`、`~/Library/LaunchAgents` 以及自己的 zsh
  配置文件。
- ChatGPT Desktop、Codex CLI 和 ChatGPT Remote SSH 使用同一个 macOS 用户及同一个
  `CODEX_HOME`。

可选条件：

- 已安装 Codex standalone。安装器可以接管其标准入口
  `~/.codex/packages/standalone/current/bin/codex`，并在卸载时恢复；同时会保留
  `codex-standalone` 作为显式救援入口。没有 standalone 时仍可安装，但该救援入口不可用。

本项目不需要 `sudo`，也不会修改 `/Applications/ChatGPT.app` 内的签名文件。

安装前可以先检查环境：

```sh
node --version
npm --version
test -x /Applications/ChatGPT.app/Contents/Resources/codex
test -x /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
```

## 目标行为

- 不修改 `/Applications/ChatGPT.app` 内的任何签名文件。
- ChatGPT 仍通过 `CODEX_CLI_PATH` 启动 stdio 入口。
- 显式清除旧的 `CODEX_APP_SERVER_USE_LOCAL_DAEMON`，避免将来重新触发默认 daemon 分支。
- 外部桥接器把 ChatGPT 的 JSONL stdio 转成 Unix socket 上的 WebSocket。
- 真正的主进程由当前 ChatGPT 包内的 `Resources/codex` 启动，并保留桌面端注入的
  `mcp_servers.codex_app` 配置。
- 普通 `codex` 强制使用专用 socket；主实例不存在时退出码为 69，不静默降级。
- ChatGPT Remote SSH 的 `codex app-server proxy` 被转发到同一个专用 socket，不再启动
  standalone App Server。
- `codex-standalone` 是明确的救援入口，不会由普通 `codex` 自动调用。

## 进程关系

```text
ChatGPT Desktop
  └─ chatgpt-codex (stdio/WebSocket bridge)
       └─ supervisor
            └─ /Applications/ChatGPT.app/Contents/Resources/codex app-server
                 └─ unix://$CODEX_HOME/chatgpt-primary/app-server.sock

codex ── --remote unix://... ───────────────────────────────────────┘

ChatGPT Remote（同一台 Mac）
  └─ SSH → codex app-server proxy --sock unix-socket ───────────────┘
```

Supervisor 监控 ChatGPT 主进程；ChatGPT 退出后会终止共享 App Server。新的 CLI
启动也会检查 owner、supervisor、server、App Tools pipe 和协议握手，任一不健康都拒绝
启动。

## 安装与卸载

### 安装

在源码目录运行：

```sh
npm run inst
```

安装器会完成以下操作：

- 将完整运行时安装到 `~/.local/share/chatgpt-codex-primary/releases/<内容哈希>`；
- 原子更新 `current`，并在版本变化时保留 `previous`；
- 只替换 `.zshenv`、`.zshrc` 与 `.zprofile` 中带 marker 的托管块；
- 设置 `CODEX_CLI_PATH`，让 ChatGPT Desktop 使用桥接入口；
- 设置 `CODEX_INSTALL_DIR`，让 ChatGPT Remote SSH 优先使用受保护的 `codex` 外壳；
- 将 `~/.local/bin/codex` 这个 Remote 固定入口安全改指向受保护外壳，并在收据中记录
  原 standalone symlink；
- 安装并重新加载登录级 LaunchAgent；

安装是幂等操作，不要求先卸载。项目源码移动后，当前安装不会失效；需要安装新版时，
直接在新目录再次运行 `npm run inst`，旧设置会被同一组 marker 与 LaunchAgent 自动
替换。所有持久配置都只引用稳定安装目录，不引用源码目录。

命令完成后需要完全退出并重新启动 ChatGPT Desktop，再打开一个新的 shell。可以这样验活：

```sh
codex-chatgpt-status
readlink ~/.local/bin/codex
codex --version
```

`codex-chatgpt-status` 应返回 `"ok": true`，本地入口应指向
`~/.local/share/chatgpt-codex-primary/current/bin/codex`。

### 卸载

建议完全退出 ChatGPT Desktop 后再运行：

```sh
npm run uninst
```

卸载会恢复安装前的 `~/.local/bin/codex` symlink，并删除托管 shell 块、LaunchAgent
和本项目设置的桌面端环境；它不删除版本化运行时或 standalone 安装。完成安装或卸载后
需要重新启动 ChatGPT Desktop；已有 shell 需要重新登录或重新加载配置。

卸载后可以检查 standalone 入口是否恢复：

```sh
readlink ~/.local/bin/codex
codex --version
```

如果安装前存在标准 standalone symlink，第一条命令应重新指向
`~/.codex/packages/standalone/current/bin/codex`。

也可以在源码目录已经不存在时使用已安装的管理入口：

```sh
~/.local/share/chatgpt-codex-primary/current/bin/chatgpt-codex-inst
~/.local/share/chatgpt-codex-primary/current/bin/chatgpt-codex-uninst
```

## Remote SSH 的适用边界

ChatGPT Remote SSH 会在目标机执行 `codex app-server proxy`；不同连接路径可能读取
`CODEX_INSTALL_DIR`，也可能直接落到 `~/.local/bin/codex`。本项目同时接管这两个入口，
再强制把 proxy 连接到桌面端共享 socket。安装器只会替换明确指向
`~/.codex/packages/standalone/current/bin/codex` 的 symlink；若该路径是普通文件或未知
symlink，会拒绝覆盖。

这只适用于 SSH 目标就是运行 ChatGPT Desktop 的同一台 Mac、同一用户且使用同一
`CODEX_HOME` 的场景。另一台物理主机无法直接访问本机 Unix socket；它仍需要自己的
App Server，或另行设计经过认证的跨主机传输与生命周期管理。

## 开发与验证

```sh
npm run check
npm test
```

默认测试包含参数守卫、失败关闭、版本化安装、入口接管/恢复和 Unix socket WebSocket
传输。真实 ChatGPT Desktop 集成测试是显式开启的测试，不会在普通测试中自动启动或操作
桌面端任务。

## 常见行为

- ChatGPT Desktop 未运行或共享 App Server 不健康时，普通 `codex` 会以退出码 69
  失败，并提示先启动桌面端；不会回退到 standalone。
- `codex app-server` 和 `codex remote-control` 会被受保护入口阻止，避免意外创建第二个
  App Server。
- `codex app-server proxy` 会忽略调用方提供的 socket，并强制连接本项目管理的共享
  socket。
- 安装器只会接管不存在的 `~/.local/bin/codex`，或明确指向标准 standalone 的 symlink；
  普通文件和未知 symlink 会触发安全失败，不会被覆盖。
- 如需有意识地绕过共享机制，请使用 `codex-standalone`。

## 回滚边界

运行卸载命令并重启 ChatGPT，即恢复桌面端默认行为，同时恢复 standalone 原有的
`~/.local/bin/codex` symlink。项目不会修改 standalone 的版本目录或二进制文件。

运行时采用版本化安装目录：

```text
~/.local/share/chatgpt-codex-primary/
  current  -> releases/<current>
  previous -> releases/<previous>
```

因此升级或试运行失败时可以原子切回 `previous`，不会覆盖上一个可用版本。
