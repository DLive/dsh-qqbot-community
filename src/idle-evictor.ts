/**
 * Session idle eviction: periodically scans active QQ sessions and disposes
 * agents that have had no inbound activity for longer than `sessionIdleTimeout`.
 *
 * Mirrors the `IdleEvictor` in the reference implementation
 * (`tencent-connect/dsh-qqbot/src/session/idle-evictor.ts`).
 */
import type { AgentRegistryService } from './types.js'
import type { LogSink } from './qqapi.js'
import type { RouteStore } from './store.js'
import { SESSION_PREFIX } from './inbound.js'

/** Eviction check interval. */
const CHECK_INTERVAL_MS = 60_000

export interface IdleEvictorDeps {
  readonly agents: AgentRegistryService
  readonly routes: RouteStore
  readonly log: LogSink
  /** Idle timeout in milliseconds; 0 disables eviction. */
  readonly sessionIdleTimeout: number
}

export class IdleEvictor {
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly deps: IdleEvictorDeps) {}

  /** Start the periodic eviction loop. */
  start(): void {
    if (this.deps.sessionIdleTimeout <= 0) return
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(): void {
    if (this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().then(() => { this.schedule() }).catch(() => { this.schedule() })
    }, CHECK_INTERVAL_MS)
  }

  private async tick(): Promise<void> {
    const { sessionIdleTimeout, routes, log } = this.deps
    if (sessionIdleTimeout <= 0) return
    const now = Date.now()
    const threshold = now - sessionIdleTimeout
    let evicted = 0

    for (const { sessionId, record } of routes.entries()) {
      if (!sessionId.startsWith(`${SESSION_PREFIX}:`)) continue
      const lastActivity = record.lastMsgAt
      if (lastActivity !== undefined && lastActivity > threshold) continue
      // No recent inbound activity: evict the agent.
      const agent = this.deps.agents.get(sessionId)
      if (agent === undefined) continue
      log.info('QQ idle eviction: disposing session %s (idle %ds)', sessionId, Math.floor((now - (lastActivity ?? 0)) / 1000))
      try {
        agent.cancel({ kind: 'disposed' })
      } catch (error) {
        log.warn('QQ idle eviction: cancel failed for %s: %o', sessionId, error)
      }
      evicted++
    }

    if (evicted > 0) log.info('QQ idle eviction: evicted %d idle session(s)', evicted)
  }
}
