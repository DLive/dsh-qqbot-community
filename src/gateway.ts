/**
 * QQ WebSocket gateway: identify with intents, heartbeat, session RESUME
 * (session_id + seq persisted across restarts), reconnect with backoff, and
 * dispatch op-0 events (messages, interactions, lifecycle) to registered
 * handlers.
 */
import WebSocket, { type RawData } from 'ws'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Config } from './types.js'
import { QQApi, type LogSink } from './qqapi.js'

export const INTENT = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
} as const

export const DEFAULT_INTENTS = INTENT.PUBLIC_GUILD_MESSAGES | INTENT.GROUP_AND_C2C

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

/** Persisted gateway session for RESUME (avoids event replay after restarts). */
interface PersistedSession {
  sessionId?: string
  seq?: number
}

export interface GatewayMessageHandler {
  (message: unknown, eventType: string): void
}

export interface GatewayInteractionHandler {
  (interaction: unknown): void
}

export interface GatewayHooks {
  onMessage: GatewayMessageHandler
  onInteraction: GatewayInteractionHandler
  onReady?: () => void
}

export class QQGateway {
  private socket: WebSocket | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private lastSequence: number | null = null
  private sessionId: string | undefined
  private resumeAttempted = false
  private reconnectAttempt = 0
  private connecting = false
  private disposed = false
  private sessionFile: string

  constructor(
    private readonly config: Config,
    private readonly api: QQApi,
    private readonly hooks: GatewayHooks,
    private readonly log: LogSink,
    sessionFile: string,
  ) {
    this.sessionFile = sessionFile
  }

  /** Load persisted session state and start the connection loop. */
  async start(): Promise<void> {
    try {
      const raw = await readFile(this.sessionFile, 'utf8')
      const parsed = JSON.parse(raw) as PersistedSession
      this.sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined
      this.lastSequence = typeof parsed.seq === 'number' ? parsed.seq : null
      this.resumeAttempted = this.sessionId !== undefined
    } catch {
      // First run or unreadable file: start a fresh session.
    }
    void this.api.ensureToken().then(() => { void this.connect() }, () => undefined)
  }

  dispose(): void {
    this.disposed = true
    this.clearHeartbeat()
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = undefined
  }

  private clearHeartbeat(): void {
    if (this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, delay)
  }

  private async persistSession(): Promise<void> {
    if (this.sessionId === undefined) return
    const payload = JSON.stringify({ sessionId: this.sessionId, seq: this.lastSequence })
    try {
      await mkdir(dirname(this.sessionFile), { recursive: true })
      await writeFile(this.sessionFile, payload, 'utf8')
    } catch (error) {
      this.log.warn('cannot persist QQ gateway session: %o', error)
    }
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.connecting) return
    let token: string
    try {
      token = await this.api.ensureToken()
    } catch {
      this.scheduleReconnect()
      return
    }
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return

    this.connecting = true
    try {
      const url = await this.api.gatewayUrl()
      const socket = new WebSocket(url)
      this.socket = socket
      socket.on('open', () => {
        this.log.info('QQ gateway connected')
        this.reconnectAttempt = 0
      })
      socket.on('message', (raw: RawData) => { this.handleFrame(raw, token) })
      socket.on('close', (code, reason) => {
        if (this.socket !== socket) return
        this.socket = undefined
        this.clearHeartbeat()
        if (this.disposed) return
        this.log.warn('QQ gateway closed (%s %s); reconnecting', code, reason.toString())
        this.scheduleReconnect()
      })
      socket.on('error', (error: Error) => { this.log.warn('QQ gateway error: %o', error) })
    } catch (error) {
      this.log.error('QQ gateway connect failed: %o', error)
      this.scheduleReconnect()
    } finally {
      this.connecting = false
    }
  }

  private handleFrame(raw: RawData, token: string): void {
    let payload: Record<string, unknown> | undefined
    try {
      payload = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch (error) {
      this.log.warn('ignoring malformed gateway frame: %o', error)
      return
    }
    if (payload === undefined || typeof payload.op !== 'number') return
    if (typeof payload.s === 'number') this.lastSequence = payload.s
    if (this.config.debug) this.log.debug?.('gateway op=%s t=%s', payload.op, payload.t)

    const op = payload.op
    if (op === 10) {
      const hello = payload.d as { heartbeat_interval?: number } | undefined
      const interval = typeof hello?.heartbeat_interval === 'number' ? hello.heartbeat_interval : 30_000
      this.clearHeartbeat()
      this.heartbeat = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ op: 1, d: this.lastSequence }))
        }
      }, interval)
      this.identifyOrResume(token)
      return
    }
    if (op === 7) {
      // Server-requested reconnect: drop the socket; the close handler retries.
      this.socket?.close()
      return
    }
    if (op === 9) {
      // Invalid session: discard session state and identify fresh.
      this.sessionId = undefined
      this.lastSequence = null
      this.resumeAttempted = false
      void this.persistSession()
      this.socket?.close()
      return
    }
    if (op !== 0 || typeof payload.t !== 'string') return

    const eventType = payload.t
    if (eventType === 'READY') {
      const ready = payload.d as { session_id?: string } | undefined
      if (typeof ready?.session_id === 'string') {
        this.sessionId = ready.session_id
        this.resumeAttempted = true
        void this.persistSession()
      }
      this.hooks.onReady?.()
      return
    }
    if (eventType === 'RESUMED') {
      this.log.info('QQ gateway resumed session seq=%s', this.lastSequence)
      this.hooks.onReady?.()
      return
    }
    if (eventType === 'INTERACTION_CREATE') {
      this.hooks.onInteraction(payload.d)
      return
    }
    if (
      eventType === 'C2C_MESSAGE_CREATE'
      || eventType === 'GROUP_AT_MESSAGE_CREATE'
      || eventType === 'AT_MESSAGE_CREATE'
      || eventType === 'DIRECT_MESSAGE_CREATE'
    ) {
      this.hooks.onMessage(payload.d, eventType)
    }
  }

  private identifyOrResume(token: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    const intents = this.config.intents ?? DEFAULT_INTENTS
    if (this.sessionId !== undefined && this.resumeAttempted) {
      // RESUME path: the persisted session_id/seq belong to one specific
      // AppID. Logging them (and the AppID) lets you spot "I switched AppIDs
      // but my gateway session file still points at the old one".
      this.log.info(
        'QQ gateway: resume op=6 (appId=%s session_id=%s seq=%s intents=%s)',
        this.config.id,
        this.sessionId,
        String(this.lastSequence),
        intents,
      )
      this.socket.send(JSON.stringify({
        op: 6,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSequence },
      }))
      return
    }
    // Fresh IDENTIFY path: print the intents mask we are about to subscribe
    // to. A bot that never receives events but connects fine usually has the
    // wrong mask here.
    this.log.info(
      'QQ gateway: identify op=2 (appId=%s intents=%s sandbox=%s)',
      this.config.id,
      intents,
      String(this.config.sandbox ?? true),
    )
    this.socket.send(JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents,
        shard: [0, 1],
      },
    }))
  }
}
