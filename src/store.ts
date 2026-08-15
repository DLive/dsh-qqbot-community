/**
 * Small durable JSON stores for the adapter: per-session reply routes
 * (target + passive-reply anchor) and the approval always-allow rules.
 * Both write atomically (tmp + rename) and tolerate absent files.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ReplyTarget, RouteRecord } from './types.js'

/** Routes file payload: `<sessionId> → RouteRecord`. */
type RoutesPayload = Record<string, RouteRecord>

/** Always-allow payload: `<sessionId> → toolName[]`. */
type AlwaysAllowPayload = Record<string, string[]>

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value), 'utf8')
  await rename(tmp, file)
}

/** Reply routing with passive-reply accounting. */
export class RouteStore {
  private routes: RoutesPayload = {}
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.routes = await readJson<RoutesPayload>(this.file, {})
  }

  /** Record an inbound message as the newest passive-reply anchor. */
  anchor(sessionId: string, target: ReplyTarget, msgId: string): void {
    this.routes[sessionId] = { target, lastMsgId: msgId, lastMsgAt: Date.now(), used: 0 }
    this.flush()
  }

  /** Ensure a route exists for proactive sends (schedule reminders). */
  ensure(sessionId: string, target: ReplyTarget): void {
    if (this.routes[sessionId] === undefined) {
      this.routes[sessionId] = { target }
      this.flush()
    }
  }

  get(sessionId: string): RouteRecord | undefined {
    return this.routes[sessionId]
  }

  /**
   * Consume a passive-reply anchor: returns the inbound msg id while the
   * window is open and under the reply budget, otherwise undefined (send as
   * an active message). Each consumption bumps the counter.
   */
  consumePassive(sessionId: string, ttlMs: number, limit: number): string | undefined {
    const record = this.routes[sessionId]
    if (
      record === undefined
      || record.lastMsgId === undefined
      || record.lastMsgAt === undefined
      || (record.used ?? 0) >= limit
      || Date.now() - record.lastMsgAt > ttlMs
    ) return undefined
    record.used = (record.used ?? 0) + 1
    return record.lastMsgId
  }

  /** Drop the passive anchor so later sends go active (e.g. after flushing). */
  clearPassive(sessionId: string): void {
    const record = this.routes[sessionId]
    if (record?.lastMsgId !== undefined) {
      record.lastMsgId = undefined
      record.lastMsgAt = undefined
      record.used = 0
      this.flush()
    }
  }

  private flush(): void {
    this.writing = this.writing.then(
      () => writeJsonAtomic(this.file, this.routes),
      () => writeJsonAtomic(this.file, this.routes),
    )
  }
}

/** Approval "always allow" rules, persisted per QQ session. */
export class AlwaysAllowStore {
  private rules: AlwaysAllowPayload = {}
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.rules = await readJson<AlwaysAllowPayload>(this.file, {})
  }

  allows(sessionId: string, toolName: string): boolean {
    return this.rules[sessionId]?.includes(toolName) === true
  }

  add(sessionId: string, toolName: string): void {
    const list = this.rules[sessionId] ?? []
    if (!list.includes(toolName)) {
      this.rules[sessionId] = [...list, toolName]
      this.flush()
    }
  }

  clear(sessionId?: string): number {
    let removed = 0
    if (sessionId === undefined) {
      removed = Object.keys(this.rules).length
      this.rules = {}
    } else {
      removed = (this.rules[sessionId]?.length ?? 0)
      delete this.rules[sessionId]
    }
    this.flush()
    return removed
  }

  list(sessionId: string): readonly string[] {
    return this.rules[sessionId] ?? []
  }

  private flush(): void {
    this.writing = this.writing.then(
      () => writeJsonAtomic(this.file, this.rules),
      () => writeJsonAtomic(this.file, this.rules),
    )
  }
}
