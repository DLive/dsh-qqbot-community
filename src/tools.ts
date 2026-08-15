/**
 * Agent-scoped QQ tools, registered inside each QQ agent's `setup` so only
 * QQ sessions see them: media sending (image/voice/video/file from a local
 * path or URL) and a raw QQ OpenAPI proxy mirroring openclaw's
 * qqbot_platform_api.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MediaKind, ReplyTarget, ToolRegistryService } from './types.js'
import type { QQApi } from './qqapi.js'
import { targetOfSession, SESSION_PREFIX } from './inbound.js'

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico'])
const VOICE_EXTS = new Set(['.wav', '.mp3', '.silk', '.amr', '.ogg', '.flac', '.aac', '.m4a'])
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'])

export function inferMediaKind(source: string, mimeHint?: string): MediaKind {
  if (mimeHint !== undefined) {
    if (mimeHint.startsWith('image/')) return 'image'
    if (mimeHint.startsWith('audio/')) return 'voice'
    if (mimeHint.startsWith('video/')) return 'video'
    if (mimeHint === 'application/octet-stream' || mimeHint.startsWith('text/')) return 'file'
  }
  const ext = source.slice(source.lastIndexOf('.')).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VOICE_EXTS.has(ext)) return 'voice'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}

export function registerQQTools(
  agentCtx: Context,
  sessionId: string,
  api: QQApi,
  routeTarget: () => ReplyTarget | undefined,
): void {
  const tools = (agentCtx as unknown as { tools?: ToolRegistryService }).tools
  if (tools === undefined) return
  const target = (): ReplyTarget => routeTarget() ?? targetOfSession(sessionId)

  tools.register({
    name: 'qq_send_media',
    description:
      'Send an image, voice, video, or file message to the current QQ chat. '
      + 'Accepts an https URL, a data: URL, or an absolute local file path '
      + '(files larger than 10MB upload through the chunked pipeline automatically). '
      + 'Use this instead of pasting image URLs as text when the user asks for a media message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'https URL, data: URL, or absolute local file path of the media.' },
        kind: { type: 'string', enum: ['image', 'voice', 'video', 'file'], description: 'Media kind; inferred from the extension when omitted.' },
        text: { type: 'string', description: 'Optional caption sent alongside the media.' },
      },
      required: ['source'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          kind: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['sent', 'kind'],
      },
      render: (_args, value) => {
        const record = value as { sent?: boolean; kind?: string; error?: string }
        const text = record?.sent === true
          ? `已发送${record.kind ?? '媒体'}消息`
          : `媒体发送失败: ${record?.error ?? 'unknown error'}`
        return [{ type: 'text', text }]
      },
    },
    timeoutMs: 300_000,
    async execute(args) {
      const input = args as { source: string; kind?: MediaKind; text?: string }
      const kind = input.kind ?? inferMediaKind(input.source)
      try {
        await api.sendMedia(target(), kind, input.source, { text: input.text })
        return { sent: true, kind }
      } catch (error) {
        return { sent: false, kind, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  tools.register({
    name: 'qq_api',
    description:
      'Proxy any QQ Open Platform REST API call (guild/channel management, '
      + 'announcements, schedules, group info, member queries) with automatic '
      + 'access-token injection. Base URL is already configured; pass only the path, '
      + 'e.g. "/users/@me/guilds". Query values must be strings.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'API path starting with "/". Must not contain ".." or "//".' },
        body: { type: 'object', description: 'JSON body for POST/PUT/PATCH.' },
        query: { type: 'object', additionalProperties: { type: 'string' }, description: 'URL query parameters.' },
      },
      required: ['method', 'path'],
    },
    output: {
      // Unconstrained lossless JSON (empty annotation-only node) — DSH rejects
      // `{ type: 'json' }` as an unsupported JSON schema type.
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const input = args as { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body?: Record<string, unknown>; query?: Record<string, string> }
      if (!input.path.startsWith('/') || input.path.includes('..') || input.path.includes('//')) {
        throw new Error(`invalid path: ${input.path}`)
      }
      void exec
      return await api.request(input.method, input.path, input.body, { query: input.query })
    },
  })
}

/** Session-id guard helper shared by index.ts wiring. */
export function isQQSession(sessionId: string): boolean {
  return sessionId.startsWith(`${SESSION_PREFIX}:`)
}
