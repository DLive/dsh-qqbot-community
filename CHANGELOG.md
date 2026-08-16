# 更新日志（Changelog）

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
