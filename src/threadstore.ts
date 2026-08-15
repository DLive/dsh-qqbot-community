/**
 * Per-target conversation-thread counter.
 *
 * Each QQ target (c2c user / group / channel) starts on an implicit "thread
 * zero" that reuses the bare `qq:v2:<scope>:<id>` session id. The `/new`
 * slash command atomically bumps this counter, which makes the next inbound
 * message resolve to a fresh session id (e.g. `qq:v2:c2c:U1#n1`). Old
 * threads remain intact on disk; only the current pointer advances.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type ThreadPayload = Record<string, number>

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

/** Stable target key: c2c:openid | group:openid | channel:channel_id. */
export function targetKey(target: { kind: 'c2c'; userId: string } | { kind: 'group'; groupId: string } | { kind: 'channel'; channelId: string }): string {
  if (target.kind === 'c2c') return `c2c:${target.userId}`
  if (target.kind === 'group') return `group:${target.groupId}`
  return `channel:${target.channelId}`
}

export class ThreadStore {
  private map: ThreadPayload = {}
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.map = await readJson<ThreadPayload>(this.file, {})
  }

  /** Return the current thread counter (0 when never bumped). */
  current(key: string): number {
    return this.map[key] ?? 0
  }

  /** Atomically increment and return the new thread number. */
  next(key: string): number {
    const next = (this.map[key] ?? 0) + 1
    this.map[key] = next
    this.flush()
    return next
  }

  private flush(): void {
    this.writing = this.writing.then(
      () => writeJsonAtomic(this.file, this.map),
      () => writeJsonAtomic(this.file, this.map),
    )
  }
}