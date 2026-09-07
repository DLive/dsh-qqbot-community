/**
 * Per-target conversation-thread counter, plus the per-session preset
 * overrides recorded by `/new <preset>` and the per-session model overrides
 * recorded by `/model <provider>[/<model>]`.
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
 *
 * The model override is keyed by the SAME session id the inbound pipeline
 * resolves for the current thread, so the next message in that thread
 * composes its agent with the chosen provider/model. Pass `undefined` to
 * `setModel` to clear the override and fall back to the plugin-config default.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Per-session model override; `model` is optional (provider alone selects its default model). */
export interface ModelOverride {
  readonly provider: string
  readonly model?: string
}

/** On-disk shape (v3): thread counters + per-session preset + per-session model overrides. */
interface ThreadPayload {
  counters: Record<string, number>
  presets: Record<string, string>
  models: Record<string, ModelOverride>
}

/** Accept both the v2 object shape and the legacy bare counter map. */
function normalizePayload(raw: unknown): ThreadPayload {
  const empty: ThreadPayload = { counters: {}, presets: {}, models: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const record = raw as Record<string, unknown>
  if (!('counters' in record) && !('presets' in record) && !('models' in record)) {
    // Legacy file: Record<targetKey, number>. Migrate in memory; the next
    // flush persists the v3 shape.
    const counters: Record<string, number> = {}
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'number') counters[key] = value
    }
    return { counters, presets: {}, models: {} }
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
  const models: Record<string, ModelOverride> = {}
  const rawModels = record.models
  if (rawModels !== null && typeof rawModels === 'object' && !Array.isArray(rawModels)) {
    for (const [key, value] of Object.entries(rawModels as Record<string, unknown>)) {
      const entry = value as Record<string, unknown> | null
      if (entry === null || typeof entry !== 'object') continue
      const provider = entry.provider
      const model = entry.model
      if (typeof provider !== 'string' || provider.length === 0) continue
      models[key] = model === undefined
        ? { provider }
        : (typeof model === 'string' && model.length > 0 ? { provider, model } : { provider })
    }
  }
  return { counters, presets, models }
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
  private payload: ThreadPayload = { counters: {}, presets: {}, models: {} }
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

  /**
   * The model override recorded for one session id by `/model <provider>[/<model>]`.
   * @returns the override, or `undefined` to use the plugin-config default.
   */
  modelFor(sessionId: string): ModelOverride | undefined {
    return this.payload.models[sessionId]
  }

  /**
   * Record (or clear with `undefined`) the model override for one session id.
   * Persisted with the counters/presets so a restart between `/model` and
   * the next message keeps the requested composition.
   */
  setModel(sessionId: string, override: ModelOverride | undefined): void {
    if (override === undefined) delete this.payload.models[sessionId]
    else this.payload.models[sessionId] = override
    this.flush()
  }

  private flush(): void {
    this.writing = this.writing.then(
      () => writeJsonAtomic(this.file, this.payload),
      () => writeJsonAtomic(this.file, this.payload),
    )
  }
}