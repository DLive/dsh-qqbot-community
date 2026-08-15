/**
 * Slash commands answered directly by the adapter (never reach the agent):
 *   /help /ping /me /new /approve /always
 *
 * Returns `true` if the command was handled (so the inbound pipeline skips
 * agent delivery), `false` to fall through. The factory pattern lets us
 * inject every collaborator the commands need without the composition root
 * having to know about them.
 */
import type {
  AgentLike,
  AgentRegistryService,
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
}

/** Built handler compatible with `InboundPipeline.InboundDeps.onSlashCommand`. */
export type SlashHandler = (
  sessionId: string,
  message: IncomingMessage,
  text: string,
  reply: (text: string) => Promise<void>,
) => Promise<boolean>

export function createSlashHandler(deps: SlashDeps): SlashHandler {
  const { log, alwaysAllow, threads, agents, approval, outbound } = deps
  return async (sessionId, message, text, reply) => {
    if (!text.startsWith('/')) return false
    const [command, ...rest] = text.slice(1).split(/\s+/)
    switch (command) {
      case 'help':
        await reply([
          '/help — 显示可用命令',
          '/ping — 延迟检测',
          '/me — 显示你的 openid',
          '/new — 开启新会话（独立 sessionId）',
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
      case 'new': {
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
        log.info('QQ /new: target=%s beforeThread=%d afterThread=%d oldAgent=%s newSessionId=%s',
          key, before, thread, oldAgent ? 'present' : 'none', newId)
        await reply(`✅ 已开启新会话（#n${thread}）。下次发送的消息将进入 \`${newId}\`。旧的对话仍保留，可手动在侧边栏切换。`)
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