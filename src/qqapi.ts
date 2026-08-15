/**
 * QQ OpenAPI client: access-token lifecycle and every HTTP endpoint the
 * adapter uses — text/keyboard/typing/media messages (passive and active),
 * small and chunked media upload, C2C stream frames, interaction acks, and a
 * raw proxy for the agent-facing qq_api tool.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { Logger } from '@deepseek-ai/cordis'
import { MEDIA_TYPE, type Config, type MediaKind, type ReplyTarget } from './types.js'

const TOKEN_RETRY_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 300_000
/** QQ single-shot upload ceiling (base64 path); larger files go chunked. */
const MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 * 1024
/** Chunked-upload part-finish retry budget. */
const PART_FINISH_RETRIES = 3

/** A Logger-shaped sink; the adapter passes its cordis logger. */
export interface LogSink {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
  debug?(format: string, ...args: unknown[]): void
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** One frame of a C2C replace-mode stream session. */
export interface StreamFrame {
  /** Stream-unique sequence; QQ requires one msg_seq per stream session. */
  msgSeq: number
  /** 0-based frame index, advancing per frame. */
  index: number
  /** Full current text (replace semantics, not a delta). */
  text: string
  /** 1 = GENERATING, 10 = DONE. */
  state: 1 | 10
  /** Original inbound message id anchoring the stream. */
  msgId: string
  /** Assigned by QQ after the first accepted frame. */
  streamMsgId?: string
}

export class QQApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'QQApiError'
  }
}

/** Per-target message sequence in the 0..65535 range (QQ requirement). */
export function nextMsgSeq(): number {
  const timePart = Date.now() % 100_000_000
  const random = Math.floor(Math.random() * 65_536)
  return (timePart ^ random) % 65_536
}

export class QQApi {
  private token: string | undefined
  private tokenRefresh: Promise<string> | undefined
  private refreshTimer: NodeJS.Timeout | undefined
  private disposed = false
  private readonly onTokenReady?: () => void

  /** Effective OpenAPI base URL with the sandbox host prefix applied once. */
  readonly endpoint: string

  constructor(
    private readonly config: Config,
    private readonly log: LogSink,
    hooks?: { onTokenReady?: () => void },
  ) {
    const raw = (config.endpoint ?? 'https://api.sgroup.qq.com').replace(/\/+$/, '')
    this.endpoint = (config.sandbox ?? true) ? raw.replace(/^(https?:\/\/)/, '$1sandbox.') : raw
    this.onTokenReady = hooks?.onTokenReady
  }

  private resolveEndpoint(): string {
    return this.endpoint
  }

  get isDisposed(): boolean { return this.disposed }

  dispose(): void {
    this.disposed = true
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
  }

  /** Obtain a valid access token, refreshing when missing. */
  async ensureToken(): Promise<string> {
    if (this.token !== undefined) return this.token
    if (this.tokenRefresh === undefined) {
      this.tokenRefresh = this.refreshToken().finally(() => { this.tokenRefresh = undefined })
    }
    return this.tokenRefresh
  }

  private async refreshToken(): Promise<string> {
    if (this.disposed) throw new Error('QQApi disposed')
    const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.config.id, clientSecret: this.config.secret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const data = asRecord(await response.json().catch(() => undefined))
    if (!response.ok || typeof data?.access_token !== 'string') {
      throw new QQApiError(`token request failed: HTTP ${response.status}`, response.status, data)
    }
    this.token = data.access_token
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 300
    this.scheduleRefresh(Math.max(60, expiresIn - 60) * 1_000)
    this.onTokenReady?.()
    return this.token
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.disposed) return
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this.token = undefined
      void this.ensureToken().catch((error: unknown) => {
        this.log.error('QQ token refresh failed: %o', error)
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined
          this.token = undefined
          void this.ensureToken().catch(() => undefined)
        }, TOKEN_RETRY_MS)
      })
    }, delayMs)
  }

  /** Authenticated raw request used by every method and by the qq_api tool. */
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options?: { query?: Record<string, string>; timeoutMs?: number },
  ): Promise<unknown> {
    const token = await this.ensureToken()
    const url = new URL(`${this.resolveEndpoint()}${path}`)
    for (const [key, value] of Object.entries(options?.query ?? {})) url.searchParams.set(key, value)
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(options?.timeoutMs ?? REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    if (!response.ok) {
      throw new QQApiError(
        `QQ ${method} ${path} failed: HTTP ${response.status} ${text.slice(0, 300)}`,
        response.status,
        parsed,
      )
    }
    return parsed
  }

  // ── Message senders ────────────────────────────────────────────────────────

  private messagePath(target: ReplyTarget, msgId: string | undefined): { path: string; body: Record<string, unknown> } {
    const path = target.kind === 'c2c'
      ? `/v2/users/${target.userId}/messages`
      : target.kind === 'group'
        ? `/v2/groups/${target.groupId}/messages`
        : `/channels/${target.channelId}/messages`
    return { path, body: msgId !== undefined ? { msg_id: msgId } : {} }
  }

  /** Send a plain or markdown text; returns the message id. */
  async sendText(target: ReplyTarget, text: string, passiveMsgId?: string): Promise<string | undefined> {
    const { path, body } = this.messagePath(target, passiveMsgId)
    const payload = this.config.markdown
      ? { ...body, msg_type: 2, markdown: { content: text }, msg_seq: nextMsgSeq() }
      : { ...body, msg_type: 0, content: text, msg_seq: nextMsgSeq() }
    const result = asRecord(await this.request('POST', path, payload))
    return typeof result?.id === 'string' ? result.id : undefined
  }

  /** Send a text with an inline keyboard (approval buttons). */
  async sendKeyboard(
    target: ReplyTarget,
    text: string,
    buttons: readonly { id: string; label: string; visitedLabel: string; style: 0 | 1; data: string }[],
    passiveMsgId?: string,
  ): Promise<void> {
    const { path, body } = this.messagePath(target, passiveMsgId)
    await this.request('POST', path, {
      ...body,
      msg_type: 0,
      content: text,
      msg_seq: nextMsgSeq(),
      keyboard: {
        content: {
          rows: [{
            buttons: buttons.map((button) => ({
              id: button.id,
              render_data: { label: button.label, visited_label: button.visitedLabel, style: button.style },
              action: { type: 1, data: button.data, permission: { type: 2 }, click_limit: 1 },
              group_id: 'dshqq',
            })),
          }],
        },
      },
    })
  }

  /** Send the C2C typing indicator (valid ~60s; callers keep it alive). */
  async sendTyping(target: ReplyTarget, passiveMsgId: string | undefined, seconds = 60): Promise<void> {
    if (target.kind !== 'c2c' || passiveMsgId === undefined) return
    await this.request('POST', `/v2/users/${target.userId}/messages`, {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: seconds },
      msg_seq: nextMsgSeq(),
      msg_id: passiveMsgId,
    }).catch((error: unknown) => {
      // Typing is best-effort; QQ rejects it for stale anchors.
      this.log.debug?.('typing send skipped: %o', error)
    })
  }

  /** Acknowledge an INTERACTION_CREATE event after resolving its button. */
  async ackInteraction(interactionId: string, code = 0): Promise<void> {
    await this.request('PUT', `/interactions/${interactionId}`, { code })
  }

  // ── Media upload & send ────────────────────────────────────────────────────

  private uploadPath(target: ReplyTarget, suffix: string): string {
    const base = target.kind === 'c2c'
      ? `/v2/users/${target.userId}`
      : target.kind === 'group'
        ? `/v2/groups/${target.groupId}`
        : `/channels/${target.channelId}`
    return `${base}/${suffix}`
  }

  /**
   * Upload one media object and send it as a message.
   * `source` may be an https URL, a data: URL, or an absolute local path
   * (large local files automatically use the chunked pipeline).
   */
  async sendMedia(
    target: ReplyTarget,
    kind: MediaKind,
    source: string,
    options?: { text?: string; passiveMsgId?: string; fileName?: string },
  ): Promise<{ fileId?: string }> {
    const { path, body } = this.messagePath(target, options?.passiveMsgId)

    // Guild channels have no files endpoint: images post through the message
    // body's `image` URL field; other kinds fall back to a descriptive text.
    if (target.kind === 'channel') {
      if (kind === 'image' && /^https?:\/\//.test(source)) {
        const result = asRecord(await this.request('POST', path, {
          ...body,
          content: options?.text ?? '',
          image: source,
        }, { timeoutMs: REQUEST_TIMEOUT_MS }))
        const id = asRecord(result?.ext_info)
        return { fileId: typeof id?.ref_idx === 'string' ? id.ref_idx : undefined }
      }
      throw new QQApiError(
        `guild-channel media only supports images via https URL (got ${kind}: ${source.slice(0, 60)})`,
        0,
        undefined,
      )
    }

    const file = await this.resolveMediaSource(target, source, kind)
    const payload = {
      ...body,
      msg_type: 7,
      media: { file_info: file.fileInfo },
      msg_seq: nextMsgSeq(),
      ...(options?.text !== undefined && options.text.length > 0 ? { content: options.text } : {}),
    }
    const result = asRecord(await this.request('POST', path, payload, { timeoutMs: UPLOAD_TIMEOUT_MS }))
    const id = asRecord(result?.ext_info)
    return { fileId: typeof id?.ref_idx === 'string' ? id.ref_idx : undefined }
  }

  private async resolveMediaSource(
    target: ReplyTarget,
    source: string,
    kind: MediaKind,
  ): Promise<{ fileInfo: string }> {
    if (source.startsWith('https://') || source.startsWith('http://')) {
      return this.directUpload(target, kind, { url: source })
    }
    if (source.startsWith('data:')) {
      const comma = source.indexOf(',')
      const base64 = comma >= 0 ? source.slice(comma + 1) : source
      return this.directUpload(target, kind, { fileData: base64, fileName: 'upload' })
    }
    // Local path: read size to choose direct vs chunked.
    const info = await stat(source)
    if (info.size <= MAX_DIRECT_UPLOAD_BYTES) {
      const data = await readFile(source)
      return this.directUpload(target, kind, {
        fileData: data.toString('base64'),
        fileName: source.split('/').pop() ?? 'file',
      })
    }
    return this.chunkedUpload(target, kind, source)
  }

  /** Small-file upload: POST url or base64 body to the files endpoint. */
  private async directUpload(
    target: ReplyTarget,
    kind: MediaKind,
    input: { url?: string; fileData?: string; fileName?: string },
  ): Promise<{ fileInfo: string }> {
    const body: Record<string, unknown> = {
      file_type: MEDIA_TYPE[kind],
      srv_send_msg: false,
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.fileData !== undefined ? { file_data: input.fileData } : {}),
      ...(kind === 'file' && input.fileName !== undefined ? { file_name: input.fileName } : {}),
    }
    const result = asRecord(await this.request(
      'POST',
      this.uploadPath(target, 'files'),
      body,
      { timeoutMs: UPLOAD_TIMEOUT_MS },
    ))
    if (typeof result?.file_info !== 'string') {
      throw new QQApiError('media upload returned no file_info', 0, result)
    }
    return { fileInfo: result.file_info }
  }

  /**
   * Chunked upload for large local files:
   * upload_prepare (hashes) → PUT parts to presigned URLs → upload_part_finish
   * → complete. Concurrency follows the prepare response (capped at 10).
   */
  private async chunkedUpload(
    target: ReplyTarget,
    kind: MediaKind,
    filePath: string,
  ): Promise<{ fileInfo: string }> {
    const fileSize = (await stat(filePath)).size
    const fileName = filePath.split('/').pop() ?? 'file'
    const { md5, sha1, md5TenM } = await hashFile(filePath)
    const prepare = asRecord(await this.request(
      'POST',
      this.uploadPath(target, 'upload_prepare'),
      {
        file_type: MEDIA_TYPE[kind],
        file_name: fileName,
        file_size: fileSize,
        md5,
        sha1,
        md5_10m: md5TenM,
      },
      { timeoutMs: UPLOAD_TIMEOUT_MS },
    ))
    const uploadId = typeof prepare?.upload_id === 'string' ? prepare.upload_id : undefined
    const parts = Array.isArray(prepare?.parts) ? prepare!.parts as readonly { index: number; presigned_url: string }[] : undefined
    const blockSize = typeof prepare?.block_size === 'number' ? prepare.block_size : undefined
    if (uploadId === undefined || parts === undefined || blockSize === undefined || blockSize <= 0) {
      throw new QQApiError('upload_prepare returned an unusable payload', 0, prepare)
    }
    const concurrency = Math.min(typeof prepare?.concurrency === 'number' ? prepare.concurrency : 1, 10)

    let cursor = 0
    const failures: unknown[] = []
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const slot = cursor++
        if (slot >= parts.length || failures.length > 0) return
        const part = parts[slot]
        try {
          await this.uploadPart(filePath, part.index, blockSize, fileSize, part.presigned_url, target, uploadId)
        } catch (error) {
          failures.push(error)
          return
        }
      }
    })
    await Promise.all(workers)
    if (failures.length > 0) throw failures[0]

    const complete = asRecord(await this.request(
      'POST',
      this.uploadPath(target, 'files'),
      { upload_id: uploadId },
      { timeoutMs: UPLOAD_TIMEOUT_MS },
    ))
    if (typeof complete?.file_info !== 'string') {
      throw new QQApiError('chunked complete returned no file_info', 0, complete)
    }
    return { fileInfo: complete.file_info }
  }

  private async uploadPart(
    filePath: string,
    partIndex: number,
    blockSize: number,
    fileSize: number,
    presignedUrl: string,
    target: ReplyTarget,
    uploadId: string,
  ): Promise<void> {
    const offset = (partIndex - 1) * blockSize
    const length = Math.min(blockSize, fileSize - offset)
    const handle = await readFile(filePath)
    const partBuffer = handle.subarray(offset, offset + length)
    const md5 = createHash('md5').update(partBuffer).digest('hex')

    const put = await fetch(presignedUrl, {
      method: 'PUT',
      body: partBuffer,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
    if (!put.ok) throw new QQApiError(`part ${partIndex} PUT failed: HTTP ${put.status}`, put.status, undefined)

    let attempt = 0
    for (;;) {
      try {
        await this.request(
          'POST',
          this.uploadPath(target, 'upload_part_finish'),
          { upload_id: uploadId, part_index: partIndex, block_size: length, md5 },
          { timeoutMs: UPLOAD_TIMEOUT_MS },
        )
        return
      } catch (error) {
        attempt += 1
        if (attempt > PART_FINISH_RETRIES) throw error
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
      }
    }
  }

  // ── C2C streaming ──────────────────────────────────────────────────────────

  /** Send one replace-mode stream frame; returns the assigned stream msg id. */
  async sendStreamFrame(userId: string, frame: StreamFrame): Promise<string | undefined> {
    const body: Record<string, unknown> = {
      input_mode: 'replace',
      input_state: frame.state,
      content_type: 'markdown',
      content_raw: frame.text,
      event_id: frame.msgId,
      msg_id: frame.msgId,
      msg_seq: frame.msgSeq,
      index: frame.index,
    }
    if (frame.streamMsgId !== undefined) body.stream_msg_id = frame.streamMsgId
    const result = asRecord(await this.request(
      'POST',
      `/v2/users/${userId}/stream_messages`,
      body,
      { timeoutMs: REQUEST_TIMEOUT_MS },
    ))
    return typeof result?.id === 'string' ? result.id : undefined
  }

  /** Fetch the WebSocket gateway URL. */
  async gatewayUrl(): Promise<string> {
    const result = asRecord(await this.request('GET', '/gateway'))
    if (typeof result?.url !== 'string') throw new QQApiError('gateway response missing url', 0, result)
    return result.url
  }
}

/** File digests required by upload_prepare: md5, sha1, and md5 of the first ~10MB. */
async function hashFile(filePath: string): Promise<{ md5: string; sha1: string; md5TenM: string }> {
  const data = await readFile(filePath)
  const tenM = 10_002_432
  return {
    md5: createHash('md5').update(data).digest('hex'),
    sha1: createHash('sha1').update(data).digest('hex'),
    md5TenM: createHash('md5').update(data.subarray(0, tenM)).digest('hex'),
  }
}

/** Type re-export so index.ts can build the plugin logger sink once. */
export type { Logger }
