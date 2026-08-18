# QQ 官方机器人适配器 (dsh-qqbot-community)

[![npm version](https://img.shields.io/npm/v/dsh-qqbot-community)](https://www.npmjs.com/package/dsh-qqbot-community)
[![license](https://img.shields.io/npm/l/dsh-qqbot-community)](./LICENSE)

为 DeepSeek Harness 提供 QQ 官方机器人的接入能力。本项目由 `openclaw-qqbot` 插件功能迁移而来。

> 整体功能未严格测试，部分功能可能不稳定，欢迎反馈问题，或者直接提交 PR。

## 安装

```bash
npm install dsh-qqbot-community
```

> 该包以 npm 形式分发，供宿主消费。如需从源码构建/调试，参见下文「接入指南」。

### 致谢与来源

本插件的核心接入、网关与会话管理逻辑源自 [`openclaw-qqbot`](https://github.com/openclaw/openclaw-qqbot) 项目，遵循原项目的 MIT 许可证。在此向原作者与贡献者致谢。

## 功能特性

### 基础
- **消息收发**：频道 `@机器人`、群聊 `@机器人` 和单聊消息。
- **会话管理**：按频道、群或单聊用户创建或恢复独立的 Agent 会话（cwd 对齐持久化 header，工作区分组，归档自动恢复）。
- **Agent preset 挂载**：每个 QQ 会话在 setup 阶段自动 `agentPresets.mount()` 加入预设（默认 `standard`，用 `agentPreset` 配置可换成 `code` / `minimal` / `cordis` 或任意用户自定义 id，QQ 里还可用 `/new <id>` 按会话即时切换 —— 见斜杠命令表），恢复持久会话时沿用 header 中记录的 preset —— 因此 QQ 里的 agent 与 Web UI 拥有同一套工具（bash / 文件 / 代码运行等）和提示词，仅追加 `qq_send_media` / `qq_api` 等 QQ 专属工具。
- **沙箱支持**：开启后使用 QQ 官方沙箱 OpenAPI 接入点。
- **网关可靠性**：WebSocket 心跳、断线重连退避、**会话 RESUME**（session_id + seq 持久化，重启不重放事件）。
- **@mention 清洗**：`<@!openid>` → `@昵称`，机器人自身提及剔除（群/频道消息友好）。
- **引用消息上下文**：记录每条消息到持久化引用索引（LRU + JSONL，`~/.dsh/storages/qq-refindex.jsonl`）；用户回复某条消息时自动解析（ref index 优先，`msg_elements` 兜底）并以 `[引用消息开始]…[引用消息结束]` 前缀注入模型上下文。
- **图片理解**：入站图片经 DSH attachment 服务持久化为 `ImageBlock`（模型直接可见）；服务不可用或格式不支持（如 bmp）时回退下载到 `<cwd>/.qq-media/` 并注入路径。
- **语音转写（STT）**：优先使用 QQ 自带 ASR（`asr_refer_text`）；配置 `stt`（OpenAI 兼容接口）时下载语音转写；均不可用时注入占位描述。
- **附件落盘**：视频/文件等非图片附件下载到 `<cwd>/.qq-media/`，路径注入文本，供 agent 文件工具读取。
- **富媒体发送**：AI 可通过 `qq_send_media` 工具发送图片/语音/视频/文件（URL / data URL / 本地路径）；>10MB 本地文件自动走分片上传（upload_prepare → presigned PUT 并行 → part_finish → complete）。
- **流式回复（C2C）**：`session/event` 的 `assistant/chunk` → QQ `stream_messages` 替换模式（全量帧、msg_seq 固定、index 递增、节流）；前缀不一致自动合并；失败降级静态消息。
- **出站合并与分段**：同一轮多条文本回复按窗口合并（默认 900ms/6s 上限）；超长回复按段落边界分段（默认 4000 字/段）；剥离 `<think>`/`<system-reminder>` 等内部标签。
- **被动回复限额**：每条入站消息被动回复（带 msg_id）默认上限 4 次、群 5 分钟/C2C 30 分钟窗口，超限自动降级主动消息（ RouteStore 持久化，重启后提醒类主动推送仍可路由）。
- **typing 指示**：C2C 处理期间 60s 输入中状态自动续发（50s 间隔）。
- **访问控制**：`allowFrom`（C2C openid）/ `groupAllowFrom`（群 openid）白名单，`'*'` 通配，留空放行。
- **审批桥（inline keyboard）**：为每个 QQ 会话注册 agent 作用域 `approval/request` answerer —— 审批请求以三按钮消息送达 QQ（✅ 允许一次 / ⭐ 始终允许 / ❌ 拒绝），按钮回调即决策；"始终允许"按 会话×工具 持久化（`qq-always-allow.json`）。
- **ask_user_question 转发（`questions`，默认开启）**：agent 调用 `ask_user_question` 时，问题转发到 QQ 对话（否则只出现在 Web UI，QQ 侧会一直"无响应"）。默认以纯文本呈现编号选项，直接回复编号（如 `1,3`）、选项文字或自由文本（多问题按行回答）；`questionButtons: true` 可为 单问题+单选+选项≤5 附加内联键盘按钮（需开通消息按钮权限，沙箱可能不显示，发送失败自动回退纯文本）；无效回答有引导提示且不进入 agent；超时（`questionTimeoutMs`，默认 300s）/turn 取消/会话结束自动收尾。经 agent 作用域 `tools/execute` 拦截实现，不影响 Web UI 的其它会话；`questions: false` 关闭。
- **QQ API 代理工具**：`qq_api` 工具代理任意 QQ 开放平台 REST 调用（频道/群管理、公告、日程等），自动注入鉴权。
- **斜杠命令**：`/help` `/ping` `/me` `/new [preset]` `/presets` `/approve ask|never|status` `/always clear`（在投递给 agent 之前拦截，映射 DSH 审批策略；完整列表见下节）。
- **定时提醒**：复用 DSH schedule 子系统（web profile 自带 `schedule_create` 等工具）；提醒到期触发同会话 follow-up，回复经出站管线（含主动降级）送达 QQ。
- **HTTP 推送 API（`httpApi`，默认关闭）**：在 dsh web 的 HTTP 端口上暴露认证端点，外部系统可把文本直接推送到指定 QQ 通道（不经模型）；`record: true` 可同时向会话注入一条不唤醒模型的记录，让 agent 知晓推送内容。详见下文「HTTP 推送 API」。

### 明确不迁移（平台强绑定或 DSH 已覆盖）
Webhook transport、热升级（`/bot-upgrade`/update-checker）、`/bot-logs`/`/bot-version`/`/bot-clear-storage`（DSH Web UI 承担）、pairing 配对流、credential-backup、claw_cfg 私有协议、群自主模式（需 QQ 特批 `GROUP_MESSAGE_CREATE`）、群历史缓冲注入（DSH 会话日志已持久化完整上下文）。

## 斜杠命令

在投递给 agent 之前由本插件直接拦截并响应（`slashCommands: false` 时整组关闭）。所有命令都以行首 `/` 触发，参数以空白分隔。

| 命令 | 参数 | 说明 |
|------|------|------|
| `/help` | — | 在 QQ 内列出全部可用斜杠命令。 |
| `/ping` | — | 立即返回 `✅ pong（HH:MM:SS）`，用于延迟/可达性自检。 |
| `/me` | — | 返回当前会话发送者的 `openid`（可选附带昵称），便于排查白名单。 |
| `/new` | 可选 `preset id` | 强制关闭当前 thread 上的流式回复（`stream_messages` DONE 帧）并取消进行中的 agent，再为同一会话目标分配下一个 thread id（`#n1`、`#n2` …）；旧 session 保留，仍可在侧边栏切换。携带 preset id 时（如 `/new code`），新会话改用该 preset 组装（先对照 host 的 preset 列表校验，未知/损坏的 id 直接报错并列出可选项，不推进 thread）；不带参数则使用 `agentPreset` 配置值。覆盖按新 session id 持久化（`qq-threads.json`），重启后恢复同一会话仍用同一 preset。 |
| `/presets` | — | 列出 host 当前提供的全部 agent preset（id、名称、损坏原因），供 `/new <id>` 选择。 |
| `/approve` | `ask` \| `never` \| `status`（缺省 `status`） | `ask`/`never` 切换当前会话的审批策略（仅当 `approval: true` 且当前环境提供了 `approval` 服务时生效）；`status` 列出本会话已"始终允许"的工具名。 |
| `/always` | `clear` | 清空本会话的"始终允许"清单；其它子命令视为未识别并回落到 agent。 |

> 未识别的命令（例如 `/foo`）会被原样转发给 agent，不会被插件吞掉。

实现位于 [`src/slash-commands.ts`](src/slash-commands.ts)，仅依赖注入式的 `SlashDeps`；测试 / 单元化时可直接传入 fake 依赖调用，无需启动 WebSocket。

### 按会话切换 agent preset：`/new <preset>` 与 `/presets`

`agentPreset` 配置是全局默认，调整它需要改 patch 并重启。这两个命令让你直接在 QQ 里为新会话即时指定 preset，无需任何配置变更。

**典型对话**：

```text
你：/presets
机器人：可用 agent preset：
        - standard（标准）
        - code（编码）
        - cordis（Cordis 插件开发）
        - my-agent（我的模式）
        用 /new <id> 以指定 preset 开启新会话

你：/new code
机器人：✅ 已开启新会话（#n3，preset=code）。下次发送的消息将进入 `qq:v2:c2c:ABC123#n3`。旧的对话仍保留，可手动在侧边栏切换。

你：/new              ← 不带参数：同样开新会话，但使用 agentPreset 配置的默认 preset
你：/new foo          ← 未知 id：报错并列出全部可用 id，thread 不推进，当前会话不受影响
```

## 接入指南

本包以 [DSH bundle](https://github.com/deepseek-harness/deepseek-harness/blob/main/docs/user/develop/basic/publish.md) 形式分发 —— `package.json` 声明 `dsh.bundle.patch`，仓库根的 `cordis.patch.yml` 是该 bundle 的默认配置层。用户通过 `dsh plugin add` 一行安装，DSH 自动把它加入 `~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles` 列表，并在下次启动时作为独立一层叠加。

### 1. 安装到 profile

```bash
# 从 npm 安装（正式用户）
dsh plugin --profile web add dsh-qqbot-community

# 从 GitHub / 本地 checkout 安装（开发/调试）
dsh plugin --profile web add github:DLive/dsh-qqbot-community
dsh plugin --profile web add /path/to/dsh-qqbot-community

# 安装后核对：bundle 已被识别为独立一层
dsh --profile web --dump-config | grep -A2 "dsh-qqbot-community"
```

### 2. 在 profile 的 `cordis.patch.yml` 覆盖默认配置

DSH 的层顺序是：每个 bundle 的 patch → profile 的 `cordis.patch.yml` → home 级 `cordis.patch.yml` → `--patch` 覆盖层。后者覆盖前者，所以用户在自己 profile 的 patch 文件里补 QQ 凭证即可，不需要改 bundle。

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在已有内容末尾追加（**不要**覆盖文件里已有的其它 patch）：

```yaml
- id: qqbot-community
  name: dsh-qqbot-community
  config:
    id: '你的 AppID'        # 必须加引号（避免 YAML 数字解析）
    secret: '你的 AppSecret'
    sandbox: true
    provider: 'DeepSeek' # 新建会话默认提供商
    model: 'DeepSeek-V4-Flash' # 新建会话默认模型
    agentPreset: 'standard'    # 新建会话默认 preset id：standard / code / minimal / cordis / 自定义；缺省值 standard。QQ 里可用 /new <id> 按会话覆盖（见斜杠命令表）
    cwd: '/Users/xxxx/workdir'   # QQ 会话 agent 工作区目录（须真实存在）
    # 以下均可省略，以下为默认值
    allowFrom: ['*']           # C2C 白名单；填 openid 数组限定用户
    groupAllowFrom: ['*']      # 群白名单
    markdown: false            # msg_type 2，需开通 markdown 权限
    typing: true               # C2C 输入中指示
    streaming: true            # C2C 流式回复
    streamThrottleMs: 1200     # 流式帧节流
    deliverWindowMs: 900       # 轮内回复合并窗口
    deliverMaxWaitMs: 6000     # 合并最大等待
    textChunkLimit: 4000       # 单条静态回复上限
    replyPassiveLimit: 4       # 每条消息被动回复上限
    mediaDownload: true        # 非图片附件落盘 <cwd>/.qq-media/
    approval: true             # QQ 内联键盘审批
    approvalTimeoutMs: 300000  # 审批等待超时
    slashCommands: true        # /help /ping /me /new /approve /always
    # stt:                     # 可选：语音转写（OpenAI 兼容）
    #   baseUrl: 'https://api.openai.com/v1'
    #   apiKey: 'sk-...'
    #   model: 'whisper-1'
```

> 如果你只想临时调试本仓库代码、不走 npm，也可以在不修改 profile 的前提下用 `--patch` 直接喂这份 patch 给 dsh：
>
> ```bash
> cd /path/to/dsh-qqbot-community
> pnpm install && pnpm run build
> dsh web --patch ./cordis.patch.yml
> ```
>
> 这条路径绕开 `dsh plugin` 的依赖管理，仅适合本地开发。
>
> 🛠️ **开发模式**：clone → build → 以本地 `lib/index.js` 绝对路径挂载到 profile patch 的完整步骤与常见问题，见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

### 3. 启动

```bash
dsh web
```

启动后自动：获取 token → 建立 WS 网关（RESUME 恢复）→ 收到消息按会话创建/恢复 agent → 回复经出站管线送回 QQ。

## HTTP 推送 API

在 `cordis.patch.yml` 中启用 `httpApi` 后，本插件会在 dsh web 的 HTTP 服务上挂载两个 Bearer 认证端点，供外部系统（CI、监控、脚本）直接向 QQ 通道推送文本：

```yaml
- id: qqbot-community
  name: ... # 同上
  config:
    ... # 同上
    httpApi:
      enable: true
      token: '请生成一个足够长的随机串'   # 必填，≥ 8 字符，缺失时插件加载直接报错
      # path: '/external/qq'           # 可选，默认 /external/qq；多机器人实例各用不同前缀
```

### `POST /external/qq/send`

```jsonc
{
  "channel": "c2c:A2C71F...",       // 寻址方式一：简写 c2c:<openid> / group:<openid> / channel:<id>
                                    // 也接受完整会话 id（qq:v2:c2c:XXX#n1，忽略线程后缀）
  // "target": { "kind": "c2c", "userId": "A2C71F..." },  // 寻址方式二：对象形式
  "text": "要推送的文本",             // 必填；超过 textChunkLimit 自动分段
  "msgId": "ROBOT1.0_...",          // 可选：以该入站消息为被动回复锚点（省略则发主动消息）
  "record": true                    // 可选：向该通道当前会话注入一条不唤醒模型的记录
}
```

响应：

```jsonc
// 200
{ "ok": true, "messageIds": ["..."], "chunks": 1, "recorded": false }
// 401 未认证 / 400 参数错误 / 502 QQ 发送失败（附 messageIds 已成功部分）
```

要点：

- **直接推送语义**：文本经与 agent 回复相同的 `QQApi.sendText` 路径送达，**不创建对话轮次、不触发模型**；`record: true` 时才向会话注入 `[HTTP 推送记录]` 上下文（`agent.inject`，不唤醒 driver），用户下次提问时模型可据此回答。目标是从未出现过的新通道时，`record` 会按插件配置为其创建新会话。
- **主动消息频控**：不带 `msgId` 的推送是主动消息，受 QQ 平台主动消息额度限制（C2C 每月限额、群更严）。高频通知场景建议借用 `msgId`（如用户刚与机器人交互后的消息 id）走被动额度。
- **认证是强制的**：dsh web 的请求防线（Host fence）不是认证层，本机任何进程都能访问该端口；`token` 必填且所有请求须携带 `Authorization: Bearer <token>`。若 webserver 绑定 `0.0.0.0`，这是唯一防线。

### `GET /external/qq/channels`

列出所有路由过的通道（供调用方发现 `channel` 寻址值）：

```jsonc
{ "ok": true, "channels": [
  { "kind": "c2c", "id": "A2C71F...", "target": { "kind": "c2c", "userId": "A2C71F..." },
    "currentSessionId": "qq:v2:c2c:A2C71F...#n5", "lastActiveAt": 1786792729138 }
] }
```

### 验证

```bash
curl -X POST http://127.0.0.1:3080/external/qq/send \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"channel":"c2c:A2C71F...","text":"hello from CI","record":true}'
```

开发时可运行 `node scripts/smoke-http-api.mjs`（stub QQApi 的本地端到端冒烟，16 项断言）。

## 注意事项

- **权限**：默认 intents 同时订阅频道 @、群 @、单聊与按钮交互（INTERACTION）。审批按钮需要开通「消息按钮」能力。
- **markdown**：`markdown: true` 需在 QQ 开放平台申请 markdown 模板权限，否则发送失败。
- **审批链路**：QQ answerer 仅在会话审批策略为 `ask` 时收到请求（`never` 直接拒绝）；`/approve never` 关闭审批后所有 ask 确定性拒绝 —— 与 DSH 审批语义一致。
- **流式与 markdown**：`stream_messages` 帧固定 `content_type: markdown`，与 `markdown` 配置独立（QQ 流式接口本身就是 markdown 渲染）。
- **工作目录**：`cwd` 必须是已存在的绝对路径（`workspaceRegistry.create` 会 `fs.realpath` 校验）；已恢复会话保留原 cwd。
- **运行时产物**：`~/.dsh/storages/qq-{routes,gateway-session,always-allow,threads}.json`、`qq-refindex.jsonl`、`<cwd>/.qq-media/`；删除后自动重建（`qq-threads.json` 同时承载 thread 计数与 `/new <preset>` 的会话级覆盖，删除后所有目标回到 thread 0 与配置默认 preset）。

## 故障排查

- **收不到消息**：`debug: true` 查看网关 op 帧；确认 intents 与 QQ 平台消息权限审核状态。
- **回复没到**：查看被动限额日志 —— 超限自动转主动消息，QQ 对主动消息有频控。
- **图片模型看不到**：确认 DSH 挂载 attachment 服务（web profile 默认有）；不支持格式自动回退为路径注入。
- **审批按钮无响应**：确认开通按钮权限；`/approve status` 查看始终允许清单；超时默认 5 分钟自动拒绝。
- **`Error: duplicate loader entry id: qqbot-community`**：合并后的 entry 树里出现了两个同 id 的 row。常见原因有两个：(1) 用户 `cordis.patch.yml` 里写了 `- insert: [{ id: qqbot-community, ... }]`（应该改成 `- id: qqbot-community, config: {...}` 替换形式）；(2) 旧 `file://` 形式的 row 没清掉。执行 `dsh --profile web --dump-config | grep "id: qqbot-community"` 应该只看到一行；多于一行就重复了。
- **QQ 里只有基础对话、bash 等工具全无**：说明 QQ 会话没有挂上 agent preset —— DSH 会打印 `agent "qq:..." was published without joining an agent preset`。本插件默认会调 `agentPresets.mount('standard')`，但要求 host 上有 `dsh-agent-presets` row（web / cli profile 自带，自定义 profile 需手动加载）。要换 preset 时在 patch 里设置 `agentPreset: 'code'`（或自定义 id），或在 QQ 里 `/new code` 即时开一个用该 preset 的新会话（`/presets` 可列出全部可选项）；已有会话恢复时沿用 header 里记录的 preset，重启 `dsh` 或 `/new` 会用新值。
- **`/new <id>` 报"未知的 preset"**：id 必须精确匹配 `/presets` 列出的 id（大小写敏感）。自定义 preset 放在 `${DSH_HOME:-~/.dsh}/.agent-presets/<id>/cordis.yml`，新建后无需重启即可被 `/presets` 发现（名单每次实时读取）。

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。
