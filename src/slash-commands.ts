/**
 * Slash commands answered directly by the adapter (never reach the agent):
 *   /help /ping /me /new [preset] /presets /approve /always
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
  IncomingMessage,
} from './types.js'
import type { LogSink } from './qqapi.js'
import type { AlwaysAllowStore } from './store.js'
import { ThreadStore, targetKey } from './threadstore.js'
import { baseSessionId } from './inbound.js'
import type { OutboundPipeline } from './outbound.js'

export interface SlashDeps {
  readonly log: LogSink
  readonly alwaysAllow: AlwaysAllowStore
  readonly threads: ThreadStore
  readonly agents: AgentRegistryService
  readonly approval: ApprovalServiceLike | undefined
  readonly outbound: OutboundPipeline
  /** Present when the host runs the agent-presets service; enables /new <preset> and /presets. */
  readonly agentPresets: AgentPresetsLike | undefined
}

/** Built handler compatible with `InboundPipeline.InboundDeps.onSlashCommand`. */
export type SlashHandler = (
  sessionId: string,
  message: IncomingMessage,
  text: string,
  reply: (text: string) => Promise<void>,
) => Promise<boolean>

export function createSlashHandler(deps: SlashDeps): SlashHandler {
  const { log, alwaysAllow, threads, agents, approval, outbound, agentPresets } = deps
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
  return async (sessionId, message, text, reply) => {
    if (!text.startsWith('/')) return false
    const [command, ...rest] = text.slice(1).split(/\s+/)
    switch (command) {
      case 'help':
        await reply([
          '/help — 显示可用命令',
          '/ping — 延迟检测',
          '/me — 显示你的 openid',
          '/new [preset] — 开启新会话（可选 preset id，见 /presets）',
          '/presets — 列出可用的 agent preset',
          '/approve ask|never|status — 审批策略',
          '/always clear — 清除"始终允许"清单',
        ].join('\n'))
        return true
      case 'ping':
        await reply(`✅ pong（${new Date().toLocaleTimeString()}）`)
        return true
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
            await reply(`⚠️ 未知的 preset “${arg}”。可用：${ids.length > 0 ? ids.join(', ') : '（无）'}。\n用 /presets 查看详情。`)
            return true
          }
          if (found.broken !== undefined) {
            await reply(`⚠️ preset “${arg}” 当前不可用：${found.broken}`)
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