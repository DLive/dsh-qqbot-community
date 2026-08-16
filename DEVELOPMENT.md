# 开发模式使用指南

面向需要修改本插件源码并让本机 DSH 直接加载本地构建产物的场景（调试新功能、验证修复、贡献 PR）。与正式安装（`dsh plugin add`，走 npm 包）的区别：

| | 正式安装 | 开发模式 |
|---|---|---|
| 代码来源 | npm / GitHub 发布的包 | 本地 clone 的仓库 |
| `name` 字段 | 包名 `dsh-qqbot-community` | 本地 `lib/index.js` **绝对路径** |
| patch 形式 | 替换形式（`- id: ...`） | **insert 形式**（`- insert: [...]`） |
| 代码更新 | 升级包版本 | 重新 `pnpm build` + 重启 dsh |

> ⚠️ 两套形式**不可混用**：开发模式没有安装过 bundle（没有现成 row 可替换），必须用 insert 新增；如果之前执行过 `dsh plugin add dsh-qqbot-community`（或残留旧 `file://` row），再 insert 会报 `Error: duplicate loader entry id: qqbot-community` —— 先用 `dsh --profile web --dump-config | grep "id: qqbot-community"` 核对，应只保留一个 row。

## 前置要求

- Node.js ≥ 20 与 pnpm（`package.json` 的 `engines` 约束）；
- 本机已能运行 DSH（`dsh` 命令可用，存在 `~/.dsh/profiles/web/`）。

## 1. clone 代码

```bash
git clone https://github.com/DLive/dsh-qqbot-community.git
cd dsh-qqbot-community
```

## 2. 安装依赖

```bash
pnpm install
```

## 3. 构建

```bash
pnpm run build        # tsc 编译 src/ → lib/
```

- 产物是 `lib/index.js`（`package.json` 的 `main`），后续步骤引用的就是这个文件；
- 开发时可以开增量编译：`npx tsc --watch`；
- 忘记 build 时，下一步的 `name` 路径不存在，dsh 启动会直接报加载失败。

## 4. 配置 profile 的 cordis.patch.yml

编辑 `~/.dsh/profiles/web/cordis.patch.yml`（文件不存在则新建），写入（把 `name` 换成你本机的**绝对路径**）：

```yaml
- insert:
    - id: qqbot-community
      name: /Users/yourname/code/dsh-qqbot-community/lib/index.js
      config:
        id: 'your_app_id'          # QQ 开放平台 AppID（必须加引号，避免 YAML 数字解析）
        secret: 'your_app_secret'
        sandbox: true               # 沙箱环境
        provider: 'DeepSeek'        # 新建会话默认提供商
        model: 'DeepSeek-V4-Flash'  # 新建会话默认模型
        debug: true                 # 开发期建议开启：网关 op 帧、装配细节等日志
        cwd: '/Users/yourname/workdir'  # QQ 会话 agent 工作目录（必须真实存在）
```

- 以上是开发所需的**最小配置**；完整配置项（白名单、流式、审批、STT、`agentPreset` 等）见 [README.md](./README.md)「接入指南」第 2 步的字段表；
- patch 分层为 bundle → profile（本文件）→ home（`~/.dsh/cordis.patch.yml`）→ `--patch`，写在本文件的配置优先于 bundle 默认值；
- 凭证写在这里（`~/.dsh` 下、仓库之外），**不要**把真实 AppID/secret 提交进仓库。

## 5. 重启 DSH

```bash
dsh web
```

启动后自动：加载本地 `lib/index.js` → 获取 token → 建立 WS 网关 → QQ 消息进入本地代码的处理管线。

**验证**：

```bash
dsh --profile web --dump-config | grep -A3 qqbot-community   # row 已合并、name 指向本地路径
```

日志中出现 `QQ gateway ready (appid=...)` 即网关就绪；在 QQ 里发 `/ping` 收到 `✅ pong` 即链路通；`/presets` 能列出 preset 名单说明 agentPresets 服务也已接上。

## 开发循环

```text
改 src/*.ts → pnpm run build → 重启 dsh（Ctrl-C 后重新 dsh web）→ QQ 里验证
```

- host 插件**没有热更新**：`lib/` 只在 dsh 启动时加载一次，改代码后必须 rebuild + 重启才生效（"改了没反应"多半是漏了这一步）；
- `debug: true` 时本插件输出：网关 op 帧序号、每条入站消息的路由（`QQ inbound: ...`）、agent 装配（`QQ setupAgent: ... joined preset "..."`）、`/new` 的 thread 推进等，配合排障足够定位大多数问题；
- 新会话功能（`/new <preset>`、`/presets`）在开发模式下与正式安装完全一致，可直接用于验证 preset 相关改动。

## 开发模式常见问题

- **`Error: duplicate loader entry id: qqbot-community`**：合并后的 entry 树里有两个同 id 的 row。开发模式下通常是 (1) 之前 `dsh plugin add` 过该 bundle（其 patch 层已贡献一个 row），或 (2) profile patch 里残留旧 `file://` row。清到只剩一个（见上文 ⚠️）。
- **启动报找不到模块/文件**：`name` 的绝对路径写错，或忘了 `pnpm run build`（`lib/index.js` 不存在）。
- **改了代码行为没变**：没有重新 build，或没有重启 dsh。
- **`QQ setupAgent: agentPresets service is absent`**：当前 profile 的 host 组合没加载 `dsh-agent-presets` row（web / cli profile 自带；自定义 profile 需手动加），QQ 会话将只有 `qq_send_media` / `qq_api` 工具。
- **运行时产物**：`~/.dsh/storages/qq-*.json`、`qq-refindex.jsonl`、`<cwd>/.qq-media/`；排查状态污染时可删除（自动重建，thread 计数与 `/new <preset>` 覆盖会一并重置）。

## 另一条临时路径：`--patch`

不想改 profile 时，也可以把第 4 步的 patch 内容存成任意文件（如 `./dev.patch.yml`，`name` 仍写绝对路径），一次性喂给 dsh：

```bash
dsh web --patch ./dev.patch.yml
```

注意这会作为最高覆盖层叠加在现有层之上——如果 profile 里已经有 qqbot-community 的 row，会触发上面的 duplicate 错误，二者取其一。
