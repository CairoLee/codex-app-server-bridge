# 桌面兼容性调查记录

## 2026-10-09：配置告警与新建对话失败

调查基线为 ChatGPT Desktop `26.1007.21159`、内嵌 Codex
`0.162.0-alpha.17.2`。Bridge 选择新版应用包中的 `CodexCLI.app` 可执行文件；
同目录 `bin/codex` 只是调用这个文件的 wrapper。升级独立版不会替换共享服务。

### 已确认并修复的 Bridge 问题

- 健康检查先于桌面端发送 `initialize`，原探测名称会占用进程级 originator，后续
  `status` 还会覆盖 User-Agent 后缀。改为上游保留的 non-originating 探测身份后，
  隔离实验中的直连与 Bridge 返回相同的真实客户端身份；后续健康检查也保持该身份。
- `initialize` 返回 RPC 错误或缺少 `userAgent` 时，原探测可能误报成功；现在明确失败。
- WebSocket 已关闭时，原 stdio 桥接仍可能等待未结束的 stdin。已复现此挂起并修复：
  及时停止输入、传播传输或输出错误，并按序排空已收到的响应。结束日志增加
  `stdin-eof`、`peer-close`、`error`，不记录协议正文。

### 配置告警的对照结果

使用独立临时 `CODEX_HOME`、独立 socket、同一内嵌二进制，对比原生 stdio 和 Bridge。
`config/read`、`configRequirements/read`、普通及携带以下配置的临时 `thread/start`
在两种路径中均成功：

```json
{
  "features.code_mode_tool_description_first": true,
  "features.guardianv2.thread_context": true
}
```

两条路径均产生相同的 `configWarning` 和 `deprecationNotice`：前者是未知配置项，
后者已被废弃，服务端说明线程自有 Guardian 上下文始终启用。当前用户配置没有这两个
键；桌面端会动态注入功能开关。因此不能把这两条告警归因于 Bridge，也不能用隐藏
通知或删除任意配置字段作为修复。此次更改不保证消除这些上游告警。

### 仍需现场复测的现象

新建对话显示“无法加载工作空间设置”的对应 UI 文案是
`workspacePolicy.loadError.title`。当前应用代码的触发链包括账号状态、账号 settings、
`workspace_policy` 与 `workspace_policy/acknowledge` 的读取，区别于本地项目
`config/read`。保留日志没有对应失败请求的状态码或响应，因此尚未证明此问题与
Bridge 的断线缺陷存在因果关系；未绕过或修改工作空间策略。

云端会话 access denied、插件目录元数据验证和文档 MCP 的历史网络错误也未证明来自
Bridge。此次不修改这些服务的权限或生成缓存。

### 为下一次复现补充的诊断

stdio bridge 新增有界、脱敏的 RPC 观察器，复用每日运行日志及三天保留策略。
通过 `connectionId` 与 `requestRef` 关联请求方法、错误码、错误分类、耗时；插件名称只记录
形态、来源和连接内匿名标记。正文、原始 ID、路径、配置值及自由文本错误不写入新增字段。
成功慢响应、长时间等待与关闭时未收到响应分别记录，`forwarding` 明确区分观察到但尚未
提交的请求和已提交传输层的请求，避免把本地发送失败误判为服务端处理失败。

每分钟汇总失败与配置告警；大消息跳过解析、追踪容量淘汰、过期、明细限速均记录计数，
不能把采集缺口当作服务端没有响应。具体上限见 README 的运行日志说明。
这个改动补充排障证据，不会隐藏现有错误，也不修改或重试请求。云端会话与工作空间策略
等绕过本地 bridge 的链路仍需桌面端自己的请求状态与响应证据。

### 验证与应用边界

- `npm test`：96 通过，4 项按默认配置跳过；包含 RPC 关联、脱敏、限速、容量、关闭和原文转发验证
- `RUN_RESOURCE_INTEGRATION=1 node --test test/resource-integration.test.mjs`：3 通过
- `npm run check`、`git diff --check`：通过
- 安装前验证时桌面共享服务保持健康；当时未安装新运行时、未重启桌面端、未提交或推送

手动退出 ChatGPT 后，在源码目录执行 `npm run inst` 并重新启动，再检查配置页、创建
新对话和普通通讯。记录错误发生时间与所在界面，以便对照新的 `bridge.closed.reason`
及 `rpc.*` 日志；可用 `codex-bridge logs --runtime --latest` 查看。源码变化需要重新安装
才会被桌面端使用，当前运行时不会自动切换。需要回退时可以从先前提交重新安装；
不必删除会话或用户配置。

### 安装后的日志复查：2026-10-09 16:18–16:22（北京时间）

安装于 16:18:15 完成，启用运行时 `f54f8ee7ac6d`；桌面端于 16:18:21 启动。
已安装的 RPC 观察器、stdio bridge、日志模块和 WebSocket 模块均与工作区逐文件校验一致。
现场健康检查成功，主连接保持在线，没有 `launcher.failed`、`guard.failed`、
`rpc.pending`、`rpc.interrupted` 或 `bridge.closed`。退出的辅助子进程均返回 0。

截至 16:22:41 的日志快照仍有以下异常，不能视为已经全部修复：

| 现象 | 本次记录 | 与此前的关系和证据边界 |
| --- | --- | --- |
| 桌面 HTTP 请求 `403 / cloudflare_challenge` | 57 条，涉及账号、设置、Spaces 等接口 | 重启前已有同类记录；Local Work 执行器另有注册 HTTP 403 失败，尚未证明同一原因 |
| `plugin/read` 无效远程插件 ID | 1 次，`-32600` | 旧错误再次出现；新增日志确认 `pluginNameKind=qualified-name`、`marketplaceSource=remote`，名称含 `@`，而远程 ID 校验拒绝此字符；调用方为何选择该分支仍待定位 |
| 文件读取与元数据失败 | `fs/readFile` 缺少 `environmentId` 3 次；`fs/getMetadata` 文件不存在 5 次 | 均有历史记录；不能把文件不存在误判为缺少 environmentId，也不能从脱敏日志确定具体缺失路径 |
| 未识别配置及 Guardian 废弃配置 | 仍有记录 | 原生内嵌服务也已复现，新增日志没有隐藏它们 |
| Page 窗口预热超时 | 16:20:29 一次，`claimed=false`、`editorReady=false` | 在保留的旧桌面日志中未检出相同错误，尚未证明是 Bridge 引入 |

另有旧的 Chrome 目录访问 `EPERM`、历史 turn 无法匹配、MCP 不支持资源枚举、
工作树归档重试和 callback 缺失告警。没有该时间窗内的 `workspace_policy` 失败请求记录，
因此“无法加载工作空间设置”的实际失败仍不能据此宣布修复。

新增 RPC 汇总已工作：截至 16:21:23 的三个完整窗口观察到 513 个请求、493 个响应、
6 个失败响应；20 条大消息按上限跳过解析，影响 28 条请求的观察关联，另有 8 条未关联响应。
这些计数表示诊断覆盖缺口，不表示传输丢包。上游 stderr 另有 44 个输出块被限速；
上述异常次数是日志可见数量，不是完整错误总数。此次仅复查并记录证据，未再修改运行程序。

### 重新登录后的复查：2026-10-09 16:28–16:30（北京时间）

`account/logout` 于 16:26:26 成功返回，`account/login/start` 于 16:28:00 返回，
16:28:16 的 `account_login_completed` 明确记录 `success=true`，随后账号读取成功。
桌面主进程、共享服务 PID 和主 Bridge 连接保持不变，这是同一应用进程中的账号重新登录。

固定观察窗口为 16:28:16–16:30:40：

- 16:25–16:26 退出登录前后出现 token refresh 401、`token_revoked`、6 次 Apps MCP
  401 启动失败及插件缓存刷新失败。上述凭据失效错误在登录后窗口内未再次记录，
  但仅凭日志安静不能确认全部 MCP 实例都已恢复。
- 桌面 HTTP `403 / cloudflare_challenge` 仍有 33 条，包括账号、用户设置、订阅和模型
  接口。重新登录并未解决此类错误，也不能仅由先前登录凭据失效解释。
- `plugin/read` 在 16:29:04 再次返回无效远程 ID，匿名插件标记与 16:18 的失败相同；
  请求仍为含 `@` 的名称配合远程来源。输入格式问题没有随重新登录消失。
- `fs/readFile` 缺少 `environmentId` 1 次、`fs/getMetadata` 文件不存在 5 次；另有
  两个 worktree 的 `codex-shell-environment.json` 缺失记录。
- 16:28:21 模型目录刷新超时一次；对应 `model/list` RPC 在约 5 秒后返回成功，
  不能把 RPC 成功等同于远端目录刷新成功。
- UI 的 unknown conversation item 通知 281 条、`ResizeObserver` 错误 13 条。
  这些类型在本次重新登录之前已有记录；配置告警也仍存在。

现场 Bridge 健康检查成功，窗口内没有主连接关闭、请求等待超过 30 秒、启动失败或
守卫失败记录。结论是账号登录成功、本地通讯正常，但 HTTP 挑战与若干客户端错误仍在；
未证明全部异常来自 Bridge，未修改运行程序或再次操作登录状态。

### HTTP 挑战接口明细与浏览器差异

16:28:16–16:30:40 的 33 条 `sa_server_request_failed` 都记录了
`errorCode=cloudflare_challenge`、`status=403`、`attachAuth=true`、
`attachIntegrityState=true`。相对路由明细如下；两个 attach 字段表示请求要求附加信息，
不证明实际附加值被服务端接受。

| 方法 | 日志路由 | 次数 |
| --- | --- | --- |
| GET | `/subscriptions` | 6 |
| GET | `/accounts/check/{version}` | 4 |
| GET | `/settings/voices` | 2 |
| GET | `/tbo` | 2 |
| GET | `/settings/user` | 2 |
| GET | `/pins` | 2 |
| GET | `/tbo/primary` | 2 |
| GET | `/checkout_pricing_config/configs/{country_code}` | 2 |
| GET | `/payments/payment_methods` | 1 |
| GET | `/subscriptions/auto_top_up/settings` | 1 |
| GET | `/tpp/models/` | 1 |
| GET | `/accounts/optimized/check` | 1 |
| GET | `/referrals/invite/eligibility` | 1 |
| GET | `/ps/connectors/by-template` | 1 |
| GET | `/profiles/me` | 1 |
| GET | `/gift-credits/senders/eligibility` | 1 |
| GET | `/beacons/home` | 1 |
| GET | `/websites` | 1 |
| POST | `/sentinel/heartbeat` | 1 |

同一桌面日志的底层 fetch 记录（16:25:28–16:25:29，账号切换前的 401）明确给出
`https://chatgpt.com/backend-api/settings/user`、`/backend-api/tbo` 等绝对 URL，
用于确认客户端访问的后端域名和前缀；这不是对后续每条 403 的网络抓包。

只读分析当前 `app.asar` 内 `webview/assets/app-shared-2f2228189a8d.js`：
`Vvn` 错误处理调用 `Hvn` 检查响应头 `cf-mitigated` 是否等于 `challenge`，匹配时设置
`cloudflare_challenge`；该函数也支持从 JSON 错误体解析错误码。日志没有保存完整响应头，
因此应表述为客户端识别到挑战，不能声称已逐条独立抓取响应头验证。
此判定方式与 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)
一致。

浏览器主站可访问与桌面 API 请求被挑战可以同时发生。Cloudflare 的
[`cf_clearance`](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)
属于客户端验证状态；浏览器与桌面请求的 Cookie、请求头或网络路径可能不同。
当前没有对照两端这些条件，尚不能确定具体差异，也不能据此认定网络出口整体被封或
Bridge 导致挑战。此次没有复制 Cookie、调整请求身份或访问用户浏览器会话。
