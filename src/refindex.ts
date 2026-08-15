/**
 * Persisted quote index: LRU of recent messages keyed by QQ `msg_idx`,
 * appended as JSONL with compaction. When a user replies to a message the
 * inbound event carries `ref_msg_idx`; resolve it from this store or fall
 * back to the event's own `msg_elements[0]` copy of the quoted content.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const DEFAULT_MAX_ENTRIES = 5_000
const COMPACT_RATIO = 2

interface DiskLine {
  k: string
  v: QuoteEntry
  t: number
}

export interface QuoteEntry {
  messageId: string
  senderId: string
  senderName?: string
  content: string
  scope: string
}

export class RefIndexStore {
  private entries = new Map<string, QuoteEntry>()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  /** Replay the JSONL log and compact when it exceeds the budget. */
  async init(): Promise<void> {
    let lines: string[]
    try {
      lines = (await readFile(this.file, 'utf8')).split('\n')
    } catch {
      return
    }
    const disk: DiskLine[] = []
    for (const line of lines) {
      if (line.trim().length === 0) continue
      try {
        disk.push(JSON.parse(line) as DiskLine)
      } catch {
        // Torn tail line from a crash; ignore it.
      }
    }
    disk.sort((a, b) => a.t - b.t)
    for (const { k, v } of disk) this.entries.set(k, v)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    if (disk.length > this.maxEntries * COMPACT_RATIO) await this.compact()
  }

  get(key: string | undefined): QuoteEntry | undefined {
    if (key === undefined) return undefined
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      // LRU refresh.
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    return entry
  }

  set(key: string, entry: QuoteEntry): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, entry)
    const line = JSON.stringify({ k: key, v: entry, t: Date.now() }) + '\n'
    this.writeChain = this.writeChain.then(
      () => appendFile(this.file, line, 'utf8'),
      () => appendFile(this.file, line, 'utf8'),
    )
  }

  /** Rewrite the store as one clean JSONL file (atomic tmp + rename). */
  async compact(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const ordered = [...this.entries.entries()]
    const body = ordered.map(([k, v]) => JSON.stringify({ k, v, t: Date.now() })).join('\n') + '\n'
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, this.file)
  }
}
