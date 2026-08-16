/**
 * Shared types for the QQ adapter: plugin config, reply routing, gateway
 * event payload shapes, and local declarations of the DSH host services the
 * adapter consumes. The adapter is loaded via `file://` outside the DSH
 * workspace, so every cross-package type is re-declared here structurally.
 */
import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'

// ─────────────────────────────────────────────────────────────────────────────
// Plugin configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface SttConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface Config {
  id: string
  secret: string
  sandbox?: boolean
  endpoint?: string
  intents?: number
  provider?: string
  model?: string
  cwd?: string
  /**
   * Agent preset id used when this plugin creates/resumes a session.
   * Omit (or pass `undefined`) to fall back to `ctx.agentPresets.defaultId`.
   * The preset supplies the agent's tools, prompt sections, and skill
   * catalog; without it the agent runs on an empty global layer and only
   * the per-session QQ tools (`qq_send_media`, `qq_api`) are visible.
   * Persisted into the session header so resume restores the same preset.
   */
  agentPreset?: string
  debug?: boolean
  /** C2C sender openids allowed to use the bot; '*' wildcard; empty = allow all. */
  allowFrom?: string[]
  /** Group openids allowed to use the bot; '*' wildcard; empty = allow all. */
  groupAllowFrom?: string[]
  /** Send replies as markdown (msg_type 2). Requires approved markdown permission. */
  markdown?: boolean
  /** Maximum characters per static reply chunk. */
  textChunkLimit?: number
  /** Send the C2C typing indicator while the agent is working. */
  typing?: boolean
  /** Stream C2C replies token-by-token via stream_messages (replace mode). */
  streaming?: boolean
  /** Minimum interval between stream frames. */
  streamThrottleMs?: number
  /** Merge consecutive assistant texts inside one turn for this long. */
  deliverWindowMs?: number
  /** Never hold a merged reply longer than this. */
  deliverMaxWaitMs?: number
  /** Passive replies allowed per inbound message before falling back to active. */
  replyPassiveLimit?: number
  /** Download inbound non-image attachments into <cwd>/.qq-media. */
  mediaDownload?: boolean
  /** Optional speech-to-text for inbound voice (OpenAI-compatible). */
  stt?: SttConfig
  /** Register the QQ inline-keyboard approval answerer for QQ agents. */
  approval?: boolean
  /** How long to wait for an approval button press. */
  approvalTimeoutMs?: number
  /** Intercept /help /ping /me /approve /always commands before the agent. */
  slashCommands?: boolean
}

export type ConfigSchema = Schema<Config>

// ─────────────────────────────────────────────────────────────────────────────
// QQ protocol types (subset used by this adapter)
// ─────────────────────────────────────────────────────────────────────────────

/** Media file type codes for the QQ rich-media API. */
export const MEDIA_TYPE = {
  image: 1,
  video: 2,
  voice: 3,
  file: 4,
} as const

export type MediaKind = keyof typeof MEDIA_TYPE

/** Where a reply goes: the three QQ conversation surfaces. */
export type ReplyTarget =
  | { readonly kind: 'channel'; readonly channelId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'c2c'; readonly userId: string }

/** One inbound attachment as pushed by QQ. */
export interface InboundAttachment {
  readonly content_type: string
  readonly url: string
  readonly filename?: string
  /** QQ server-side WAV conversion of a voice message. */
  readonly voice_wav_url?: string
  /** QQ built-in speech recognition text. */
  readonly asr_refer_text?: string
}

/** One entry of the `msg_elements` array (quoted-message content). */
export interface InboundMsgElement {
  readonly msg_idx?: string
  readonly content?: string
  readonly attachments?: readonly InboundAttachment[]
}

export interface MentionEntry {
  readonly id?: string
  readonly user_openid?: string
  readonly member_openid?: string
  readonly nickname?: string
  readonly username?: string
  readonly is_you?: boolean
  readonly bot?: boolean
}

/** Normalized inbound message across C2C / group / guild channel scopes. */
export interface IncomingMessage {
  readonly id: string
  readonly kind: 'c2c' | 'group' | 'channel'
  readonly content: string
  readonly senderId: string
  readonly senderName?: string
  readonly timestamp: string
  /** Message index used for quote resolution (`msg_idx`), when present. */
  readonly msgIdx?: string
  /** Index of the quoted message (`ref_msg_idx`), when replying. */
  readonly refMsgIdx?: string
  readonly msgType?: number
  readonly attachments: readonly InboundAttachment[]
  readonly msgElements: readonly InboundMsgElement[]
  readonly mentions: readonly MentionEntry[]
  readonly reply: ReplyTarget
}

/** INTERACTION_CREATE payload (button callbacks). */
export interface InteractionEvent {
  readonly id: string
  readonly data?: {
    readonly type?: number
    readonly resolved?: {
      readonly button_data?: string
      readonly button_id?: string
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reply routing
// ─────────────────────────────────────────────────────────────────────────────

/** Passive-reply window per scope (QQ: group 5min, C2C 30min). */
export const PASSIVE_TTL_MS: Record<ReplyTarget['kind'], number> = {
  group: 5 * 60 * 1000,
  c2c: 30 * 60 * 1000,
  channel: 5 * 60 * 1000,
}

/**
 * Durable per-session routing state: where replies go and which inbound
 * message may still be used as a passive-reply anchor.
 */
export interface RouteRecord {
  readonly target: ReplyTarget
  /** Latest inbound message id usable for passive replies. */
  lastMsgId?: string
  lastMsgAt?: number
  /** Passive replies already sent against `lastMsgId`. */
  used?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Local declarations of consumed DSH host services (structural)
// ─────────────────────────────────────────────────────────────────────────────

export interface ContentBlockLike {
  readonly type: string
  readonly text?: string
  readonly attachment?: {
    readonly attachmentId: string
    readonly mediaType: string
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }
}

export interface UserMessageLike {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly ContentBlockLike[]
  readonly source: { readonly kind: 'user'; readonly id: string; readonly name: string }
}

export interface AgentLike {
  readonly id: string
  readonly ctx: Context
  send(message: UserMessageLike, target: 'next-turn' | 'next-step', wakeup: boolean): void
  cancel(cause: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' }): void
}

export interface AgentSetupLike {
  (agentCtx: Context): void | Promise<void>
}

export interface AgentRegistryService {
  get(sessionId: string): AgentLike | undefined
  create(options: {
    sessionId: string
    agentOptions: { provider?: string | undefined; model?: string | undefined }
    meta?: { cwd?: string | undefined }
    setup?: AgentSetupLike
  }): Promise<{ agent: AgentLike }>
  resume(options: {
    resumeSessionId: string
    agentOptions: { provider?: string | undefined; model?: string | undefined }
    setup?: AgentSetupLike
  }): Promise<{ agent: AgentLike }>
}

export interface PersistedSessionMeta {
  readonly id: string
  readonly cwd?: string | undefined
  readonly createdAt: number
  readonly version: number
}

export interface SessionPersistenceService {
  inspect(id: string, signal?: AbortSignal): Promise<{ meta: PersistedSessionMeta; events: readonly unknown[] }>
}

export interface WorkspaceRegistryService {
  create(path: string, title?: string): Promise<WorkspaceLike>
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
}

export interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  attachSession(sessionId: string): Promise<void>
}

export interface ImageAttachmentRefLike {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

export interface AttachmentStoreService {
  validateImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<void>
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRefLike>
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalRequestLike {
  readonly agent: { readonly id: string }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export interface ApprovalServiceLike {
  setPolicy(agent: { id: string } & object, policy: 'ask' | 'never'): void
}

/**
 * Structural view of a `ctx.agentPresets.list()` row — the subset the QQ
 * adapter reads for `/new <preset>` validation and `/presets` display.
 */
export interface AgentPresetRowLike {
  readonly id: string
  readonly name?: string
  /** Why this preset cannot compose a session, absent when it can. */
  readonly broken?: string
}

/**
 * Structural view of `ctx.agentPresets` — the subset the QQ adapter needs.
 * `mount()` joins an agent's scope to a preset's standing composition; a
 * rejection here rolls the unpublished agent back via the factory's
 * rollback-covered publication boundary, so a broken preset never yields a
 * half-composed session.
 */
export interface AgentPresetsLike {
  /** Mount the named preset (or the user-default when `id` is omitted). */
  mount(agentCtx: Context, id?: string): Promise<{ readonly id: string }>
  /** Resolve `undefined` to the configured default preset id. */
  resolve(id?: string): Promise<{ readonly id: string }>
  /** Every preset the configured roots currently supply (first-root-wins per id). */
  list(): Promise<readonly AgentPresetRowLike[]>
}

export interface ToolRegistryService {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly output: {
      readonly schema: Record<string, unknown>
      render(args: unknown, value: unknown): readonly { readonly type: string; readonly text: string }[]
    }
    execute(args: unknown, exec: { readonly signal: AbortSignal; readonly agent?: { readonly id: string } }): Promise<unknown>
    readonly timeoutMs?: number
  }): () => void
}

/** Session event payload shapes the outbound pipeline reads. */
export interface SessionEventShape {
  readonly type: string
  readonly data: {
    readonly turn?: number
    readonly chunk?: { readonly type: string; readonly index?: number; readonly text?: string }
    readonly message?: { readonly content?: readonly ContentBlockLike[] }
  }
}

export interface SessionShape {
  readonly id: string
}
