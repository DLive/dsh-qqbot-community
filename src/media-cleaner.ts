/**
 * Periodic TTL-based cleanup of downloaded media files in <cwd>/.qq-media/.
 *
 * Mirrors `startMediaCleanup()` / `cleanupExpiredMedia()` in the reference
 * implementation (`tencent-connect/dsh-qqbot/src/media/media-cleaner.ts`).
 */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogSink } from './qqapi.js'

/** How often to run the cleanup sweep. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export interface MediaCleanerDeps {
  /** Absolute path to the media directory (typically `<cwd>/.qq-media`). */
  readonly mediaDir: string
  /** TTL in hours; files older than this (by mtime) are removed. 0 = never clean. */
  readonly ttlHours: number
  readonly log: LogSink
}

export class MediaCleaner {
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly deps: MediaCleanerDeps) {}

  /** Run an immediate sweep then schedule periodic sweeps. */
  start(): void {
    if (this.deps.ttlHours <= 0) return
    void this.sweep()
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private schedule(): void {
    if (this.disposed) return
    this.timer = setInterval(() => { void this.sweep() }, CLEANUP_INTERVAL_MS)
  }

  private async sweep(): Promise<void> {
    const { mediaDir, ttlHours, log } = this.deps
    if (ttlHours <= 0) return
    const cutoffMs = Date.now() - ttlHours * 60 * 60 * 1000
    let files: string[]
    try {
      files = await readdir(mediaDir)
    } catch {
      // Directory may not exist yet — nothing to clean.
      return
    }
    let removed = 0
    for (const filename of files) {
      const fullPath = join(mediaDir, filename)
      try {
        const info = await stat(fullPath)
        if (!info.isFile()) continue
        if (info.mtimeMs < cutoffMs) {
          await unlink(fullPath)
          removed++
        }
      } catch {
        // File might have been concurrently deleted or be inaccessible.
      }
    }
    if (removed > 0) {
      log.info('QQ media cleanup: removed %d expired file(s) from %s', removed, mediaDir)
    }
  }
}
