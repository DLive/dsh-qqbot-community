/**
 * Slash commands answered directly by the adapter (never reach the agent):
 *   /help /ping(/bot-ping) /me /new(/reset/clear) [preset] /presets /model
 *   /approve /always /stop /compact /status
 *
 * Returns `true` if the command was handled (so the inbound pipeline skips
 * agent delivery), `false` to fall through. The factory pattern lets us
 * inject every collaborator the commands need without the composition root
 * having to know about them.
 */
import type {
  AgentLike,
  AgentRegistryService,
  AgentPresetRowLike,
  AgentPresetsLike,
  ApprovalServiceLike,
  CompactionService,
  Config,
  IncomingMessage,
  LlmCatalogServiceLike,
  ReplyTarget,
  SessionPersistenceService,
} from './types.js'
import type { LogSink } from './qqapi.js'
import type { AlwaysAllowStore } from './store.js'
import { ThreadStore, targetKey } from './threadstore.js'
import { baseSessionId, effectiveSessionId, resolveCurrentSessionId, SESSION_PREFIX } from './inbound.js'
import type { OutboundPipeline } from './outbound.js'

export interface SlashDeps {
  readonly log: LogSink
  readonly alwaysAllow: AlwaysAllowStore
  readonly threads: ThreadStore
  readonly agents: AgentRegistryService
  readonly approval: ApprovalServiceLike | undefined
  readonly outbound: OutboundPipeline
  /** Plugin config (used by `/model` to echo the config default). */
  readonly config: Config
  /** Present when the host runs the agent-presets service; enables /new <preset> and /presets. */
  readonly agentPresets: AgentPresetsLike | undefined
  /** Present when the host runs the compaction service; enables /compact. */
  readonly compaction: CompactionService | undefined
  /** Present when the host runs the session persistence service; enables /status. */
  readonly sessionPersistence: SessionPersistenceService | undefined
  /** Present when the host runs the llm service; lets /model list the provider catalog. */
  readonly llm: LlmCatalogServiceLike | undefined
}

/** Built handler compatible with `InboundPipeline.InboundDeps.onSlashCommand`. */
export type SlashHandler = (
  sessionId: string,
  message: IncomingMessage,
  text: string,
  reply: (text: string) => Promise<void>,
) => Promise<boolean>

export function createSlashHandler(deps: SlashDeps): SlashHandler {
  const { log, alwaysAllow, threads, agents, approval, outbound, agentPresets, compaction, sessionPersistence, config, llm } = deps
  /** List presets through the host service; `undefined` when unavailable/failed. */
  const listPresets = async (): Promise<readonly AgentPresetRowLike[] | undefined> => {
    if (agentPresets === undefined) return undefined
    try {
      return await agentPresets.list()
    } catch (error) {
      log.warn('QQ slash: listing agent presets failed: %o', error)
      return undefined
    }
  }
  /**
   * Permission gate for `/sessions` and `/switch` (config.switchAllowFrom):
   * omitted/empty or '*' allows everyone, 'disabled' denies everyone, any
   * other list is an exact sender-openid allowlist. Gating both commands
   * keeps session ids (which embed openids) and thread switching private
   * to the configured operators — in a group a switch affects every member
   * sharing the conversation target, so it is not a per-member decision.
   */
  const switchAllowed = (senderId: string): boolean => {
    const allow = config.switchAllowFrom
    if (allow === undefined || allow.length === 0) return true
    if (allow.includes('*')) return true
    if (allow.includes('disabled')) return false
    return allow.includes(senderId)
  }
  /**
   * Sessions persisted for the current conversation target, newest first.
   * `undefined` when the host persistence service cannot list; each entry
   * carries the resolved thread number (0 = bare base session id).
   */
  const listTargetSessions = async (target: ReplyTarget): Promise<readonly { id: string; thread: number; createdAt: number; eventCount?: number; preset?: string }[] | undefined> => {
    if (sessionPersistence?.list === undefined) return undefined
    try {
      const base = baseSessionId(target)
      const prefix = `${base}#n`
      const snapshots = await sessionPersistence.list()
      const own = snapshots.filter(snap => snap.header.id === base || snap.header.id.startsWith(prefix))
      return own
        .map(snap => {
          const id = snap.header.id
          const suffix = id === base ? '' : id.slice(prefix.length)
          const thread = suffix.match(/^\d+$/) !== null ? Number(suffix) : -1
          return { id, thread, createdAt: snap.header.createdAt, eventCount: snap.eventCount, preset: snap.header.agentPreset }
        })
        .filter(entry => entry.thread >= 0)
        .sort((a, b) => b.thread - a.thread)
    } catch (error) {
      log.warn('QQ /sessions: listing persisted sessions failed: %o', error)
      return undefined
    }
  }
  /**
   * `/sessions all` remembers its numbered rows per target for this long so
   * `/switch pick <k>` can reference them without repeating full session ids.
   */
  const ALL_LISTING_TTL_MS = 5 * 60 * 1000
  const allListings = new Map<string, { ids: string[]; expires: number }>()
  /**
   * Non-QQ persisted sessions (web UI / subagents' parents / any adapter other
   * than this one), newest first, capped for one listing. Other QQ targets'
   * conversations are deliberately excluded — their ids embed other users'
   * openids and their contexts belong to those targets.
   */
  const listForeignSessions = async (): Promise<readonly { id: string; createdAt: number; eventCount?: number; preset?: string; cwd?: string }[] | undefined> => {
    if (sessionPersistence?.list === undefined) return undefined
    try {
      const snapshots = await sessionPersistence.list()
      return snapshots
        .map(snap => ({ id: snap.header.id, createdAt: snap.header.createdAt, eventCount: snap.eventCount, preset: snap.header.agentPreset, cwd: snap.header.cwd }))
        .filter(entry => !entry.id.startsWith(SESSION_PREFIX))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
    } catch (error) {
      log.warn('QQ /sessions all: listing foreign sessions failed: %o', error)
      return undefined
    }
  }
  /** Verify a session id is actually persisted before pinning a takeover. */
  const sessionExists = async (sessionId: string): Promise<boolean> => {
    if (sessionPersistence === undefined) return true // cannot verify — caller warns
    try {
      const snapshots = await sessionPersistence.list?.()
      if (snapshots === undefined) return true
      return snapshots.some(snap => snap.header.id === sessionId)
    } catch {
      return true // verification unavailable — do not block the operator
    }
  }
  /**
   * Best-effort display title for one persisted session: the latest
   * `session/title` log event when present (web sessions get LLM/user
   * titles), else an excerpt of the first user message (QQ sessions, which
   * the web title pipeline never titles). Capped to one short line.
   */
  const sessionTitle = async (sessionId: string): Promise<string | undefined> => {
    if (sessionPersistence === undefined) return undefined
    try {
      const inspected = await sessionPersistence.inspect(sessionId)
      const events = Array.isArray(inspected.events) ? inspected.events : []
      let titled: string | undefined
      let excerpt: string | undefined
      for (const event of events) {
        const entry = event as { type?: string; data?: { title?: unknown; content?: unknown } }
        if (entry.type === 'session/title') {
          const title = entry.data?.title
          if (typeof title === 'string' && title.trim().length > 0) titled = title.trim()
        }
        if (excerpt === undefined && entry.type === 'user/message') {
          const content = entry.data?.content
          if (typeof content === 'string' && content.trim().length > 0) {
            excerpt = content
          } else if (Array.isArray(content)) {
            const text = content
              .map(block => (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
              .join('')
              .trim()
            if (text.length > 0) excerpt = text
          }
        }
      }
      const raw = titled ?? excerpt
      if (raw === undefined) return undefined
      const oneLine = raw.replace(/\s+/g, ' ').trim()
      return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine
    } catch {
      return undefined // not persisted yet or inspection failed — no title line
    }
  }
  return async (sessionId, message, text, reply) => {
    if (!text.startsWith('/')) return false
    const [command, ...rest] = text.slice(1).split(/\s+/)
    switch (command) {
      case 'help':
        await reply([
          '/help — 显示可用命令',
          '/ping（别名 /bot-ping）— 检测 QQ→插件网络传输与插件处理延迟',
          '/me — 显示你的 openid',
          '/new [preset]（别名 /reset /clear）— 开启新会话（可选 preset id，见 /presets）',
          '/presets — 列出可用的 agent preset',
          '/sessions — 列出本会话最近 3 天的历史会话；/sessions all 查看可接管的非 QQ 会话（受 switchAllowFrom 权限控制）',
          '/switch <n|#nN|main|pick 序号|id 会话id> — 切换到指定会话或接管外部会话（受 switchAllowFrom 权限控制）',
          '/model [<provider>[/<model>]|reset] — 切换当前线程的 AI 模型（已有会话时自动开新会话）',
          '/compact — 压缩会话历史（摘要替换旧记录，保留上下文）',
          '/stop — 中止当前正在生成的回复',
          '/status — 查看当前会话状态',
          '/approve ask|never|status — 审批策略',
          '/always clear — 清除"始终允许"清单',
        ].join('\n'))
        return true
      case 'bot-ping':
      case 'ping': {
        const now = Date.now()
        const eventTime = message.timestamp.length > 0 ? new Date(message.timestamp).getTime() : Number.NaN
        if (!Number.isFinite(eventTime)) {
          await reply('✅ pong!')
          return true
        }
        const receivedAt = message.receivedAt ?? now
        await reply([
          '✅ pong！',
          `⏱ 延迟: ${Math.max(0, now - eventTime)}ms`,
          `  ├ 网络传输: ${Math.max(0, receivedAt - eventTime)}ms`,
          `  └ 插件处理: ${Math.max(0, now - receivedAt)}ms`,
        ].join('\n'))
        return true
      }
      case 'me':
        await reply(`🆔 你的 openid: \`${message.senderId}\`${message.senderName !== undefined ? `（${message.senderName}）` : ''}`)
        return true
      case 'presets': {
        const presets = await listPresets()
        if (presets === undefined) {
          await reply(agentPresets === undefined
            ? '⚠️ 当前环境不支持 preset 查询（host 未加载 agent-presets 服务）'
            : '⚠️ 读取 preset 列表失败，请稍后再试')
          return true
        }
        await reply(presets.length === 0
          ? '当前没有可用的 agent preset（检查 host 的 agent-presets 配置）'
          : [
            '可用 agent preset：',
            ...presets.map(preset => `- ${preset.id}${preset.name !== undefined ? `（${preset.name}）` : ''}${preset.broken !== undefined ? ` ⚠️ 不可用：${preset.broken}` : ''}`),
            '用 /new <id> 以指定 preset 开启新会话',
          ].join('\n'))
        return true
      }
      case 'sessions':
      case 'threads': {
        if (!switchAllowed(message.senderId)) {
          log.warn('QQ /sessions: denied for sender=%s by switchAllowFrom', message.senderId)
          await reply('⚠️ 你没有查看会话列表的权限（switchAllowFrom 未授权）')
          return true
        }
        if (sessionPersistence?.list === undefined) {
          await reply('⚠️ 当前环境不支持会话列表查询（host 未提供 sessionPersistence.list）')
          return true
        }
        const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000
        const key = targetKey(message.reply)
        // `/sessions all`: every NON-QQ persisted session from the last 3 days
        // (web UI, other adapters' parents), addressable via /switch pick <k>.
        if (rest[0] === 'all') {
          const foreign = await listForeignSessions()
          if (foreign === undefined) {
            await reply('⚠️ 读取会话列表失败，请稍后再试')
            return true
          }
          const recent = foreign.filter(entry => entry.createdAt >= cutoff)
          if (recent.length === 0) {
            await reply('最近 3 天没有其它（非 QQ）持久化会话')
            return true
          }
          allListings.set(key, { ids: recent.map(entry => entry.id), expires: Date.now() + ALL_LISTING_TTL_MS })
          const pinnedNow = threads.pinnedSession(key)
          const lines: string[] = [`🗂 最近 3 天的其它会话（非 QQ，共 ${recent.length} 个）：`]
          for (const [index, entry] of recent.entries()) {
            const when = new Date(entry.createdAt).toLocaleString()
            const title = await sessionTitle(entry.id)
            lines.push([
              `- [${index}]${entry.id === pinnedNow ? ' ← 当前接管' : ''}`,
              title !== undefined ? `“${title}”` : '',
              `· 创建于 ${when}`,
              entry.eventCount !== undefined ? `· ${entry.eventCount} 条事件` : '',
              entry.preset !== undefined && entry.preset.length > 0 ? `· preset=${entry.preset}` : '',
              entry.cwd !== undefined && entry.cwd.length > 0 ? `· cwd=${entry.cwd}` : '',
            ].filter(part => part.length > 0).join(' '))
          }
          lines.push(`用 /switch pick <序号> 接管所选会话（列表 ${ALL_LISTING_TTL_MS / 60000} 分钟内有效）；/switch id <完整会话id> 亦可直选`)
          await reply(lines.join('\n'))
          return true
        }
        const all = await listTargetSessions(message.reply)
        if (all === undefined) {
          await reply('⚠️ 读取会话列表失败，请稍后再试')
          return true
        }
        const recent = all.filter(entry => entry.createdAt >= cutoff)
        if (recent.length === 0) {
          await reply('本会话目标最近 3 天没有持久化的会话（用 /new 开启新会话，或 /sessions all 查看非 QQ 会话）')
          return true
        }
        const currentThread = threads.current(key)
        const pinned = threads.pinnedSession(key)
        const lines: string[] = [`📋 本会话目标最近 3 天的会话（共 ${recent.length} 个）：`]
        if (pinned !== undefined) {
          lines.push(`⚠️ 当前处于接管模式：\`${pinned}\`（/switch main 或任意 /switch <编号> 可回到本目标线程）`)
        }
        for (const entry of recent) {
          const label = entry.thread === 0 ? '#0（主会话）' : `#n${entry.thread}`
          const when = new Date(entry.createdAt).toLocaleString()
          const title = await sessionTitle(entry.id)
          lines.push([
            `- ${label}${pinned === undefined && entry.thread === currentThread ? ' ← 当前' : ''}`,
            title !== undefined ? `“${title}”` : '',
            `· 创建于 ${when}`,
            entry.eventCount !== undefined ? `· ${entry.eventCount} 条事件` : '',
            entry.preset !== undefined && entry.preset.length > 0 ? `· preset=${entry.preset}` : '',
          ].filter(part => part.length > 0).join(' '))
        }
        lines.push('用 /switch <编号> 切换（如 /switch 2、/switch n2、/switch main 回主会话）；/sessions all 查看可接管的非 QQ 会话')
        await reply(lines.join('\n'))
        return true
      }
      case 'switch':
      case 'sw': {
        if (!switchAllowed(message.senderId)) {
          log.warn('QQ /switch: denied for sender=%s by switchAllowFrom', message.senderId)
          await reply('⚠️ 你没有切换会话的权限（switchAllowFrom 未授权）')
          return true
        }
        const arg = rest[0]
        if (arg === undefined || arg.length === 0) {
          await reply([
            '用法：/switch <n|#nN|main> — 切回本目标的线程（见 /sessions）',
            '      /switch pick <序号> — 接管 /sessions all 列出的非 QQ 会话',
            '      /switch id <完整会话id> — 直接接管指定持久化会话',
          ].join('\n'))
          return true
        }
        const key = targetKey(message.reply)
        const currentThread = threads.current(key)
        // Takeover forms first: `/switch pick <k>` resolves the remembered
        // `/sessions all` listing; `/switch id <sessionId>` pins an exact id.
        // Both route the NEXT inbound message into an arbitrary (typically
        // web-created) persisted session, so both stay behind switchAllowFrom.
        if (arg === 'pick' || arg === 'id') {
          let targetId: string | undefined
          if (arg === 'id') {
            const raw = rest[1]
            if (raw === undefined || raw.length === 0) {
              await reply('⚠️ 用法：/switch id <完整会话id>（id 见 /sessions all）')
              return true
            }
            targetId = raw
          } else {
            const index = Number(rest[1])
            const listing = allListings.get(key)
            if (rest[1] === undefined || !Number.isInteger(index) || index < 1) {
              await reply('⚠️ 用法：/switch pick <序号>（序号见 /sessions all）')
              return true
            }
            if (listing === undefined || Date.now() > listing.expires) {
              await reply('⚠️ 列表已过期或不存在，请先执行 /sessions all')
              return true
            }
            targetId = listing.ids[index - 1]
            if (targetId === undefined) {
              await reply(`⚠️ 序号超范围（共 ${listing.ids.length} 项），请重新执行 /sessions all`)
              return true
            }
          }
          if (targetId.startsWith(SESSION_PREFIX)) {
            await reply('⚠️ 不能接管其它 QQ 会话目标的会话（只支持本目标线程与非 QQ 会话）')
            return true
          }
          if (!(await sessionExists(targetId))) {
            await reply(`⚠️ 会话 \`${targetId}\` 不存在或未持久化（用 /sessions all 查看可用清单）`)
            return true
          }
          // Cancel the outgoing session's agent + stream exactly like the
          // thread switch below, then pin the takeover.
          const outgoingId = resolveCurrentSessionId(message.reply, threads)
          const oldAgent: AgentLike | undefined = agents.get(outgoingId)
          await outbound.closeStream(outgoingId).catch(() => undefined)
          try {
            oldAgent?.cancel({ kind: 'user' })
          } catch (error) {
            log.warn('failed to cancel old QQ agent on /switch %s: %o', arg, error)
          }
          threads.pin(key, targetId)
          log.info('QQ /switch %s: target=%s fromSession=%s pinnedSession=%s', arg, key, outgoingId, targetId)
          await reply([
            `✅ 已接管会话 \`${targetId}\`。下次发送的消息将进入该会话的历史上下文（沿用其 cwd 与 preset）。`,
            '其它 QQ 会话方（如 Web UI）若同时使用该会话会共享上下文；/switch main 或 /switch <编号> 可回到本目标线程。',
          ].join('\n'))
          return true
        }
        // Accept "2", "n2", "#n2", "#2" and the aliases main/base for thread 0.
        const normalized = arg === 'main' || arg === 'base' ? '0' : arg.replace(/^#/, '')
        const match = normalized.match(/^(?:n)?(\d+)$/i)
        if (match === null) {
          await reply(`⚠️ 无法识别的参数 "${arg}"（用法：/switch <n|#nN|main|pick <序号>|id <会话id>，见 /sessions）`)
          return true
        }
        const target = Number(match[1])
        if (target > currentThread) {
          await reply(`⚠️ 会话 #n${target} 不存在（当前最高为 ${currentThread === 0 ? '#0（主会话）' : `#n${currentThread}`}）。用 /new 开启新会话，或 /sessions 查看列表。`)
          return true
        }
        // Same safety net as /new: cancel any agent still running on the
        // outgoing session (thread OR takeover pin) and force-close its C2C
        // stream, so queued replies do not leak into the wrong conversation
        // and QQ's "generating" guard does not block the incoming thread.
        const outgoingId = resolveCurrentSessionId(message.reply, threads)
        const oldAgent: AgentLike | undefined = agents.get(outgoingId)
        await outbound.closeStream(outgoingId).catch(() => undefined)
        try {
          oldAgent?.cancel({ kind: 'user' })
        } catch (error) {
          log.warn('failed to cancel old QQ agent on /switch: %o', error)
        }
        // `set` also drops any takeover pin, returning the target to threads.
        threads.set(key, target)
        const newId = effectiveSessionId(message.reply, target)
        log.info('QQ /switch: target=%s fromSession=%s toThread=%d oldAgent=%s newSessionId=%s',
          key, outgoingId, target, oldAgent ? 'present' : 'none', newId)
        await reply(`✅ 已切换到 ${target === 0 ? '#0（主会话）' : `#n${target}`}。下次发送的消息将进入 \`${newId}\`，继续该会话的历史上下文。`)
        return true
      }
      case 'reset':
      case 'clear':
      case 'new': {
        // Optional argument: the agent preset id the NEW session composes
        // from (validated against the host roster below). Unknown or broken
        // ids are refused BEFORE the thread bumps, so the current thread and
        // its anchor stay untouched.
        const arg = rest[0]
        let presetId: string | undefined
        if (arg !== undefined) {
          if (agentPresets === undefined) {
            await reply('⚠️ 当前环境不支持按会话指定 preset（host 未加载 agent-presets 服务）')
            return true
          }
          const presets = await listPresets()
          if (presets === undefined) {
            await reply('⚠️ 读取 preset 列表失败，请稍后再试')
            return true
          }
          const found = presets.find(preset => preset.id === arg)
          if (found === undefined) {
            const ids = presets.map(preset => preset.id)
            await reply(`⚠️ 未知的 preset "${arg}"。可用：${ids.length > 0 ? ids.join(', ') : '（无）'}。\n用 /presets 查看详情。`)
            return true
          }
          if (found.broken !== undefined) {
            await reply(`⚠️ preset "${arg}" 当前不可用：${found.broken}`)
            return true
          }
          presetId = found.id
        }
        // Cancel any agent still running on the current thread so its queued
        // or mid-stream assistant messages are dropped instead of leaking
        // into the abandoned session id. Force-close the C2C stream first
        // so QQ's "其它流式消息发送中" guard does not block the new thread.
        const key = targetKey(message.reply)
        const before = threads.current(key)
        const oldAgent: AgentLike | undefined = agents.get(sessionId)
        await outbound.closeStream(sessionId).catch(() => undefined)
        try {
          oldAgent?.cancel({ kind: 'user' })
        } catch (error) {
          log.warn('failed to cancel old QQ agent on /new: %o', error)
        }
        const thread = threads.next(key)
        const baseId = baseSessionId(message.reply)
        const newId = thread === 0 ? baseId : `${baseId}#n${thread}`
        // Record (or explicitly clear) the per-session override so the agent
        // materializing newId composes from it; a plain /new resets to the
        // plugin-config default.
        threads.setPreset(newId, presetId)
        log.info('QQ /new: target=%s beforeThread=%d afterThread=%d oldAgent=%s newSessionId=%s preset=%s',
          key, before, thread, oldAgent ? 'present' : 'none', newId, presetId ?? '(config default)')
        await reply(presetId === undefined
          ? `✅ 已开启新会话（#n${thread}）。下次发送的消息将进入 \`${newId}\`。旧的对话仍保留，可手动在侧边栏切换。`
          : `✅ 已开启新会话（#n${thread}，preset=${presetId}）。下次发送的消息将进入 \`${newId}\`。旧的对话仍保留，可手动在侧边栏切换。`)
        return true
      }
      case 'model': {
        // `/model` (no arg) reports the current thread's override, the provider
        // catalog (when the host llm service is present), the configured
        // aliases, and the usage.
        // `/model reset` clears the override (back to plugin-config default).
        // `/model <provider>` selects the provider; its default model applies.
        // `/model <provider>/<model>` selects both; the slash is required when
        // a model name is given, but the provider itself may contain slashes
        // (e.g. `MiniMax/coding-CN`). The first `/` is the separator.
        const key = targetKey(message.reply)
        const currentThread = threads.current(key)
        const baseId = baseSessionId(message.reply)
        const currentSessionId = currentThread === 0 ? baseId : `${baseId}#n${currentThread}`
        const existing = threads.modelFor(currentSessionId)
        const arg = rest[0]
        if (arg === undefined || arg === '') {
          const defaultLabel = `\`${config.provider ?? 'DeepSeek'}/${config.model ?? 'DeepSeek-V4-Flash'}\``
          const lines: string[] = [
            existing === undefined
              ? `当前线程无 model 覆盖，使用 plugin-config 默认：${defaultLabel}`
              : `当前线程 model：\`${existing.provider}${existing.model !== undefined ? '/' + existing.model : ''}\``,
          ]
          if (llm !== undefined) {
            try {
              const providers = llm.listProviders()
              for (const provider of providers) {
                const models = await llm.listModels(provider.id).catch(() => [])
                const modelList = models.map(model => model.id).join('、')
                lines.push(`- ${provider.id}：${modelList.length > 0 ? modelList : '（未公布模型）'}`)
              }
            } catch (error) {
              log.warn('QQ /model: listing provider catalog failed: %o', error)
            }
          }
          const aliases = config.modelAliases ?? {}
          const aliasEntries = Object.entries(aliases)
          if (aliasEntries.length > 0) {
            lines.push(`别名：${aliasEntries.map(([short, target]) => `${short}→${target}`).join('，')}`)
          }
          lines.push('用法：/model <provider>[/<model>] 或别名；/model reset 恢复默认')
          await reply(lines.join('\n'))
          return true
        }
        if (arg === 'reset' || arg === 'clear') {
          threads.setModel(currentSessionId, undefined)
          log.info('QQ /model reset: target=%s thread=%d sessionId=%s', key, currentThread, currentSessionId)
          await reply(`✅ 已清除 model 覆盖，下次消息回到 plugin-config 默认 \`${config.provider ?? 'DeepSeek'}/${config.model ?? 'DeepSeek-V4-Flash'}\``)
          return true
        }
        // Resolve alias first (config.modelAliases: short name → "provider[/model]"),
        // then parse "<provider>[/<model>]" with the first `/` as separator.
        const aliases = config.modelAliases ?? {}
        const resolved = typeof aliases[arg] === 'string' && aliases[arg].length > 0 ? aliases[arg] : arg
        const sep = resolved.indexOf('/')
        const provider = sep < 0 ? resolved : resolved.slice(0, sep)
        const model = sep < 0 ? undefined : resolved.slice(sep + 1)
        if (provider.length === 0) {
          await reply('⚠️ provider 不能为空（用法：`/model <provider>[/<model>]`）')
          return true
        }
        if (model !== undefined && model.length === 0) {
          await reply('⚠️ / 后面需要 model 名（用法：`/model <provider>/<model>`，或省略只写 provider）')
          return true
        }
        const override = model === undefined ? { provider } : { provider, model }
        // Validate against the live llm catalog when the host service exists:
        // an unknown provider can never route (hard failure later), while an
        // unknown model may still pass through on advisory-catalog adapters,
        // so it is accepted with a warning naming the available ids.
        let warning: string | undefined
        if (llm !== undefined) {
          const providers = llm.listProviders()
          if (!providers.some(entry => entry.id === provider)) {
            const ids = providers.map(entry => entry.id).join('、')
            await reply(`⚠️ 未知的 provider "${provider}"。当前可用：${ids}\n（可用 /model 查看完整清单）`)
            return true
          }
          if (model !== undefined) {
            const models = await llm.listModels(provider).catch(() => [])
            const ids = models.map(entry => entry.id)
            if (ids.length > 0 && !ids.includes(model)) {
              warning = `⚠️ 注意：模型 "${model}" 不在 ${provider} 当前清单中（${ids.join('、')}），严格校验的路由会请求失败`
            }
          }
        }
        // If the current thread already has a live agent, its model is fixed
        // (persisted in the session header), so switching requires a fresh
        // session: bump the thread exactly like `/new` does (cancel the old
        // agent, close any in-flight stream), carry over the preset override,
        // and record the model override on the NEW session id. When no agent
        // exists yet, the override lands on the current id directly and the
        // next inbound message composes with it.
        let targetSessionId = currentSessionId
        let threadNo = currentThread
        const oldAgent: AgentLike | undefined = agents.get(currentSessionId)
        if (oldAgent !== undefined) {
          await outbound.closeStream(currentSessionId).catch(() => undefined)
          try {
            oldAgent.cancel({ kind: 'user' })
          } catch (error) {
            log.warn('failed to cancel old QQ agent on /model: %o', error)
          }
          threadNo = threads.next(key)
          targetSessionId = threadNo === 0 ? baseId : `${baseId}#n${threadNo}`
          threads.setPreset(targetSessionId, threads.presetFor(currentSessionId))
        }
        threads.setModel(targetSessionId, override)
        log.info('QQ /model: target=%s thread=%d sessionId=%s override=%o', key, threadNo, targetSessionId, override)
        await reply([
          `✅ model 已切到 \`${provider}${model !== undefined ? '/' + model : ''}\`${oldAgent !== undefined ? `（已自动开启新会话 #n${threadNo}，preset 沿用）` : ''}，下一条消息即用新模型`,
          ...(warning !== undefined ? [warning] : []),
        ].join('\n'))
        return true
      }
      case 'stop': {
        const agent = agents.get(sessionId)
        if (agent === undefined) {
          await reply('⚠️ 当前没有活跃会话，无需中止')
          return true
        }
        try {
          await outbound.closeStream(sessionId).catch(() => undefined)
          agent.cancel({ kind: 'user' })
          await reply('✅ 已中止当前生成')
        } catch (error) {
          log.warn('QQ /stop: cancel failed: %o', error)
          await reply('⚠️ 中止失败，请稍后重试')
        }
        return true
      }
      case 'compact': {
        if (compaction === undefined) {
          await reply('⚠️ 当前环境不支持历史压缩（host 未加载 compaction 服务）')
          return true
        }
        const agent = agents.get(sessionId)
        if (agent === undefined) {
          await reply('⚠️ 当前无活跃会话')
          return true
        }
        try {
          const outcome = await compaction.compactNow(sessionId)
          if (outcome.ok) {
            if (!outcome.shadowed || outcome.shadowed === 0) {
              await reply('没有可压缩的历史')
            } else {
              await reply(`✅ 已压缩 ${outcome.shadowed} 条历史记录${outcome.tokens !== undefined ? `（约 ${outcome.tokens} tokens）` : ''}`)
            }
          } else {
            switch (outcome.reason) {
              case 'busy':
                await reply('⚠️ 正在生成中，无法压缩')
                break
              case 'unavailable':
                await reply('⚠️ 压缩能力不可用（当前 agent preset 未加载 compaction 服务）')
                break
              default:
                await reply(`⚠️ 压缩失败：${outcome.message ?? outcome.reason ?? '未知错误'}`)
            }
          }
        } catch (error) {
          log.warn('QQ /compact failed: %o', error)
          await reply('⚠️ 压缩失败，请稍后重试')
        }
        return true
      }
      case 'status': {
        const agent = agents.get(sessionId)
        if (agent === undefined) {
          await reply('当前无活跃会话（发送消息以开始对话）')
          return true
        }
        const lines: string[] = [
          `🤖 会话状态`,
          `- Session ID: \`${sessionId}\``,
          `- 会话类型: ${message.kind}`,
          `- 发送者: \`${message.senderId}\``,
        ]
        if (sessionPersistence !== undefined) {
          try {
            const inspected = await sessionPersistence.inspect(sessionId)
            lines.push(`- 创建时间: ${new Date(inspected.meta.createdAt).toLocaleString()}`)
            lines.push(`- 历史消息: ${Array.isArray(inspected.events) ? inspected.events.length : '?'} 条`)
          } catch {
            // Session not yet persisted or inspection failed — skip those lines.
          }
        }
        await reply(lines.join('\n'))
        return true
      }
      case 'approve': {
        const sub = rest[0] ?? 'status'
        if (sub === 'ask' || sub === 'never') {
          const agent = agents.get(sessionId)
          if (approval === undefined || agent === undefined) {
            await reply('⚠️ 当前环境不支持审批策略切换')
            return true
          }
          approval.setPolicy(agent, sub)
          await reply(`✅ 审批策略已切换为 ${sub}`)
          return true
        }
        const listed = alwaysAllow.list(sessionId)
        await reply(listed.length > 0
          ? `始终允许的工具：${listed.join(', ')}（用 /approve ask|never 切换策略）`
          : '无始终允许的工具（用 /approve ask|never 切换策略）')
        return true
      }
      case 'always':
        if (rest[0] === 'clear') {
          const removed = alwaysAllow.clear(sessionId)
          await reply(`✅ 已清除 ${removed} 条"始终允许"规则`)
          return true
        }
        return false
      default:
        return false
    }
  }
}