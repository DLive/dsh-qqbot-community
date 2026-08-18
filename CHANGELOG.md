# 更新日志（Changelog）

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。


## [未发布]


### 修复

- **C2C 流式帧严格串行**：此前 `onStreamDelta` 以 fire-and-forget 发送替换帧，且节流时间戳 `lastSentAt` 在请求完成后才更新，导致一帧在途期间到达的每个 delta 都并发再发一帧；QQ 服务端拒绝并发替换帧（`40034021 其它流式消息发送中`、`40054005 消息被去重`），插件随即把流标记失败并整轮降级静态发送。现在帧经单一 drain 循环串行发送，最新 delta 覆盖 pending，最后一帧始终携带最新文本。
- **DONE 帧等待在途帧并重试**：turn 结束 / 关闭流时先等待在途帧结束后再发 DONE（`input_state=10`）帧，发送失败按 400ms/800ms 退避重试 3 次，避免丢失 DONE 使 QQ 侧流保持"发送中"、下一条流被以 `40034021` 拒绝。
- **关闭时立即停止 drain 循环**：新增 `closing` 标志，`finishStream` 第一时间置位并清空 pending——若流在节流等待中结束（如最终文本与已流式前缀不一致走"分歧"分支），睡眠中的 drain 醒来后不再补发残留帧；否则该帧会打向已被静态消息消费的锚点，QQ 返回 `40007 已经提交的消息内容不可修改`。
- **`msg_seq` 改为进程内单调递增**：原 `Date.now() ^ random` 生成器可能为两个并发流产生相同 seq（触发 `40054005` 去重拒绝）；现使用共享计数器在 0..65535 范围内循环。
- **`onAssistantMessage` 前缀判断参数顺序修正**：`prefixMatches(text, stream.lastAccepted)` 实参顺序与函数语义（incoming 以 accepted 开头）相反，导致正常结束的流误走"分歧"分支、DONE 帧不携带最终文本；修正为 `prefixMatches(stream.lastAccepted, text)`。

### 验证

- 新增 `scripts/verify-stream-fix.mjs`：场景一模拟 30 个快速 delta 与慢 QQ API（断言帧严格串行、index 连续、GENERATING/DONE 状态齐全、DONE 携带全文）；场景二模拟 API 拒绝（断言失败后不再重试流式、静态兜底消息发出）；场景三模拟流在节流等待中分歧结束（断言 drain 不再补发残留帧、DONE 与静态兜底正常）。运行：`node scripts/verify-stream-fix.mjs`。

### 新增

- **`ask_user_question` 弹窗转发到 QQ（`questions` 配置，默认开启）**：QQ 会话中 agent 调用 `ask_user_question` 时，问题不再只落在 Web UI（此前 QQ 侧表现为"无响应"），而是渲染到 QQ 对话并可直接在 QQ 上回答：
  - 默认以**纯文本**呈现（编号选项），回复编号（如 `1`）、选项文字或自由文本即作答（多问题按行回答）；
  - `questionButtons: true` 可为 单问题+单选+选项≤5 附加 QQ 内联键盘按钮（需开通消息按钮权限，沙箱环境可能不显示，键盘发送失败自动回退纯文本）；
  - 无效回答会收到引导提示且不进入 agent，问题继续等待；超时（`questionTimeoutMs`，默认 300s）、turn 取消、会话结束都会自动收尾；
  - 问题呈现前自动冲刷出站合并缓冲，模型的引导语先于问题送达，顺序自然；
  - 答案解析支持编号（`1`、`1,3`）、字母前缀（`A`/`a`/`A.` 匹配 `A. xxx` 式选项）、完整选项文字与自由文本；
  - 通过作用域限定的 `tools/execute` 拦截实现，不影响 Web UI 的其它会话；`questions: false` 可关闭回退到原行为。

## [1.0.5] - 2026-08-17

### 新增

- **HTTP 推送 API（`httpApi` 配置组，默认关闭）**：在 dsh web 的 HTTP 服务（`webServer` 服务）上挂载外部推送端点，外部系统可将文本直接推送到指定 QQ 对话通道，不经模型处理。
  - `POST <path>/send`：`channel` 简写（`c2c:<openid>` / `group:<openid>` / `channel:<id>` / 完整会话 id）或 `target` 对象寻址；文本按 `textChunkLimit` 自动分段；可选 `msgId`（以该消息为被动回复锚点）、`record: true`（同时向当前会话注入一条不唤醒模型的 `[HTTP 推送记录]` 上下文，agent 后续可据此回答用户询问）；
  - `GET <path>/channels`：列出所有已知通道（kind、id、当前会话 id、最近活跃时间，按活跃度排序）；
  - Bearer token 认证强制（`enable: true` 时 `token` 必填且 ≥ 8 字符，缺失/过短在加载时抛错）；QQ 发送失败返回 502 并附已成功的部分回执；
  - 仅在宿主提供 `webServer` 服务时可用（如 `dsh web`）；多机器人实例通过不同的 `httpApi.path` 前缀隔离。
- 新增 `scripts/smoke-http-api.mjs` 开发冒烟脚本（stub QQApi + 真实 node:http 服务器，覆盖认证/校验/分段/record/失败映射 16 项断言）。


## [1.0.4] - 2026-08-16

### 新增

- **`/new [preset]` 携带参数**：开启新会话时可指定 agent preset id（如 `/new code`），新会话以该 preset 组装（工具、提示词、技能随之切换）。
  - preset id 先对照 host `agentPresets.list()` 的实时名单校验（含用户在 `${DSH_HOME:-~/.dsh}/.agent-presets/` 下自建的 preset）；
  - 未知 id → 报错并列出全部可用 id，**不推进 thread**，当前会话不受影响；
  - 损坏 preset（`broken`）→ 报错并附原因；
  - host 未加载 agent-presets 服务 → 明确提示不支持；
  - 不带参数行为不变：使用 `agentPreset` 配置值。
- **`/presets` 命令**：列出 host 当前提供的全部 agent preset（id、名称、损坏原因），供 `/new <id>` 选择。
- `/help` 输出与 README 文档同步更新。

### 变更

- preset 解析优先级调整为：`/new <id>` 会话覆盖 → `agentPreset` 配置 → host 默认（`standard`）。此前仅有后两级。

### 兼容性

- `qq-threads.json` 旧版纯计数器格式（`Record<targetKey, number>`）读取时自动迁移，下次写入升级为新格式，无需手工处理。
- `AgentPresetsLike` 结构类型新增可选的 `list()` 消费；不改变既有 `mount()` / `resolve()` 调用。

### 文档

- 新增 [DEVELOPMENT.md](./DEVELOPMENT.md)：开发模式使用指南（clone → `pnpm install` → `pnpm build` → profile patch 以 insert 形式挂载本地 `lib/index.js` → 重启 dsh），含与正式安装的差异对比、开发循环、验证方法与常见问题。

## [1.0.3] - 2026-08-16

### 新增

- 每个 QQ 会话在 setup 阶段挂载 agent preset（`agentPresets.mount()`，默认 `standard`，`agentPreset` 配置可换），QQ 内 agent 与 Web UI 拥有同一套工具与提示词，另加 `qq_send_media` / `qq_api` 等 QQ 专属工具。
- 调试日志增强（`debug: true` 时输出更多装配细节）。

## [1.0.2] - 2026-08-16

### 修复

- 修复 DSH bundle 安装与描述（`package.json` 元数据、patch 声明）。

### 文档

- README 补充安装与配置说明。

## [1.0.0] - 2026-08-16

### 初始发布

- 由 [`openclaw-qqbot`](https://github.com/openclaw/openclaw-qqbot) 迁移而来的 QQ 官方机器人适配器：
  - WebSocket 网关（心跳、断线重连退避、会话 RESUME）；
  - 按频道 / 群 / 单聊的独立 Agent 会话管理；
  - 斜杠命令 `/help` `/ping` `/me` `/new` `/approve` `/always`；
  - 审批桥（QQ 内联键盘三按钮，"始终允许"按会话×工具持久化）；
  - 图片理解、语音转写（STT）、附件落盘、富媒体发送（含 >10MB 分片上传）；
  - C2C 流式回复、出站合并分段、被动限额降级、typing 指示；
  - `qq_api` 代理工具、访问控制白名单。

[1.0.4]: https://github.com/DLive/dsh-qqbot-community/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/DLive/dsh-qqbot-community/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/DLive/dsh-qqbot-community/compare/v1.0.0...v1.0.2
[1.0.0]: https://github.com/DLive/dsh-qqbot-community/releases/tag/v1.0.0
