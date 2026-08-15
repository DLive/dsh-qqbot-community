/**
 * Inbound pipeline (QQ → DSH agent): normalize the gateway event, dedupe,
 * enforce the allowlist, strip @mentions, resolve quoted messages via the
 * ref index, process attachments (images → ImageBlock via the attachment
 * service, voice → ASR text / STT, files → download under the session cwd),
 * assemble the model-facing text, intercept slash commands, keep the typing
 * indicator alive, and deliver to the per-conversation DSH agent.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  type AgentLike,
  type AgentRegistryService,
  type AttachmentStoreService,
  type Config,
  type IncomingMessage,
  type InboundAttachment,
  type MentionEntry,
  type ReplyTarget,
  type SessionPersistenceService,
  type SttConfig,
} from './types.js'
import type { QQApi, LogSink } from './qqapi.js'
import type { RefIndexStore } from './refindex.js'
import type { RouteStore } from './store.js'
import { ThreadStore, targetKey } from './threadstore.js'

export const SESSION_PREFIX = 'qq:v2'

/** LRU caps for inbound dedup. */
const DEDUP_MAX = 2_000
/** Voice/file download budget. */
const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
/** Media formats the attachment service accepts as ImageBlocks. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface InboundDeps {
  readonly config: Config
  readonly api: QQApi
  readonly log: LogSink
  readonly refIndex: RefIndexStore
  readonly routes: RouteStore
  readonly agents: AgentRegistryService
  readonly sessionPersistence: SessionPersistenceService | undefined
  readonly attachments: AttachmentStoreService | undefined
  readonly approval: { setPolicy(agent: { id: string } & object, policy: 'ask' | 'never'): void } | undefined
  readonly threads: ThreadStore
}

/** Hooks attached after construction via {@link InboundPipeline.attachHooks}. */
export interface InboundHooks {
  /** Called with the built user text before agent delivery (slash commands). */
  onSlashCommand?: (
    sessionId: string,
    message: IncomingMessage,
    text: string,
    reply: (text: string) => Promise<void>,
  ) => Promise<boolean>
  /** Registers per-agent scoped contributions (tools, approval answerer). */
  setupAgent?: (agentCtx: Context, sessionId: string) => void
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Normalize one gateway op-0 payload into an IncomingMessage. */
export function normalizeMessage(payload: unknown, eventType: string): IncomingMessage | undefined {
  const data = asRecord(payload)
  if (data === undefined || typeof data.id !== 'string') return undefined
  const author = asRecord(data.author)

  // ref_msg_idx / msg_idx ride inside message_scene.ext as "k=v" strings.
  let msgIdx: string | undefined
  let refMsgIdx: string | undefined
  const scene = asRecord(data.message_scene)
  if (Array.isArray(scene?.ext)) {
    for (const entry of scene.ext) {
      if (typeof entry !== 'string') continue
      const eq = entry.indexOf('=')
      if (eq < 0) continue
      const key = entry.slice(0, eq).trim()
      const value = entry.slice(eq + 1).trim()
      if (value.length === 0) continue
      if (key === 'msg_idx') msgIdx = value
      else if (key === 'ref_msg_idx') refMsgIdx = value
    }
  }
  // msg_type 103 carries the quoted element index in msg_elements[0].msg_idx.
  const elements = Array.isArray(data.msg_elements)
    ? (data.msg_elements as unknown[]).map(asRecord).filter((el): el is Record<string, unknown> => el !== undefined)
    : []
  if (data.message_type === 103 && elements[0]?.msg_idx !== undefined && typeof elements[0].msg_idx === 'string') {
    refMsgIdx = elements[0].msg_idx
  }

  const attachments = (Array.isArray(data.attachments) ? data.attachments : [])
    .map(asRecord)
    .filter((att): att is Record<string, unknown> => att !== undefined)
    .map((att) => ({
      content_type: typeof att.content_type === 'string' ? att.content_type : 'application/octet-stream',
      url: typeof att.url === 'string' ? (att.url.startsWith('//') ? `https:${att.url}` : att.url) : '',
      filename: typeof att.filename === 'string' ? att.filename : undefined,
      voice_wav_url: typeof att.voice_wav_url === 'string' && att.voice_wav_url.startsWith('//')
        ? `https:${att.voice_wav_url}`
        : typeof att.voice_wav_url === 'string' ? att.voice_wav_url : undefined,
      asr_refer_text: typeof att.asr_refer_text === 'string' ? att.asr_refer_text : undefined,
    }))

  const mentions = (Array.isArray(data.mentions) ? data.mentions : [])
    .map(asRecord)
    .filter((m): m is Record<string, unknown> => m !== undefined)
    .map((m) => ({
      id: typeof m.id === 'string' ? m.id : undefined,
      user_openid: typeof m.user_openid === 'string' ? m.user_openid : undefined,
      member_openid: typeof m.member_openid === 'string' ? m.member_openid : undefined,
      nickname: typeof m.nickname === 'string' ? m.nickname : undefined,
      username: typeof m.username === 'string' ? m.username : undefined,
      is_you: m.is_you === true,
    }))

  if (eventType === 'C2C_MESSAGE_CREATE' && author !== undefined && typeof author.user_openid === 'string') {
    return {
      id: data.id,
      kind: 'c2c',
      content: typeof data.content === 'string' ? data.content : '',
      senderId: author.user_openid,
      senderName: undefined,
      timestamp: typeof data.timestamp === 'string' ? data.timestamp : '',
      msgIdx,
      refMsgIdx,
      msgType: typeof data.message_type === 'number' ? data.message_type : undefined,
      attachments,
      msgElements: elements.map((el) => ({
        msg_idx: typeof el.msg_idx === 'string' ? el.msg_idx : undefined,
        content: typeof el.content === 'string' ? el.content : undefined,
        attachments: [],
      })),
      mentions,
      reply: { kind: 'c2c', userId: author.user_openid },
    }
  }
  if (eventType === 'GROUP_AT_MESSAGE_CREATE' && author !== undefined && typeof author.member_openid === 'string' && typeof data.group_openid === 'string') {
    return {
      id: data.id,
      kind: 'group',
      content: typeof data.content === 'string' ? data.content : '',
      senderId: author.member_openid,
      senderName: typeof author.username === 'string' ? author.username : undefined,
      timestamp: typeof data.timestamp === 'string' ? data.timestamp : '',
      msgIdx,
      refMsgIdx,
      msgType: typeof data.message_type === 'number' ? data.message_type : undefined,
      attachments,
      msgElements: elements.map((el) => ({
        msg_idx: typeof el.msg_idx === 'string' ? el.msg_idx : undefined,
        content: typeof el.content === 'string' ? el.content : undefined,
        attachments: [],
      })),
      mentions,
      reply: { kind: 'group', groupId: data.group_openid },
    }
  }
  if ((eventType === 'AT_MESSAGE_CREATE' || eventType === 'DIRECT_MESSAGE_CREATE') && author !== undefined && typeof author.id === 'string') {
    const channelId = typeof data.channel_id === 'string' ? data.channel_id : undefined
    if (channelId === undefined) return undefined
    return {
      id: data.id,
      kind: 'channel',
      content: typeof data.content === 'string' ? data.content : '',
      senderId: author.id,
      senderName: typeof author.username === 'string' ? author.username : undefined,
      timestamp: typeof data.timestamp === 'string' ? data.timestamp : '',
      msgIdx,
      refMsgIdx,
      msgType: undefined,
      attachments,
      msgElements: [],
      mentions,
      reply: { kind: 'channel', channelId },
    }
  }
  return undefined
}

/** Base session id for a conversation target (no thread suffix). */
export function baseSessionId(target: ReplyTarget): string {
  if (target.kind === 'c2c') return `${SESSION_PREFIX}:c2c:${target.userId}`
  if (target.kind === 'group') return `${SESSION_PREFIX}:group:${target.groupId}`
  return `${SESSION_PREFIX}:channel:${target.channelId}`
}

/** Session id used by the DSH agent for a given target+thread. */
export function effectiveSessionId(target: ReplyTarget, thread: number): string {
  return thread === 0 ? baseSessionId(target) : `${baseSessionId(target)}#n${thread}`
}

/** Compatibility shim: returns the base id (thread 0) for the inbound message. */
export function sessionIdFor(message: IncomingMessage): string {
  return baseSessionId(message.reply)
}

/** Replace <@openid> with @nickname and drop self-mentions. */
export function stripMentions(text: string, mentions: readonly MentionEntry[]): string {
  let cleaned = text
  for (const mention of mentions) {
    const openid = mention.member_openid ?? mention.id ?? mention.user_openid
    if (openid === undefined || openid.length === 0) continue
    if (mention.is_you) {
      cleaned = cleaned.replace(new RegExp(`<@!?${openid}>`, 'g'), '')
    } else {
      const display = mention.nickname ?? mention.username
      if (display !== undefined) {
        cleaned = cleaned.replace(new RegExp(`<@!?${openid}>`, 'g'), `@${display}`)
      }
    }
  }
  return cleaned.trim()
}

/** Allowlist gate: '*' or an empty list admits everyone. */
export function isAllowed(list: string[] | undefined, id: string): boolean {
  if (list === undefined || list.length === 0 || list.includes('*')) return true
  return list.includes(id)
}

/** Build the model-facing text: quoted message first, then the new content. */
export function assembleText(
  cleanedText: string,
  quote: { senderName?: string; content: string } | undefined,
  extras: readonly string[],
): string {
  const parts: string[] = []
  if (quote !== undefined && quote.content.trim().length > 0) {
    const who = quote.senderName !== undefined && quote.senderName.length > 0 ? `${quote.senderName}: ` : ''
    parts.push(`[引用消息开始]\n${who}${quote.content.trim()}\n[引用消息结束]`)
  }
  parts.push(cleanedText)
  for (const extra of extras) {
    if (extra.trim().length > 0) parts.push(extra.trim())
  }
  return parts.join('\n').trim()
}

/** Describe attachments for the model when binary transfer is unavailable. */
function describeAttachments(attachments: readonly InboundAttachment[], voiceText: string | undefined): string {
  const parts: string[] = []
  if (voiceText !== undefined && voiceText.length > 0) parts.push(`[语音] ${voiceText}`)
  for (const att of attachments) {
    const type = att.content_type.toLowerCase()
    if (type.startsWith('audio/')) continue // covered by voiceText
    if (type.startsWith('image/')) parts.push(`[图片${att.filename !== undefined ? `: ${att.filename}` : ''}]`)
    else if (type.startsWith('video/')) parts.push(`[视频${att.filename !== undefined ? `: ${att.filename}` : ''}]`)
    else parts.push(`[文件${att.filename !== undefined ? `: ${att.filename}` : ''}]`)
  }
  return parts.join('\n')
}

async function downloadTo(url: string, dir: string, filename: string | undefined): Promise<string | undefined> {
  if (!url.startsWith('https://')) return undefined
  try {
    await mkdir(dir, { recursive: true })
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > DOWNLOAD_MAX_BYTES) return undefined
    const safeName = (filename ?? `qq-${Date.now()}`).replace(/[/\\:*?"<>|]/g, '_')
    const path = join(dir, safeName)
    await writeFile(path, buffer)
    return path
  } catch {
    return undefined
  }
}

/** OpenAI-compatible speech-to-text transcription (skipped without an apiKey). */
async function transcribe(stt: SttConfig, wavPath: string): Promise<string | undefined> {
  if (stt.apiKey === undefined || stt.apiKey.length === 0) return undefined
  const { readFile } = await import('node:fs/promises')
  const form = new FormData()
  form.append('file', new Blob([await readFile(wavPath)]), 'audio.wav')
  form.append('model', stt.model)
  const base = stt.baseUrl.replace(/\/+$/, '')
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stt.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) return undefined
  const data = asRecord(await response.json())
  return typeof data?.text === 'string' ? data.text : undefined
}

/** The inbound pipeline. */
export class InboundPipeline {
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []
  private readonly agentCreation = new Map<string, Promise<AgentLike>>()
  /** Per-session C2C typing indicator timers; cleared on turn end / disposal. */
  private readonly typingTimers = new Map<string, NodeJS.Timeout>()
  /** Attached after construction so the handlers can close over outbound. */
  private onSlashCommand: InboundHooks['onSlashCommand'] | undefined
  private setupAgent: InboundHooks['setupAgent'] | undefined

  constructor(private readonly deps: InboundDeps) {}

  /**
   * Attach the slash-command and per-agent setup callbacks after the
   * pipeline itself is wired. Used by the composition root so the handlers
   * can close over the outbound pipeline (which depends on inbound being
   * constructed first).
   */
  attachHooks(hooks: {
    onSlashCommand?: (
      sessionId: string,
      message: IncomingMessage,
      text: string,
      reply: (text: string) => Promise<void>,
    ) => Promise<boolean>
    setupAgent?: (agentCtx: Context, sessionId: string) => void
  }): void {
    if (hooks.onSlashCommand !== undefined) this.onSlashCommand = hooks.onSlashCommand
    if (hooks.setupAgent !== undefined) this.setupAgent = hooks.setupAgent
  }

  /** Entry point for every normalized gateway message. */
  async handle(message: IncomingMessage): Promise<void> {
    if (this.dedupe(message.id)) return

    const allowed = message.kind === 'group'
      ? isAllowed(this.deps.config.groupAllowFrom, message.reply.kind === 'group' ? message.reply.groupId : '')
      : isAllowed(this.deps.config.allowFrom, message.senderId)
    if (!allowed) {
      if (this.deps.config.debug) this.deps.log.debug?.('dropped message from non-allowlisted sender %s', message.senderId)
      return
    }

    // Resolve the effective DSH session id for this target's current thread
    // (the /new slash command bumps the thread counter so the next inbound
    // message lands in a fresh session). The base id is unchanged for
    // thread 0, so existing sessions keep their ids.
    const thread = this.deps.threads.current(targetKey(message.reply))
    const sessionId = effectiveSessionId(message.reply, thread)
    this.deps.log.info('QQ inbound: id=%s kind=%s sender=%s thread=%d sessionId=%s', message.id, message.kind, message.senderId, thread, sessionId)

    // Slash commands are checked before any routing bookkeeping so /new
    // doesn't disturb the previous thread's anchor and /help /ping /me
    // don't start a typing indicator for a one-line canned reply.
    const cleaned = stripMentions(message.content, message.mentions)
    if (this.deps.config.slashCommands !== false && cleaned.startsWith('/')) {
      const reply = async (replyText: string): Promise<void> => {
        await this.deps.api.sendText(message.reply, replyText, message.id).catch((error: unknown) => {
          this.deps.log.error('slash-command reply failed: %o', error)
        })
      }
      const handled = await this.onSlashCommand?.(sessionId, message, cleaned, reply) ?? false
      if (handled) return
    }

    // Routing bookkeeping before anything async: the outbound pipeline and
    // any non-slash replies both depend on the anchor being present.
    this.deps.routes.anchor(sessionId, message.reply, message.id)
    this.startTyping(sessionId, message.reply, message.id)

    // Record this message for future quote resolution.
    if (message.msgIdx !== undefined) {
      this.deps.refIndex.set(message.msgIdx, {
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
        content: message.content.slice(0, 500),
        scope: message.kind,
      })
    }

    // Resolve the quoted message: ref index first, msg_elements fallback.
    let quote: { senderName?: string; content: string } | undefined
    if (message.refMsgIdx !== undefined) {
      const entry = this.deps.refIndex.get(message.refMsgIdx)
      if (entry !== undefined) {
        quote = { senderName: entry.senderName, content: entry.content }
      } else {
        const element = message.msgElements[0]
        if (element?.content !== undefined && element.content.length > 0) {
          quote = { content: element.content }
        }
      }
    }

    // Attachments: images become ImageBlocks; voice becomes text; the rest
    // download under the session cwd so the agent's file tools can read them.
    const imageBlocks: { type: 'image'; attachment: import('./types.js').ImageAttachmentRefLike }[] = []
    const extras: string[] = []
    let voiceText: string | undefined
    const cwd = this.deps.config.cwd ?? process.cwd()
    const mediaDir = join(cwd, '.qq-media')

    for (const att of message.attachments) {
      const type = att.content_type.toLowerCase()
      try {
        if (type.startsWith('image/') && IMAGE_MEDIA_TYPES.has(type) && this.deps.attachments !== undefined) {
          const response = await fetch(att.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer())
            const name = att.filename ?? 'qq-image'
            const ref = await this.deps.attachments.saveImage({
              data: bytes,
              mediaType: type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
              name,
            })
            imageBlocks.push({ type: 'image', attachment: ref })
            continue
          }
        }
        if (type.startsWith('audio/')) {
          voiceText = att.asr_refer_text
          if ((voiceText === undefined || voiceText.length === 0) && this.deps.config.stt !== undefined) {
            const wavUrl = att.voice_wav_url ?? att.url
            const local = await downloadTo(wavUrl, mediaDir, att.filename)
            if (local !== undefined) {
              voiceText = (await transcribe(this.deps.config.stt, local)) ?? undefined
            }
          }
          continue
        }
        if (this.deps.config.mediaDownload !== false && att.url.length > 0) {
          const local = await downloadTo(att.url, mediaDir, att.filename)
          if (local !== undefined) extras.push(`[已下载附件: ${local}]`)
          else extras.push(`[附件下载失败${att.filename !== undefined ? `: ${att.filename}` : ''}]`)
        }
      } catch (error) {
        this.deps.log.warn('attachment processing failed: %o', error)
      }
    }

    const described = describeAttachments(message.attachments, voiceText)
    if (described.length > 0) extras.unshift(described)
    const text = assembleText(cleaned, quote, extras)

    if (text.length === 0 && imageBlocks.length === 0) {
      this.stopTyping(sessionId)
      return
    }

    const agent = await this.ensureAgent(sessionId)
    if (!agent) {
      this.deps.log.error('QQ inbound: ensureAgent returned no agent for %s', sessionId)
      this.stopTyping(sessionId)
      return
    }
    this.deps.log.info('QQ inbound: agent.send %s (target session=%s)', message.id, sessionId)
    agent.send({
      id: message.id,
      role: 'user',
      content: [
        ...(text.length > 0 ? [{ type: 'text', text }] : []),
        ...imageBlocks,
      ],
      source: { kind: 'user', id: message.senderId, name: message.senderName ?? message.senderId },
    }, 'next-turn', true)
  }

  private dedupe(messageId: string): boolean {
    if (this.seen.has(messageId)) return true
    this.seen.add(messageId)
    this.seenOrder.push(messageId)
    if (this.seenOrder.length > DEDUP_MAX) {
      const oldest = this.seenOrder.shift()
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return false
  }

  private startTyping(sessionId: string, target: ReplyTarget, msgId: string): void {
    if (this.deps.config.typing !== true || target.kind !== 'c2c') return
    this.stopTyping(sessionId)
    const send = (): void => { void this.deps.api.sendTyping(target, msgId) }
    send()
    this.typingTimers.set(sessionId, setInterval(send, 50_000))
  }

  stopTyping(sessionId: string): void {
    const timer = this.typingTimers.get(sessionId)
    if (timer !== undefined) {
      clearInterval(timer)
      this.typingTimers.delete(sessionId)
    }
  }

  /** Create or resume the DSH agent bound to the QQ session id. */
  private async ensureAgent(sessionId: string): Promise<AgentLike> {
    const existing = this.deps.agents.get(sessionId)
    if (existing !== undefined) return existing

    let creation = this.agentCreation.get(sessionId)
    if (creation === undefined) {
      this.deps.log.info('QQ ensureAgent: creating agent for %s', sessionId)
      creation = (async () => {
        const setup = this.setupAgent !== undefined
          ? (agentCtx: Context): void => { this.setupAgent?.(agentCtx, sessionId) }
          : undefined
        try {
          return (await this.deps.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: { provider: this.deps.config.provider, model: this.deps.config.model },
            ...(setup !== undefined ? { setup } : {}),
          })).agent
        } catch (error) {
          if (this.deps.config.debug) this.deps.log.debug?.('resume %s failed, creating fresh: %o', sessionId, error)
        }
        // Pick a cwd consistent with any persisted header before creating.
        let cwd: string = this.deps.config.cwd ?? process.cwd()
        if (this.deps.sessionPersistence !== undefined) {
          try {
            const inspected = await this.deps.sessionPersistence.inspect(sessionId)
            if (typeof inspected.meta.cwd === 'string' && inspected.meta.cwd.length > 0) cwd = inspected.meta.cwd
          } catch {
            // No persisted session: fall through with the configured cwd.
          }
        }
        try {
          const agent = (await this.deps.agents.create({
            sessionId,
            agentOptions: { provider: this.deps.config.provider, model: this.deps.config.model },
            meta: { cwd },
            ...(setup !== undefined ? { setup } : {}),
          })).agent
          this.deps.log.info('QQ ensureAgent: created %s', agent.id)
          return agent
        } catch (error) {
          this.deps.log.error('QQ session %s could not be created (cwd=%s): %o', sessionId, cwd, error)
          throw error
        }
      })()
      this.agentCreation.set(sessionId, creation)
      void creation.then(
        () => { this.agentCreation.delete(sessionId) },
        () => { this.agentCreation.delete(sessionId) },
      )
    }
    return creation
  }

  /** Forget in-flight creation state after an agent is disposed. */
  onAgentDisposed(sessionId: string): void {
    this.agentCreation.delete(sessionId)
    this.stopTyping(sessionId)
  }

  /** Clear every typing timer; used during plugin teardown. */
  dispose(): void {
    for (const timer of this.typingTimers.values()) clearInterval(timer)
    this.typingTimers.clear()
  }
}

/** Extract the target encoded in a session id (inverse of baseSessionId). */
export function targetOfSession(sessionId: string): ReplyTarget {
  // The optional #n<thread> suffix carries no target info — strip it before parsing.
  const stripped = sessionId.split('#')[0]
  const parts = stripped.split(':')
  if (parts[1] === 'v2' && parts[2] === 'c2c' && parts[3] !== undefined) return { kind: 'c2c', userId: parts[3] }
  if (parts[1] === 'v2' && parts[2] === 'group' && parts[3] !== undefined) return { kind: 'group', groupId: parts[3] }
  if (parts[1] === 'v2' && parts[2] === 'channel' && parts[3] !== undefined) return { kind: 'channel', channelId: parts[3] }
  return { kind: 'c2c', userId: 'unknown' }
}
