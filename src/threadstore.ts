/**
 * Per-target conversation-thread counter, plus the per-session preset
 * overrides recorded by `/new <preset>`.
 *
 * Each QQ target (c2c user / group / channel) starts on an implicit "thread
 * zero" that reuses the bare `qq:v2:<scope>:<id>` session id. The `/new`
 * slash command atomically bumps this counter, which makes the next inbound
 * message resolve to a fresh session id (e.g. `qq:v2:c2c:U1#n1`). Old
 * threads remain intact on disk; only the current pointer advances.
 *
 * When `/new` carries a preset id, the override is stored keyed by the NEW
 * session id, so the agent materializing that id (even after a restart,
 * via create or resume) composes from the requested preset instead of the
 * plugin-config default. A plain `/new` clears any override for the new id.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** On-disk shape (v2): thread counters plus per-session-id preset overrides. */
interface ThreadPayload {
  counters: Record<string, number>
  presets: Record<string, string>
}

/** Accept both the v2 object shape and the legacy bare counter map. */
function normalizePayload(raw: unknown): ThreadPayload {
  const empty: ThreadPayload = { counters: {}, presets: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const record = raw as Record<string, unknown>
  if (!('counters' in record) && !('presets' in record)) {
    // Legacy file: Record<targetKey, number>. Migrate in memory; the next
    // flush persists the v2 shape.
    const counters: Record<string, number> = {}
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'number') counters[key] = value
    }
    return { counters, presets: {} }
  }
  const counters: Record<string, number> = {}
  const rawCounters = record.counters
  if (rawCounters !== null && typeof rawCounters === 'object' && !Array.isArray(rawCounters)) {
    for (const [key, value] of Object.entries(rawCounters as Record<string, unknown>)) {
      if (typeof value === 'number') counters[key] = value
    }
  }
  const presets: Record<string, string> = {}
  const rawPresets = record.presets
  if (rawPresets !== null && typeof rawPresets === 'object' && !Array.isArray(rawPresets)) {
    for (const [key, value] of Object.entries(rawPresets as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) presets[key] = value
    }
  }
  return { counters, presets }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return undefined
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
  private payload: ThreadPayload = { counters: {}, presets: {} }
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.payload = normalizePayload(await readJson(this.file))
  }

  /** Return the current thread counter (0 when never bumped). */
  current(key: string): number {
    return this.payload.counters[key] ?? 0
  }

  /** Atomically increment and return the new thread number. */
  next(key: string): number {
    const next = (this.payload.counters[key] ?? 0) + 1
    this.payload.counters[key] = next
    this.flush()
    return next
  }

  /**
   * The preset override recorded for one session id by `/new <preset>`.
   * @returns the preset id, or `undefined` to use the plugin-config default.
   */
  presetFor(sessionId: string): string | undefined {
    return this.payload.presets[sessionId]
  }

  /**
   * Record (or clear) the preset override for one session id. Persisted with
   * the counters so a restart between `/new` and the next message keeps the
   * requested composition.
   */
  setPreset(sessionId: string, preset: string | undefined): void {
    if (preset === undefined) delete this.payload.presets[sessionId]
    else this.payload.presets[sessionId] = preset
    this.flush()
  }

  private flush(): void {
    this.writing = this.writing.then(
      () => writeJsonAtomic(this.file, this.payload),
      () => writeJsonAtomic(this.file, this.payload),
    )
  }
}