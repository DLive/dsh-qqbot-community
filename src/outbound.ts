/**
 * Outbound pipeline (DSH session events → QQ): subscribes to `session/event`
 * for QQ sessions and turns the event log into QQ traffic — token streaming
 * (C2C replace-mode frames with prefix reconciliation), debounced merging of
 * consecutive assistant texts inside one turn, static chunked sends, typing
 * lifecycle, and passive→active reply degradation. Also hosts the QQ
 * inline-keyboard approval answerer registered per QQ agent.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  type ApprovalOutcome,
  type ApprovalRequestLike,
  type Config,
  type ReplyTarget,
  type SessionEventShape,
  type SessionShape,
} from './types.js'
import { nextMsgSeq, type QQApi, type LogSink } from './qqapi.js'
import { SESSION_PREFIX, type InboundPipeline, targetOfSession } from './inbound.js'
import type { AlwaysAllowStore, RouteStore } from './store.js'

/** Strip internal scaffolding tags models sometimes emit. */
const INTERNAL_TAGS = [
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<previous_response\b[^>]*>[\s\S]*?<\/previous_response>/gi,
  /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*\/?\s*>/gi,
  /`think`[\s\S]*?`\/think`/gi,
  /<\s*\/?\s*think\b[^>]*\/?\s*>/gi,
  /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
  /<\s*\/?\s*thinking\b[^>]*\/?\s*>/gi,
]

export function sanitizeOut(text: string): string {
  let result = text
  for (const pattern of INTERNAL_TAGS) result = result.replace(pattern, '')
  return result.trim()
}

/** Split long text on paragraph/sentence boundaries close to the limit. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = -1
    for (const marker of ['\n\n', '\n', '。', '；', '. ', ' ']) {
      const index = rest.lastIndexOf(marker, limit)
      if (index > limit * 0.3) { cut = index + marker.length; break }
    }
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

function prefixMatches(accepted: string, incoming: string): boolean {
  if (incoming.startsWith(accepted)) return true
  return incoming.replace(/\s+/g, ' ').startsWith(accepted.replace(/\s+/g, ' '))
}

function longestCommonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/** Replace-mode stream session state for one assistant step. */
interface StreamState {
  msgSeq: number
  index: number
  lastAccepted: string
  /** Latest candidate not yet sent; drained strictly one frame at a time. */
  pending?: string
  /** True while a frame request is in flight (QQ accepts one replace frame at a time). */
  inFlight: boolean
  /** True once the stream is being closed: the drain loop must stop and never send another frame. */
  closing: boolean
  streamMsgId?: string
  sentFrames: number
  failed: boolean
  lastSentAt: number
}

/** Debounced static send buffer for one turn. */
interface DeliverBuffer {
  texts: string[]
  timer?: NodeJS.Timeout
  firstAt: number
  flushed: boolean
}

/** Raw button decision before mapping to the DSH outcome vocabulary. */
type ButtonDecision = 'allow-once' | 'allow-always' | 'deny'

export interface OutboundDeps {
  readonly config: Config
  readonly api: QQApi
  readonly log: LogSink
  readonly routes: RouteStore
  readonly alwaysAllow: AlwaysAllowStore
  readonly inbound: InboundPipeline
}

export class OutboundPipeline {
  /** Streaming state per session (one live step at a time). */
  private streams = new Map<string, StreamState>()
  /** Debounce buffers per session. */
  private buffers = new Map<string, DeliverBuffer>()
  /** Pending approval decisions keyed by button-data token. */
  private pendingApprovals = new Map<string, { resolve: (outcome: ButtonDecision) => void }>()

  constructor(private readonly deps: OutboundDeps) {}

  /** Register the session-event listener on the plugin context. */
  bind(ctx: Context): void {
    const onEvent = ctx.on as unknown as (
      name: 'session/event',
      listener: (session: SessionShape, event: SessionEventShape) => void,
    ) => () => void
    onEvent('session/event', (session, event) => {
      if (!session.id.startsWith(`${SESSION_PREFIX}:`)) return
      void this.handleEvent(session.id, event).catch((error: unknown) => {
        this.deps.log.error('outbound event handling failed for %s: %o', session.id, error)
      })
    })
  }

  private async handleEvent(sessionId: string, event: SessionEventShape): Promise<void> {
    const target = this.targetOf(sessionId)
    if (event.type === 'assistant/message' || event.type === 'turn/end') {
      this.deps.log.info('QQ outbound: %s session=%s target=%s', event.type, sessionId, target.kind)
    }
    if (event.type === 'turn/start') {
      this.resetTurn(sessionId)
      return
    }
    if (event.type === 'turn/end') {
      this.resetTurn(sessionId)
      this.deps.inbound.stopTyping(sessionId)
      return
    }
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && target.kind === 'c2c' && this.deps.config.streaming !== false) {
        this.onStreamDelta(sessionId, chunk.text)
      }
      return
    }
    if (event.type === 'assistant/message') {
      const text = sanitizeOut((event.data.message?.content ?? [])
        .filter((block): block is { readonly type: string; readonly text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join(''))
      await this.onAssistantMessage(sessionId, text)
      return
    }
  }

  private targetOf(sessionId: string): ReplyTarget {
    const live = this.deps.routes.get(sessionId)
    return live?.target ?? targetOfSession(sessionId)
  }

  private resetTurn(sessionId: string): void {
    const stream = this.streams.get(sessionId)
    if (stream !== undefined) {
      this.streams.delete(sessionId)
      // The turn ended without an assistant/message (e.g. aborted): finalize
      // whatever was streamed so QQ does not keep a "generating" bubble.
      if (stream.sentFrames > 0 && !stream.failed) {
        void this.finishStream(sessionId, stream, stream.lastAccepted)
      }
    }
    this.flushBuffer(sessionId, true)
  }

  /**
   * Force-close any in-flight C2C stream for `sessionId` by sending the
   * DONE (input_state=10) frame. Called from `agent/disposed` (so a
   * disposed/cancelled agent does not leave a "generating" bubble on QQ)
   * and from `/new` (so the abandoned session id can be reused).
   */
  async closeStream(sessionId: string): Promise<void> {
    const stream = this.streams.get(sessionId)
    if (stream === undefined) return
    this.streams.delete(sessionId)
    if (stream.sentFrames > 0 && !stream.failed) {
      await this.finishStream(sessionId, stream, stream.lastAccepted)
    }
  }

  /** Close every active stream; used during plugin teardown. */
  async disposeAllStreams(): Promise<void> {
    for (const sessionId of [...this.streams.keys()]) {
      await this.closeStream(sessionId).catch(() => undefined)
    }
  }

  // ── Streaming (C2C replace mode) ───────────────────────────────────────────

  private onStreamDelta(sessionId: string, delta: string): void {
    let stream = this.streams.get(sessionId)
    if (stream === undefined) {
      const anchor = this.deps.routes.get(sessionId)
      if (anchor?.lastMsgId === undefined) return // no passive anchor: skip streaming
      stream = {
        msgSeq: nextMsgSeq(),
        index: 0,
        lastAccepted: '',
        pending: undefined,
        inFlight: false,
        closing: false,
        sentFrames: 0,
        failed: false,
        lastSentAt: 0,
      }
      this.streams.set(sessionId, stream)
    }
    if (stream.failed || stream.closing) return
    stream.pending = prefixMatches(stream.lastAccepted, delta)
      ? delta
      : stream.lastAccepted + delta.slice(longestCommonPrefix(stream.lastAccepted, delta))
    void this.drainStream(sessionId, stream)
  }

  /**
   * Send queued stream content strictly one frame at a time. QQ rejects
   * concurrent replace-mode frames for one stream (40034021 "其它流式消息
   * 发送中"), and the previous fire-and-forget throttling only stamped
   * `lastSentAt` after the request settled, so every delta that arrived
   * while a frame was in flight passed the throttle and raced it.
   */
  private async drainStream(sessionId: string, stream: StreamState): Promise<void> {
    if (stream.inFlight || stream.failed || stream.closing) return
    stream.inFlight = true
    try {
      while (!stream.failed && !stream.closing && stream.pending !== undefined) {
        const throttle = this.deps.config.streamThrottleMs ?? 1_200
        const wait = throttle - (Date.now() - stream.lastSentAt)
        if (wait > 0) {
          await new Promise(resolve => setTimeout(resolve, wait))
          continue
        }
        const text = stream.pending
        stream.pending = undefined
        await this.sendStreamFrame(sessionId, stream, text, 1)
      }
    } finally {
      stream.inFlight = false
      // A delta may have landed after the loop drained its last frame.
      if (!stream.failed && !stream.closing && stream.pending !== undefined) void this.drainStream(sessionId, stream)
    }
  }

  private async sendStreamFrame(
    sessionId: string,
    stream: StreamState,
    text: string,
    state: 1 | 10,
  ): Promise<boolean> {
    const target = this.targetOf(sessionId)
    if (target.kind !== 'c2c') return false
    const anchor = this.deps.routes.get(sessionId)
    const msgId = anchor?.lastMsgId
    if (msgId === undefined) return false
    try {
      const streamMsgId = await this.deps.api.sendStreamFrame(target.userId, {
        msgSeq: stream.msgSeq,
        index: stream.index,
        text,
        state,
        msgId,
        streamMsgId: stream.streamMsgId,
      })
      stream.index += 1
      stream.lastAccepted = text
      stream.lastSentAt = Date.now()
      stream.sentFrames += 1
      if (streamMsgId !== undefined && stream.streamMsgId === undefined) stream.streamMsgId = streamMsgId
      return true
    } catch (error) {
      stream.failed = true
      this.deps.log.warn('QQ stream frame failed; falling back to static delivery: %o', error)
      return false
    }
  }

  /**
   * Close a C2C stream with a DONE (input_state=10) frame, retrying a few
   * times: a lost DONE leaves the stream "sending" on QQ's side and the next
   * stream then fails with 40034021 ("其它流式消息发送中").
   */
  private async sendDoneFrame(sessionId: string, stream: StreamState, text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await this.sendStreamFrame(sessionId, stream, text, 10)) return
      if (attempt === 3) return
      this.deps.log.warn('QQ DONE frame attempt %d on %s failed; retrying', attempt, sessionId)
      await new Promise(resolve => setTimeout(resolve, 400 * attempt))
    }
  }

  /**
   * Wait for any in-flight frame, drop unsent candidates, then close the
   * stream with a DONE frame. Used at turn end and on external close so the
   * DONE frame never races a still-flying GENERATING frame of the same
   * stream (QQ treats that as a second concurrent stream, 40034021). The
   * `closing` flag is set FIRST: a drain loop sleeping on the throttle must
   * stop when it wakes, otherwise it would send one more frame against an
   * anchor the static delivery already consumed (QQ then answers
   * 40007 "已经提交的消息内容不可修改").
   */
  private async finishStream(sessionId: string, stream: StreamState, text: string): Promise<void> {
    stream.closing = true
    stream.pending = undefined
    while (stream.inFlight) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await this.sendDoneFrame(sessionId, stream, text)
  }

  // ── Static delivery with debounce ──────────────────────────────────────────

  private async onAssistantMessage(sessionId: string, text: string): Promise<void> {
    const stream = this.streams.get(sessionId)
    if (stream !== undefined && !stream.failed && stream.sentFrames > 0 && text.length > 0) {
      // The streamed bubble already shows this text: close it as DONE and let
      // the rendered content stand (QQ replace mode keeps the final frame).
      // `prefixMatches` means "incoming starts with accepted", so the accepted
      // prefix comes first and the full text second.
      if (prefixMatches(stream.lastAccepted, text) || stream.lastAccepted.startsWith(text)) {
        this.streams.delete(sessionId)
        await this.finishStream(sessionId, stream, text.length >= stream.lastAccepted.length ? text : stream.lastAccepted)
        return
      }
      // Diverged (model rewrote): finalize what was streamed, then send the
      // authoritative text as a static follow-up message.
      this.streams.delete(sessionId)
      await this.finishStream(sessionId, stream, stream.lastAccepted)
    }

    if (text.length === 0) return
    const window = this.deps.config.deliverWindowMs ?? 900
    const maxWait = this.deps.config.deliverMaxWaitMs ?? 6_000
    let buffer = this.buffers.get(sessionId)
    if (buffer === undefined) {
      buffer = { texts: [], firstAt: Date.now(), flushed: false }
      this.buffers.set(sessionId, buffer)
    }
    if (buffer.flushed) {
      buffer.texts = []
      buffer.firstAt = Date.now()
      buffer.flushed = false
    }
    buffer.texts.push(text)
    if (buffer.timer !== undefined) clearTimeout(buffer.timer)
    const elapsed = Date.now() - buffer.firstAt
    if (elapsed >= maxWait) {
      await this.flushBuffer(sessionId, false)
      return
    }
    buffer.timer = setTimeout(() => { void this.flushBuffer(sessionId, false) }, window)
  }

  private async flushBuffer(sessionId: string, final: boolean): Promise<void> {
    const buffer = this.buffers.get(sessionId)
    if (buffer === undefined) return
    if (buffer.timer !== undefined) {
      clearTimeout(buffer.timer)
      buffer.timer = undefined
    }
    if (buffer.texts.length === 0) return
    const text = buffer.texts.join('\n\n')
    buffer.texts = []
    buffer.flushed = true
    await this.sendStatic(sessionId, text)
    if (!final) return
  }

  /**
   * Immediately deliver any debounce-buffered assistant text for one session.
   * Called before a forwarded question is presented on QQ so the model's
   * preamble ("好的，我向你提问:") lands BEFORE the question, not after it.
   */
  async flushText(sessionId: string): Promise<void> {
    await this.flushBuffer(sessionId, false).catch((error: unknown) => {
      this.deps.log.warn('QQ flushText failed for %s: %o', sessionId, error)
    })
  }

  /** Send static text chunks with passive-anchor accounting. */
  private async sendStatic(sessionId: string, text: string): Promise<void> {
    const target = this.targetOf(sessionId)
    this.deps.log.info('QQ outbound: sendStatic %d chars to %s session=%s', text.length, target.kind, sessionId)
    const limit = this.deps.config.textChunkLimit ?? 4_000
    const chunks = chunkText(text, limit)
    for (const chunk of chunks) {
      const record = this.deps.routes.get(sessionId)
      const passive = record !== undefined
        ? this.deps.routes.consumePassive(
            sessionId,
            record.target.kind === 'group' ? 5 * 60 * 1000 : 30 * 60 * 1000,
            this.deps.config.replyPassiveLimit ?? 4,
          )
        : undefined
      try {
        await this.deps.api.sendText(target, chunk, passive)
      } catch (error) {
        this.deps.log.error('QQ reply send failed for %s: %o', sessionId, error)
        return
      }
    }
  }

  /** Flush everything on shutdown so pending merged texts are not lost. */
  async dispose(): Promise<void> {
    for (const sessionId of [...this.buffers.keys()]) {
      await this.flushBuffer(sessionId, true).catch(() => undefined)
    }
    this.buffers.clear()
    this.streams.clear()
  }

  // ── Approval answerer (registered per QQ agent scope) ─────────────────────

  /**
   * Register the QQ inline-keyboard approval answerer on one agent's scoped
   * context. Mirrors openclaw's three-button keyboard; "always allow" is
   * remembered in the persistent store and auto-answers future asks for the
   * same tool in the same QQ session.
   */
  registerApprovalAnswerer(agentCtx: Context, sessionId: string): void {
    if (this.deps.config.approval === false) return
    const onApproval = agentCtx.on as unknown as (
      name: 'approval/request',
      listener: (
        req: ApprovalRequestLike,
        next: () => Promise<ApprovalOutcome>,
      ) => Promise<ApprovalOutcome>,
    ) => () => void
    onApproval('approval/request', async (req, next) => {
      if (req.agent.id !== sessionId) return next()
      if (this.deps.alwaysAllow.allows(sessionId, req.toolName)) return 'allowed-once'

      const token = `${sessionId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const decision = new Promise<ApprovalOutcome | 'allow-always'>((resolve) => {
        this.pendingApprovals.set(token, {
          resolve: (choice) => resolve(choice === 'deny' ? 'rejected' : choice === 'allow-always' ? 'allow-always' : 'allowed-once'),
        })
      })
      const target = this.targetOf(sessionId)
      const anchor = this.deps.routes.get(sessionId)
      const passive = anchor !== undefined
        ? this.deps.routes.consumePassive(sessionId, 30 * 60 * 1000, 8)
        : undefined
      try {
        await this.deps.api.sendKeyboard(
          target,
          `⚠️ 需要审批：${req.toolName}\n${req.reason ?? '该操作需要你的确认。'}`,
          [
            { id: 'allow', label: '✅ 允许一次', visitedLabel: '已允许', style: 1, data: `dshqq:${token}:allow-once` },
            { id: 'always', label: '⭐ 始终允许', visitedLabel: '已始终允许', style: 1, data: `dshqq:${token}:allow-always` },
            { id: 'deny', label: '❌ 拒绝', visitedLabel: '已拒绝', style: 0, data: `dshqq:${token}:deny` },
          ],
          passive,
        )
      } catch (error) {
        this.deps.log.warn('approval keyboard send failed: %o', error)
        this.pendingApprovals.delete(token)
        return next()
      }

      const timeoutMs = this.deps.config.approvalTimeoutMs ?? 300_000
      const outcome = await this.raceDecision(decision, req, timeoutMs, token)
      if (outcome === 'allow-always') {
        this.deps.alwaysAllow.add(sessionId, req.toolName)
        return 'allowed-once'
      }
      return outcome
    })
  }

  private async raceDecision(
    decision: Promise<ApprovalOutcome | 'allow-always'>,
    req: ApprovalRequestLike,
    timeoutMs: number,
    token: string,
  ): Promise<ApprovalOutcome | 'allow-always'> {
    const timeout = new Promise<ApprovalOutcome | 'allow-always'>((resolve) => {
      setTimeout(() => resolve('rejected'), timeoutMs)
    })
    const aborted = new Promise<ApprovalOutcome | 'allow-always'>((resolve) => {
      req.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
    })
    try {
      const outcome = await Promise.race([decision, timeout, aborted])
      this.pendingApprovals.delete(token)
      return outcome
    } catch (error) {
      this.deps.log.warn('approval decision failed: %o', error)
      this.pendingApprovals.delete(token)
      return 'rejected'
    }
  }

  /** Resolve a pending approval from an INTERACTION_CREATE button press. */
  handleApprovalCallback(buttonData: string): ButtonDecision | undefined {
    const match = /^dshqq:(.+):(allow-once|allow-always|deny)$/.exec(buttonData)
    if (match === null) return undefined
    const token = match[1]
    const decision: ButtonDecision = match[2] as ButtonDecision
    const pending = this.pendingApprovals.get(token)
    if (pending === undefined) return undefined
    this.pendingApprovals.delete(token)
    pending.resolve(decision as ButtonDecision)
    return decision
  }
}
