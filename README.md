# QQ 官方机器人适配器 (dsh-qqbot-community)

为 DeepSeek Harness 提供 QQ 官方机器人的接入能力。本项目由 `openclaw-qqbot` 插件功能迁移而来。

> 整体功能未严格测试，部分功能可能不稳定，欢迎反馈问题，或者直接提交 PR。

## 功能特性

### 基础
- **消息收发**：频道 `@机器人`、群聊 `@机器人` 和单聊消息。
- **会话管理**：按频道、群或单聊用户创建或恢复独立的 Agent 会话（cwd 对齐持久化 header，工作区分组，归档自动恢复）。
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
- **QQ API 代理工具**：`qq_api` 工具代理任意 QQ 开放平台 REST 调用（频道/群管理、公告、日程等），自动注入鉴权。
- **斜杠命令**：`/help` `/ping` `/me` `/approve ask|never|status` `/always clear`（在投递给 agent 之前拦截，映射 DSH 审批策略）。
- **定时提醒**：复用 DSH schedule 子系统（web profile 自带 `schedule_create` 等工具）；提醒到期触发同会话 follow-up，回复经出站管线（含主动降级）送达 QQ。

### 明确不迁移（平台强绑定或 DSH 已覆盖）
Webhook transport、热升级（`/bot-upgrade`/update-checker）、`/bot-logs`/`/bot-version`/`/bot-clear-storage`（DSH Web UI 承担）、pairing 配对流、credential-backup、claw_cfg 私有协议、群自主模式（需 QQ 特批 `GROUP_MESSAGE_CREATE`）、群历史缓冲注入（DSH 会话日志已持久化完整上下文）。

## 项目结构

```
src/
  index.ts    组合根：Config、生命周期、DSH 记账（unarchive/workspace attach）、事件接线
  types.ts    共享类型 + DSH 宿主服务结构声明（file:// 加载无法 import DSH 包）
  qqapi.ts    QQ OpenAPI 客户端：token/文本/键盘/typing/媒体(直传+分片)/流式帧/交互 ack/原始代理
  gateway.ts  WebSocket 网关：identify/心跳/RESUME/重连退避/事件分发
  refindex.ts 引用索引：LRU + JSONL append + compact
  store.ts    RouteStore（会话→路由/被动计数）+ AlwaysAllowStore，原子写
  inbound.ts  入站管线：去重→白名单→@清洗→引用→附件(图片/语音/文件)→命令→typing→agent
  outbound.ts 出站管线：chunk 流式/防抖合并/分段/typing 生命周期/审批 answerer
  tools.ts    agent 作用域工具：qq_send_media、qq_api
```

## 接入指南

### 1. 安装依赖与构建

```bash
pnpm install && pnpm run build
```

> 使用 `npm install`（而非 pnpm）：本插件经 `file://` 独立加载，需自带 `node_modules`。

### 2. 配置（~/.dsh/profiles/web/cordis.patch.yml）

```yaml
- insert:
    - id: qqbot-community
      name: /xxxxx/dsh-qqbot-community/lib/index.js #插件路径
      config:
        id: '你的 AppID'        # 必须加引号（避免 YAML 数字解析）
        secret: '你的 AppSecret'
        sandbox: true
        provider: 'deepseek'
        model: 'deepseek-chat'
        cwd: '/Users/xxxx/your-project'   # QQ 会话 agent 工作目录（须真实存在）
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
        slashCommands: true        # /help /ping /me /approve /always
        # stt:                     # 可选：语音转写（OpenAI 兼容）
        #   baseUrl: 'https://api.openai.com/v1'
        #   apiKey: 'sk-...'
        #   model: 'whisper-1'
```

### 3. 启动

```bash
dsh web
```

启动后自动：获取 token → 建立 WS 网关（RESUME 恢复）→ 收到消息按会话创建/恢复 agent → 回复经出站管线送回 QQ。

## 注意事项

- **权限**：默认 intents 同时订阅频道 @、群 @、单聊与按钮交互（INTERACTION）。审批按钮需要开通「消息按钮」能力。
- **markdown**：`markdown: true` 需在 QQ 开放平台申请 markdown 模板权限，否则发送失败。
- **审批链路**：QQ answerer 仅在会话审批策略为 `ask` 时收到请求（`never` 直接拒绝）；`/approve never` 关闭审批后所有 ask 确定性拒绝 —— 与 DSH 审批语义一致。
- **流式与 markdown**：`stream_messages` 帧固定 `content_type: markdown`，与 `markdown` 配置独立（QQ 流式接口本身就是 markdown 渲染）。
- **工作目录**：`cwd` 必须是已存在的绝对路径（`workspaceRegistry.create` 会 `fs.realpath` 校验）；已恢复会话保留原 cwd。
- **运行时产物**：`~/.dsh/storages/qq-{routes,gateway-session,always-allow}.json`、`qq-refindex.jsonl`、`<cwd>/.qq-media/`；删除后自动重建。

## 故障排查

- **收不到消息**：`debug: true` 查看网关 op 帧；确认 intents 与 QQ 平台消息权限审核状态。
- **回复没到**：查看被动限额日志 —— 超限自动转主动消息，QQ 对主动消息有频控。
- **图片模型看不到**：确认 DSH 挂载 attachment 服务（web profile 默认有）；不支持格式自动回退为路径注入。
- **审批按钮无响应**：确认开通按钮权限；`/approve status` 查看始终允许清单；超时默认 5 分钟自动拒绝。
