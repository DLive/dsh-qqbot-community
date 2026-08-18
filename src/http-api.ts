/**
 * Optional HTTP push API mounted on the DSH web server's `webServer` service.
 *
 * Two authenticated endpoints under one configurable prefix (default
 * `/external/qq`):
 *
 *   POST <prefix>/send      Push text to a QQ target through the same
 *                           `QQApi.sendText` path agent replies use. With
 *                           `record: true`, additionally injects a
 *                           model-visible record into the target's current
 *                           agent session (`agent.inject`, no wakeup) so the
 *                           model knows about the push without answering it.
 *   GET  <prefix>/channels  List every target the adapter has routed before
 *                           (deduped by target, newest activity first).
 *
 * The mount is a plain prefix registration on the host webServer — it never
 * touches the `/api` RPC channel. Bearer authentication is mandatory: the dsh
 * web server binds loopback by default and its request fence is not an auth
 * layer, so without a token any local process could drive the bot.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from './config.js'
import { chunkText } from './outbound.js'
import { effectiveSessionId } from './inbound.js'
import { targetKey, type ThreadStore } from './threadstore.js'
import type { RouteStore } from './store.js'
import type { LogSink, QQApi } from './qqapi.js'
import type { AgentLike, HttpApiConfig, ReplyTarget } from './types.js'

/** Request-body cap: pushes are text-only; 1 MiB is far beyond any sane chunk set. */
const BODY_LIMIT_BYTES = 1024 * 1024

/** Mount point: absolute path of URL-safe segments, no trailing slash. */
const PATH_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/

/** Channel shorthand: `c2c:<openid>` / `group:<openid>` / `channel:<id>`. */
const SHORTHAND_PATTERN = /^(c2c|group|channel):([A-Za-z0-9_-]+)$/

/** Full session-id form also accepted as shorthand: `qq:v2:<scope>:<id>[#n<k>]`. */
const SESSION_ID_PATTERN = /^qq:v2:(c2c|group|channel):([^:#]+?)(?:#n\d+)?$/

/** Dependencies the handler closes over; all owned by the composition root. */
export interface HttpApiDeps {
  /** Validated mount prefix (from {@link resolveHttpApiMount}). */
  readonly mountPath: string
  /** Bearer token every request must present. */
  readonly token: string
  /** Plugin config (chunk limit, markdown flag ride inside `api`). */
  readonly config: Config
  readonly log: LogSink
  readonly api: QQApi
  readonly routes: RouteStore
  readonly threads: ThreadStore
  /** Create-or-resume entry from the inbound pipeline (`record: true` path). */
  readonly ensureAgent: (sessionId: string) => Promise<AgentLike>
}

/** Validated mount facts for the `httpApi` config group. */
export interface HttpApiMount {
  readonly path: string
  readonly token: string
}

/**
 * Validate the `httpApi` config group and derive the mount point.
 * @throws when the token is missing/short or the path is malformed — an
 * explicitly requested API must fail the plugin load loudly, never silently
 * skip mounting.
 */
export function resolveHttpApiMount(httpApi: HttpApiConfig): HttpApiMount {
  const token = httpApi.token
  if (typeof token !== 'string' || token.length < 8) {
    throw new Error('qqbot-community: httpApi.token 缺失或过短（至少 8 个字符）')
  }
  const path = httpApi.path ?? '/external/qq'
  if (!PATH_PATTERN.test(path)) {
    throw new Error(
      `qqbot-community: httpApi.path ${JSON.stringify(path)} 必须是绝对路径（段内仅字母数字与 . _ ~ -），且不以 / 结尾`,
    )
  }
  return { path, token }
}

/** Constant-time Bearer check; length mismatch already leaks only the length. */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer (.+)$/.exec(header)
  if (match === null) return false
  const provided = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(token, 'utf8')
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

/** Body read failure categories mapped onto distinct HTTP statuses. */
class BodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message)
  }
}

/** Read and parse one JSON request body, enforcing the size cap. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = chunk as Buffer
    size += part.length
    if (size > BODY_LIMIT_BYTES) throw new BodyError(413, `请求体超过 ${BODY_LIMIT_BYTES} 字节上限`)
    chunks.push(part)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new BodyError(400, '请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyError(400, '请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/** Parse `channel` shorthand (`c2c:U` / `qq:v2:c2c:U#n1`) into a target. */
function parseShorthand(value: string): ReplyTarget | undefined {
  const short = SHORTHAND_PATTERN.exec(value)
  if (short !== null) {
    if (short[1] === 'c2c') return { kind: 'c2c', userId: short[2] }
    if (short[1] === 'group') return { kind: 'group', groupId: short[2] }
    return { kind: 'channel', channelId: short[2] }
  }
  const full = SESSION_ID_PATTERN.exec(value)
  if (full !== null) {
    if (full[1] === 'c2c') return { kind: 'c2c', userId: full[2] }
    if (full[1] === 'group') return { kind: 'group', groupId: full[2] }
    return { kind: 'channel', channelId: full[2] }
  }
  return undefined
}

/** Parse the request target: `channel` shorthand or a `target` object. */
function parseTarget(body: Record<string, unknown>): { ok: true; target: ReplyTarget } | { ok: false; error: string } {
  const channel = body.channel
  if (typeof channel === 'string') {
    const target = parseShorthand(channel)
    if (target === undefined) {
      return { ok: false, error: `channel ${JSON.stringify(channel)} 无法解析（期望 c2c:<openid> / group:<openid> / channel:<id> 或完整会话 id）` }
    }
    return { ok: true, target }
  }
  const raw = body.target
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const t = raw as Record<string, unknown>
    if (t.kind === 'c2c' && typeof t.userId === 'string' && t.userId.length > 0) return { ok: true, target: { kind: 'c2c', userId: t.userId } }
    if (t.kind === 'group' && typeof t.groupId === 'string' && t.groupId.length > 0) return { ok: true, target: { kind: 'group', groupId: t.groupId } }
    if (t.kind === 'channel' && typeof t.channelId === 'string' && t.channelId.length > 0) return { ok: true, target: { kind: 'channel', channelId: t.channelId } }
  }
  return { ok: false, error: '缺少有效目标：提供 channel 简写（如 "c2c:<openid>"）或 target 对象（{kind:"c2c",userId:...}）' }
}

/** Send one JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Stable per-target id used in the channels listing. */
function targetId(target: ReplyTarget): string {
  return target.kind === 'c2c' ? target.userId : target.kind === 'group' ? target.groupId : target.channelId
}

/** Model-facing text injected by `record: true`. */
function recordText(text: string): string {
  return '[HTTP 推送记录] 以下内容已通过 HTTP 推送接口直接送达本会话对应的 QQ 通道'
    + '（未经过你生成回复；用户询问时请基于此内容回答）：\n' + text
}

/** One channel row in the `GET <prefix>/channels` response. */
interface ChannelRow {
  kind: ReplyTarget['kind']
  id: string
  target: ReplyTarget
  currentSessionId: string
  lastActiveAt: number | undefined
}

/** Build the deduped, newest-first channel listing from the route store. */
function listChannels(deps: HttpApiDeps): ChannelRow[] {
  const byTarget = new Map<string, ChannelRow>()
  for (const { record } of deps.routes.entries()) {
    const key = targetKey(record.target)
    const row: ChannelRow = {
      kind: record.target.kind,
      id: targetId(record.target),
      target: record.target,
      currentSessionId: effectiveSessionId(record.target, deps.threads.current(key)),
      lastActiveAt: record.lastMsgAt,
    }
    const existing = byTarget.get(key)
    if (existing === undefined || (row.lastActiveAt ?? 0) >= (existing.lastActiveAt ?? 0)) {
      byTarget.set(key, row)
    }
  }
  return [...byTarget.values()].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
}

/** `POST <prefix>/send` handler body after auth and JSON parsing. */
async function handleSend(deps: HttpApiDeps, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const parsed = parseTarget(body)
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: parsed.error })
    return
  }
  const target = parsed.target
  const text = body.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    sendJson(res, 400, { ok: false, error: 'text 必须是非空字符串' })
    return
  }
  const msgId = body.msgId
  if (msgId !== undefined && typeof msgId !== 'string') {
    sendJson(res, 400, { ok: false, error: 'msgId（可选）必须是字符串：提供时各分段以该消息为被动锚点' })
    return
  }
  if (body.record !== undefined && typeof body.record !== 'boolean') {
    sendJson(res, 400, { ok: false, error: 'record（可选）必须是布尔值：true 时同时向当前会话注入一条不唤醒模型的记录' })
    return
  }

  const limit = deps.config.textChunkLimit ?? 4_000
  const chunks = chunkText(text, limit)
  const messageIds: (string | undefined)[] = []
  deps.log.info('httpApi send: kind=%s id=%s chars=%d chunks=%d passive=%s', target.kind, targetId(target), text.length, chunks.length, msgId !== undefined ? 'yes' : 'no')
  for (const chunk of chunks) {
    try {
      messageIds.push(await deps.api.sendText(target, chunk, msgId))
    } catch (error) {
      deps.log.error('httpApi send failed on chunk %d/%d: %o', messageIds.length + 1, chunks.length, error)
      sendJson(res, 502, {
        ok: false,
        error: `QQ 发送失败（第 ${messageIds.length + 1}/${chunks.length} 段）：${String(error instanceof Error ? error.message : error)}`,
        messageIds,
        chunksSent: messageIds.length,
      })
      return
    }
  }

  let recorded = false
  let recordError: string | undefined
  if (body.record === true) {
    try {
      const sessionId = effectiveSessionId(target, deps.threads.current(targetKey(target)))
      const agent = await deps.ensureAgent(sessionId)
      agent.inject({
        id: `qqpush:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: recordText(text) }],
        source: { kind: 'user', id: 'dsh-http-api', name: 'HTTP 推送 API' },
      })
      recorded = true
      deps.log.info('httpApi record: injected into %s', sessionId)
    } catch (error) {
      recordError = String(error instanceof Error ? error.message : error)
      deps.log.warn('httpApi record failed for %s: %o', targetId(target), error)
    }
  }
  sendJson(res, 200, { ok: true, messageIds, chunks: chunks.length, recorded, ...(recordError !== undefined ? { recordError } : {}) })
}

/**
 * Build the prefix-route handler for the webServer registration.
 * @param deps - mount facts plus the pipelines the endpoints drive.
 * @returns async handler owning the full response lifecycle under the prefix.
 */
export function createHttpApiHandler(deps: HttpApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (!authorized(req, deps.token)) {
      sendJson(res, 401, { ok: false, error: '未认证：缺少或错误的 Authorization: Bearer <token>' })
      return
    }
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: '无法解析的请求路径' })
      return
    }
    const suffix = pathname === deps.mountPath ? '' : pathname.slice(deps.mountPath.length)
    try {
      if (suffix === '' || suffix === '/') {
        sendJson(res, 200, {
          ok: true,
          endpoints: {
            send: `POST ${deps.mountPath}/send`,
            channels: `GET ${deps.mountPath}/channels`,
          },
        })
        return
      }
      if (suffix === '/send') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'send 只接受 POST' })
          return
        }
        const body = await readJsonBody(req)
        await handleSend(deps, res, body)
        return
      }
      if (suffix === '/channels') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'channels 只接受 GET' })
          return
        }
        sendJson(res, 200, { ok: true, channels: listChannels(deps) })
        return
      }
      sendJson(res, 404, { ok: false, error: `未知端点 ${JSON.stringify(suffix)}` })
    } catch (error) {
      if (error instanceof BodyError) {
        sendJson(res, error.status, { ok: false, error: error.message })
        return
      }
      deps.log.error('httpApi handler failure: %o', error)
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: `处理失败：${String(error instanceof Error ? error.message : error)}` })
      } else {
        res.destroy()
      }
    }
  }
}
