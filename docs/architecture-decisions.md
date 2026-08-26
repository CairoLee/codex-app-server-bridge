# 架构与关键决策

本文面向 Codex App Server Bridge 的维护者和希望理解其工作原理的使用者。它记录已经
确认的系统边界、核心决策和容易踩坑的地方，不复述开发期间的逐次调试过程。

Codex App Server Bridge 是第三方本机工具，不是 OpenAI 官方产品。官方组件名称是
[Codex App Server](https://learn.chatgpt.com/docs/app-server)，移动端和异地接入能力称为
[Codex Remote](https://learn.chatgpt.com/docs/remote)。本文中的“共享”描述的是本项目
建立的本机拓扑，不代表 OpenAI 提供了同名产品模式。

## 要解决的问题

ChatGPT Desktop、Codex CLI 和 ChatGPT Remote 都可以成为 Codex 的前端，但它们只有
连接到同一个 App Server 时，才能看到一致的会话和运行状态。

在 macOS 上，不同入口默认可能解析到不同的 Codex 可执行文件：

- ChatGPT Desktop 使用应用包内的 `Contents/Resources/codex`；
- 本地终端通常使用 standalone Codex；
- ChatGPT Remote 通过 SSH 进入目标机后，可能使用 `CODEX_INSTALL_DIR`，也可能直接
  执行 `~/.local/bin/codex`；
- 各入口如果自行启动 App Server，就会形成彼此隔离的会话集合。

本项目的目标不是同步多套 App Server 的数据，而是避免产生多套 App Server：让桌面端
内嵌 Codex 启动唯一的交互式实例，其他本机入口都连接它。

## 已确认的事实基线

1. ChatGPT Desktop 可以通过 `CODEX_CLI_PATH` 改用一个外部 CLI 入口，但从 Dock 启动的
   GUI 应用不会可靠继承终端的 shell 环境。需要通过登录级 LaunchAgent 调用
   `launchctl setenv`，使桌面端启动时获得该变量。
2. 桌面端对 CLI 使用 JSONL stdio；真正的 `codex app-server` 可以使用 Unix domain
   socket。两者之间需要一个 stdio/WebSocket 桥接层。
3. 普通交互式 Codex CLI 可以通过 `--remote unix://...` 连接现有 App Server。
4. ChatGPT Remote 的 SSH 路径会执行 `codex app-server proxy`。只设置
   `CODEX_CLI_PATH` 不足以覆盖它，还必须同时管理 `CODEX_INSTALL_DIR` 和标准入口
   `~/.local/bin/codex`。
5. `CODEX_APP_SERVER_USE_LOCAL_DAEMON` 曾影响桌面端的 App Server 选择。安装时显式清除
   它，避免旧配置重新激活另一条 daemon 路径。
6. 共享会话的充分条件是多个前端连接同一个健康 App Server；仅仅使用同一个
   `CODEX_HOME` 或同一个 Codex 二进制并不等价。

这些结论依赖当前 ChatGPT Desktop 和 Codex CLI 的启动协议。应用升级后若入口参数、
Remote proxy 或 App Server 协议改变，需要重新验证，而不能只依赖版本号相近。

## 核心架构决策

### 1. 桌面端内嵌 Codex 是运行期的唯一真相源

选择 `/Applications/ChatGPT.app/Contents/Resources/codex` 启动共享 App Server。原因是
桌面端会向它注入当前版本所需的配置和 App Tools 管道，而且它随桌面端一起升级。

不选择 standalone 作为主实例并不是因为 standalone 一定能力不足，而是本项目首先要
保证桌面端、CLI 和 Remote 三个入口使用同一实例。若以后发现桌面端正式支持连接外部
长期运行的 App Server，可以重新评估主从方向。

### 2. 不修改 ChatGPT.app

项目不会替换、包装或改写应用包中的 `Resources/codex`。这样可以避免破坏代码签名，
也不需要在每次 ChatGPT Desktop 升级后重新修改应用内容。

桥接器安装在用户目录，通过环境变量成为桌面端的 CLI 入口；真正执行的 App Server
仍然是当前应用包内的原始二进制。

### 3. 使用 Unix socket 汇合客户端

整体关系如下：

```text
ChatGPT Desktop
  └─ codex-bridge-launcher (stdio/WebSocket bridge)
       └─ supervisor
            └─ ChatGPT.app/Contents/Resources/codex app-server
                 └─ unix://$CODEX_HOME/codex-app-server-bridge/app-server.sock

codex --remote unix://... ──────────────────────────────────────────┘

ChatGPT Remote → SSH → codex app-server proxy --sock ... ─────────┘
```

Supervisor 保存 owner、supervisor 和 server PID，并监控桌面端主进程。桌面端退出后，共享
App Server 随之终止，避免留下无人管理的后台实例。

### 4. 普通 Codex 失败关闭

普通 `codex` 入口在共享实例不可用时返回退出码 69，并提示启动或重新启动 ChatGPT
Desktop。它不会自动回退到 standalone，因为自动回退会悄悄制造第二套会话状态。

确实需要绕过共享机制时，使用者必须显式运行 `codex-standalone`。此外，受保护入口会
阻止直接执行 `codex app-server` 和 `codex remote-control`，避免意外启动第二个服务；
`codex app-server proxy` 则会被强制改写到受管理的 socket。

### 5. 安装结果不依赖源码目录

源码执行 `npm run inst` 后，完整运行时会安装到版本化目录：

```text
~/.local/share/codex-app-server-bridge/
  current  -> releases/<current>
  previous -> releases/<previous>
```

shell 配置、LaunchAgent 和 CLI 入口只引用该稳定目录，不引用源码 checkout。因此项目
目录可以移动；移动后从新目录再次安装即可升级，不需要先反向处理旧源码路径。

## 持久配置与职责

| 位置 | 用途 |
| --- | --- |
| `~/.local/share/codex-app-server-bridge` | 版本化运行时及 `current`/`previous` |
| `~/.local/state/codex-app-server-bridge` | 安装收据与面向排障的 JSON 操作日志 |
| `$CODEX_HOME/codex-app-server-bridge` | socket、运行状态和 App Server 日志 |
| `~/.local/bin/codex` | Remote 可能直接使用的固定入口 |
| `~/.zshenv`、`~/.zshrc`、`~/.zprofile` | 带 marker 的 PATH 和环境配置 |
| `~/Library/LaunchAgents/local.codex-app-server-bridge.env.plist` | 为 Dock 启动的桌面端设置 GUI 环境 |

本项目自有的覆盖变量统一使用 `CODEX_BRIDGE_` 前缀，例如：

- `CODEX_BRIDGE_INSTALL_ROOT`
- `CODEX_BRIDGE_LAUNCH_AGENTS_DIR`
- `CODEX_BRIDGE_LOCAL_BIN_DIR`
- `CODEX_BRIDGE_RECEIPT`
- `CODEX_BRIDGE_STATE_DIR`
- `CODEX_BRIDGE_SOCKET`
- `CODEX_BRIDGE_RESOURCE_PATH`
- `CODEX_BRIDGE_NODE_PATH`

以下变量属于 Codex 或桌面端的既有边界，不能随项目品牌重命名：

- `CODEX_CLI_PATH`
- `CODEX_INSTALL_DIR`
- `CODEX_APP_SERVER_USE_LOCAL_DAEMON`
- `CODEX_APP_TOOLS_PIPE_PATH`
- `CODEX_HOME`
- `CODEX_STANDALONE_PATH`

## 安装、卸载与用户体验

项目名采用 **Codex App Server Bridge**，短命令采用 `codex-bridge`。`Bridge` 表明项目
负责连接和生命周期协调，而不是重新实现 Codex App Server。

统一命令提供：

- `codex-bridge status`：默认输出友好结论，`--verbose` 和 `--json` 用于排障或脚本；
- `codex-bridge inst`：安装或升级；
- `codex-bridge uninst`：解除安装并恢复原入口；
- `codex-bridge logs`：列出操作日志，`--latest` 显示最近的完整记录。

首次安装仍需要从源码运行 `npm run inst`，因为此时命令尚未进入 PATH。

安装和卸载都会先确认 ChatGPT Desktop 已完全退出。若仍检测到主进程，命令在任何文件、
symlink 或 `launchctl` 修改之前退出。这个限制用于避免正在运行的桌面端继续使用旧环境，
而磁盘配置已经切换到新版本的半完成状态。

操作成功后，终端只显示结果和下一步；修改文件、收据和恢复信息等技术明细写入私有 JSON
日志。卸载会恢复安装前的 standalone symlink，但保留版本化运行时和日志，避免把卸载
误做成不可恢复的数据清理。

## 旧名称迁移策略

项目早期名称为 `chatgpt-codex-primary`。新版本不保留旧的用户命令别名，但会识别并清理：

- `# >>> chatgpt-codex-primary >>>` shell marker；
- `local.chatgpt-codex-primary.env` LaunchAgent；
- `~/.local/state/chatgpt-codex-primary/registration.json` 注册收据；
- 指向旧版本化运行时的受管理 `~/.local/bin/codex` symlink。

迁移时必须继承旧收据中记录的原始 standalone 入口，确保未来卸载仍能恢复到真正的安装前
状态。如果检测到旧托管 symlink 却找不到恢复收据，安装器会失败关闭，而不是猜测用户原先
的入口。

旧的 `~/.local/share/chatgpt-codex-primary` 版本化运行时不会自动删除；它已经失效但仍可
用于人工回滚或审计。是否清理属于独立的破坏性操作。

## 适用边界与非目标

- 当前只支持 macOS，并假设 ChatGPT Desktop 位于 `/Applications/ChatGPT.app`。
- Desktop、CLI 和 Remote SSH 必须落到同一台 Mac、同一 macOS 用户，并使用同一个
  `CODEX_HOME`。
- Unix socket 不能直接跨物理主机使用。本项目不提供公网传输、认证代理或多主机同步。
- 项目不负责安装 ChatGPT Desktop，也不修改 standalone 的版本目录。
- 项目不承诺兼容未来所有 ChatGPT Desktop 内部启动方式；升级后的兼容性必须通过真实
  集成测试确认。

## 维护和升级检查清单

修改共享逻辑或适配新版 ChatGPT Desktop 时，至少核对：

1. `Resources/codex` 与内嵌 Node.js 路径仍然有效；
2. 桌面端仍通过 `CODEX_CLI_PATH` 调用桥接入口；
3. 桌面端传入的 `app-server` 参数仍能被准确识别和替换 transport；
4. `CODEX_APP_TOOLS_PIPE_PATH` 仍存在且为有效 socket；
5. `codex --remote unix://...` 仍能列出和继续桌面端会话；
6. `codex app-server proxy` 仍是 Remote SSH 的入口；
7. Dock 启动、普通终端和 SSH 登录三种环境都解析到受保护入口；
8. ChatGPT 退出后 supervisor 和 App Server 能正常收敛；
9. 安装、重复安装、卸载和重复卸载保持幂等；
10. standalone 原入口可以根据收据精确恢复。

默认测试覆盖参数守卫、stdio/Unix socket 传输、失败关闭、版本化运行时、旧版迁移、入口
接管与恢复，以及友好的命令输出。真实 `Resources/codex` 和 Remote proxy 测试需要显式
开启，避免普通单元测试意外创建或修改桌面端会话。
