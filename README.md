# Codex App Server Bridge

让 ChatGPT Desktop 自带的 `Resources/codex app-server` 成为本机唯一的交互式
Codex App Server，并让普通 `codex` CLI 与指向同一台 Mac 的 ChatGPT Remote SSH
以 fail-closed 方式连接它。

Codex App Server Bridge 是第三方本机工具，不是 OpenAI 官方产品。日常管理命令为
`codex-bridge`。

如果需要了解为什么采用这套架构、各入口如何汇合，以及升级时应重点检查什么，请阅读
[架构与关键决策](docs/architecture-decisions.md)。

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
- ChatGPT Desktop 包内存在可执行的 Codex 和 `Contents/Resources/cua_node/bin/node`。
  Codex 优先使用新版 `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`，
  不可用时兼容旧版 `Contents/Resources/codex`。下文 `Resources/codex` 泛指这个内嵌
  Codex；显式设置的 `CODEX_BRIDGE_RESOURCE_PATH` 始终优先。
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
node --input-type=module -e 'import { resourceCodexPath } from "./src/settings.mjs"; import { accessSync, constants } from "node:fs"; const p = resourceCodexPath(); accessSync(p, constants.X_OK); console.log(p)'
test -x /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
```

## 目标行为

- 不修改 `/Applications/ChatGPT.app` 内的任何签名文件。
- ChatGPT 仍通过 `CODEX_CLI_PATH` 启动 stdio 入口。
- 显式清除旧的 `CODEX_APP_SERVER_USE_LOCAL_DAEMON`，避免将来重新触发默认 daemon 分支。
- 外部桥接器把 ChatGPT 的 JSONL stdio 转成 Unix socket 上的 WebSocket。
- 桌面端在工具管道建立前启动的无 `CODEX_APP_TOOLS_PIPE_PATH` 辅助实例，
  直接使用内嵌 Codex 的 stdio，不创建或复用共享服务；携带工具管道的主连接
  仍使用共享实例，并保留原有健康检查。旧版携带管道的启动方式继续兼容。
- 真正的主进程由当前 ChatGPT 包内的 `Resources/codex` 启动，并保留桌面端注入的
  `mcp_servers.codex_app` 配置。
- ChatGPT Browser helper 的显式 `app-server --listen ...` 调用直接进入短生命周期的
  `Resources/codex app-server`；旧版 helper 若访问共享 socket 被拒也会回退到该路径。
  桌面端没有 `--listen` 的主连接仍使用共享实例。
- 普通 `codex` 强制使用专用 socket；主实例不存在时退出码为 69，不静默降级。
- 新建交互式 `codex` 会把调用端的绝对工作目录显式传给共享 App Server；用户提供的
  `-C`/`--cd` 优先，`resume`/`fork` 继续使用 Codex 原生的目录选择语义。
- ChatGPT Remote SSH 的 `codex app-server proxy` 被转发到同一个专用 socket，不再启动
  standalone App Server。
- `codex-standalone` 是明确的救援入口，不会由普通 `codex` 自动调用。
- `codex update` 是例外：它使用 standalone 的原生更新探测，但将安装器的
  可见命令目录隔离到 bridge 运行时下，不覆盖受保护的 `codex` 外壳。

## 进程关系

```text
ChatGPT Desktop
  └─ codex-bridge-launcher (stdio/WebSocket bridge)
       └─ supervisor
            └─ /Applications/ChatGPT.app/Contents/Resources/codex app-server
                 └─ unix://$CODEX_HOME/codex-app-server-bridge/app-server.sock

codex ── --remote unix://... ───────────────────────────────────────┘

ChatGPT Remote（同一台 Mac）
  └─ SSH → codex app-server proxy --sock unix-socket ───────────────┘

ChatGPT Browser helper（沙箱内）
  └─ codex-bridge-launcher ── app-server --listen ...
       └─ Resources/codex app-server（仅浏览器安全配置读取）
```

Supervisor 监控 ChatGPT 主进程；ChatGPT 退出后会终止共享 Codex App Server。新的 CLI
启动也会检查 owner、supervisor、server、App Tools pipe 和协议握手，任一不健康都拒绝
启动。

## 安装与卸载

### 安装

在源码目录运行：

```sh
npm run inst
```

如果 ChatGPT Desktop 仍在运行，安装器会显示对应 PID，要求先使用 ⌘Q 完全退出，并以
退出码 69 结束；检测发生在任何文件或环境修改之前。

安装器会完成以下操作：

- 将完整运行时安装到 `~/.local/share/codex-app-server-bridge/releases/<内容哈希>`；
- 原子更新 `current`，并在版本变化时保留 `previous`；
- 只替换 `.zshenv`、`.zshrc` 与 `.zprofile` 中带 marker 的托管块；
- 设置 `CODEX_CLI_PATH`，让 ChatGPT Desktop 使用桥接入口；
- 设置 `CODEX_INSTALL_DIR`，让 ChatGPT Remote SSH 优先使用受保护的 `codex` 外壳；
- 将 `~/.local/bin/codex` 这个 Remote 固定入口安全改指向受保护外壳，并在收据中记录
  原 standalone symlink；
- 安装并重新加载登录级 LaunchAgent；
- 自动清理旧项目名使用的 shell marker、LaunchAgent 与注册收据。

安装是幂等操作，不要求先卸载。项目源码移动后，当前安装不会失效；需要安装新版时，
直接在新目录再次运行 `npm run inst`，旧设置会被同一组 marker 与 LaunchAgent 自动
替换。所有持久配置都只引用稳定安装目录，不引用源码目录。

命令完成后需要完全退出并重新启动 ChatGPT Desktop，再打开一个新的 shell。可以这样验活：

```sh
codex-bridge status
readlink ~/.local/bin/codex
codex --version
```

`codex-bridge status` 应显示“共享 Codex App Server 运行正常”，本地入口应指向
`~/.local/share/codex-app-server-bridge/current/bin/codex`。

状态命令默认只显示健康结论与建议；需要排障细节或机器可读结果时使用：

```sh
codex-bridge status --verbose
codex-bridge status --json
```

终端只显示面向使用者的结果和下一步；完整安装明细写入
`~/.local/state/codex-app-server-bridge/logs/`。也可以使用以下命令查看：

```sh
codex-bridge logs
codex-bridge logs --latest
```

日常运行日志默认开启，保存在
`$CODEX_HOME/codex-app-server-bridge/runtime-logs/YYYY-MM-DD.jsonl`；
设置 `CODEX_BRIDGE_STATE_DIR` 时改用该目录下的 `runtime-logs/`。
每个本地自然日一个 JSONL 文件，保留今天和前两天。进程启动、跨日时清理旧文件；
所有 bridge 进程都未运行时不会唤醒机器清理，下次启动再清理。

```sh
codex-bridge logs --runtime
codex-bridge logs --runtime --latest
codex-bridge logs --runtime --json
CODEX_BRIDGE_RUNTIME_LOG=0 codex --version
```

`CODEX_BRIDGE_RUNTIME_LOG=0` 关闭日常日志，未设置或其他值表示开启。
开关由启动时的环境决定；若要控制桌面端 launcher/supervisor，需要让桌面进程继承它，
并重新启动对应进程。例如 macOS 可先执行
`launchctl setenv CODEX_BRIDGE_RUNTIME_LOG 0`，再完全退出并重启 ChatGPT Desktop；
恢复默认可执行 `launchctl unsetenv CODEX_BRIDGE_RUNTIME_LOG` 后重启。
该开关不控制安装操作日志及下述临时 Launcher 诊断。

记录包括入口参数形态、当前 PID/PPID、启动的可执行文件与子进程 PID、
共享服务 generation/owner PID、复用或替换、转发/跳过/阻止原因、退出码和信号。
参数中的自由文本、路径和凭据值脱敏；不记录环境变量值或协议消息正文。
stdio bridge 仅在连接和结束时记录事件及消息数/空行跳过数，不逐条解析或写入消息。

App Server 原本追加到 `app-server.log` 的 stdout/stderr 改为同一每日文件中的
`process_output` 记录。这部分是上游原始诊断输出，可能包含路径或上游打印的敏感内容，
分享日志前应检查。目录权限为 `0700`、文件为 `0600`。
历史 `app-server.log` 和安装操作日志不属于新滚动策略，不会自动删除。

写入采用异步批量、有界队列；大量输出会限速、截断或丢弃并记录汇总计数，
写盘失败不会阻止 bridge 工作。正常退出会刷新队列；强制终止或磁盘故障可能缺少尾部记录。
这套日志用于低成本故障定位，不是完整协议审计。

需要区分 ChatGPT Desktop 主 App Server 与 Browser helper 的实际启动形态时，可以临时
启用 Launcher 诊断：

```sh
npm run diag:arm
npm run diag:show
npm run diag:disable
npm run diag:clear
```

诊断默认关闭。`diag:arm` 会创建
`$CODEX_HOME/codex-app-server-bridge/launcher-diagnostics.json` 配置开关；配置文件不存在时，
Launcher 只判断一次文件是否存在，不加载诊断模块，也不读取或写入 trace。开关启用后，
记录在带当前 UID 的 `/tmp` 私有目录中保存，6 小时后自动失效，最多记录 64 次调用；过期或
达到上限会自动移除配置开关。

记录只包含脱敏后的参数形态、PID/PPID、工作目录末级名称，以及与 Browser、Codex、
Electron 和沙箱有关的非敏感环境变量名称；不会记录 stdin、环境变量值、凭据或完整工作
目录。`diag:disable` 关闭开关但保留已有 trace 供分析，`diag:clear` 同时关闭并删除记录。

### 卸载

完全退出 ChatGPT Desktop 后运行：

```sh
npm run uninst
```

如果仍检测到桌面端主进程，卸载器同样会以退出码 69 拒绝继续，并保证本次不修改任何
设置。

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

卸载终端输出不会展开修改文件等内部 JSON；完整明细保存在
`~/.local/state/codex-app-server-bridge/logs/`。重复卸载是安全的，并会直接提示当前已经是
未安装状态。

也可以在源码目录已经不存在时使用已安装的管理入口：

```sh
~/.local/share/codex-app-server-bridge/current/bin/codex-bridge inst
~/.local/share/codex-app-server-bridge/current/bin/codex-bridge uninst
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

默认测试包含参数守卫、失败关闭、Browser 沙箱权限回退、版本化安装、入口接管/恢复和
Unix socket WebSocket 传输。真实 ChatGPT Desktop 集成测试是显式开启的测试，不会在
普通测试中自动启动或操作桌面端任务。

## 常见行为

- ChatGPT Desktop 未运行或共享 Codex App Server 不健康时，普通 `codex` 会以退出码 69
  失败，并提示先启动桌面端；不会回退到 standalone。
- 执行 `inst` 或 `uninst` 时，如果 ChatGPT Desktop 仍在运行，命令会在所有修改之前
  失败并提示先完全退出，避免新旧配置只对部分进程生效。
- `codex update` 会更新保留的 standalone 安装；更新后普通 `codex` 仍是受保护
  入口，`codex-standalone` 则直接使用新的 standalone release。
- `codex app-server` 和 `codex remote-control` 会被受保护入口阻止，避免意外创建第二个
  App Server。
- Computer Use 认证查询例外：仅当直接父进程是默认安装位置的官方
  `SkyComputerUseService`、OpenAI 代码签名校验通过，且参数恰为
  `app-server --listen stdio://` 时，直通内嵌 Codex。查询实例不成为共享服务；
  来源无法确认或参数不同仍拒绝。该规则兼容已有的新旧内嵌 Codex 路径。
- `codex app-server proxy` 会忽略调用方提供的 socket，并强制连接本项目管理的共享
  socket。
- 新建交互式 `codex` 即使连接由桌面端从 `/` 启动的共享 App Server，也会保留终端调用
  位置；显式 `-C`/`--cd` 不会被覆盖。
- Browser helper 的显式 `--listen` 调用直接使用 `Resources/codex`；未携带该参数的旧版
  helper 只有在连接共享 socket 明确返回 `EPERM` 或 `EACCES` 时才回退，其他启动错误不会
  静默降级。
- 安装器只会接管不存在的 `~/.local/bin/codex`，或明确指向标准 standalone 的 symlink；
  普通文件和未知 symlink 会触发安全失败，不会被覆盖。
- 如需有意识地绕过共享机制，请使用 `codex-standalone`。

## 回滚边界

运行卸载命令并重启 ChatGPT，即恢复桌面端默认行为，同时恢复 standalone 原有的
`~/.local/bin/codex` symlink。项目不会修改 standalone 的版本目录或二进制文件。

运行时采用版本化安装目录：

```text
~/.local/share/codex-app-server-bridge/
  current  -> releases/<current>
  previous -> releases/<previous>
```

因此升级或试运行失败时可以原子切回 `previous`，不会覆盖上一个可用版本。
