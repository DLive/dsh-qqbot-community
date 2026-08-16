/**
 * Per-agent scoped composition: every time a QQ session materializes a fresh
 * DSH agent, that agent's scoped context needs the QQ tools (qq_send_media,
 * qq_api) and the inline-keyboard approval answerer. This factory produces
 * the `setup` callback that the inbound pipeline hands to `agents.create` /
 * `agents.resume`.
 *
 * Order matters: the agent must join its preset BEFORE the QQ-specific tools
 * register, so any preset-owned tools (bash, files, jobs, etc.) coexist with
 * the QQ tools in one scoped world. The preset service is injected via
 * {@link SetupDeps.agentPresets}; a missing service falls back to a bare
 * agent (legacy behaviour) with a debug log so misconfiguration is obvious.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LogSink, QQApi } from './qqapi.js'
import type { RouteStore } from './store.js'
import type {
  AgentPresetsLike,
  ReplyTarget,
  WorkspaceRegistryService,
} from './types.js'
import { targetOfSession } from './inbound.js'
import type { OutboundPipeline } from './outbound.js'
import { registerQQTools } from './tools.js'
import { attachSessionToCwdWorkspace } from './dsh-bookkeeping.js'

export interface SetupDeps {
  readonly log: LogSink
  readonly api: QQApi
  readonly routes: RouteStore
  readonly outbound: OutboundPipeline
  readonly workspaceRegistry: WorkspaceRegistryService | undefined
  /** Resolved absolute cwd for new sessions (configured `cwd` or `process.cwd()`). */
  readonly defaultCwd: string
  /**
   * Preset selector used at agent creation time. Resolves, for one session,
   * to:
   *   - the `/new <preset>` override recorded for that session id (if any),
   *   - otherwise the explicitly configured `agentPreset` (if non-empty),
   *   - otherwise `agentPresets.defaultId` (typically `standard`).
   * Pass `undefined` when the host has no `agentPresets` service; the setup
   * callback then logs a warning and runs without joining a preset.
   */
  readonly resolvePreset: ((sessionId: string) => Promise<{ readonly id: string }>) | undefined
  /** Service handle for {@link AgentPresetsLike.mount}. */
  readonly agentPresets: AgentPresetsLike | undefined
}

/** Built handler compatible with `InboundPipeline.InboundDeps.setupAgent`. */
export type SetupHandler = (
  agentCtx: Context,
  sessionId: string,
) => void | Promise<void>

export function createSetupAgent(deps: SetupDeps): SetupHandler {
  const { log, api, routes, outbound, workspaceRegistry, defaultCwd, resolvePreset, agentPresets } = deps
  return async (agentCtx, sessionId) => {
    // 1. Join the agent's preset FIRST so its tools, prompt sections, and
    //    skill catalog are in scope before any QQ-only tool registers.
    //    `mount()` returns the preset that was actually mounted; on rejection
    //    we surface a clear error to `agents.create` so the agent never
    //    publishes half-configured.
    if (agentPresets !== undefined && resolvePreset !== undefined) {
      let presetId: string | undefined
      try {
        presetId = (await resolvePreset(sessionId)).id
      } catch (error: unknown) {
        log.error('QQ setupAgent: resolving agent preset failed for %s: %o', sessionId, error)
        throw error instanceof Error ? error : new Error(String(error))
      }
      try {
        const mounted = await agentPresets.mount(agentCtx, presetId)
        log.info('QQ setupAgent: %s joined preset "%s"', sessionId, mounted.id)
      } catch (error: unknown) {
        log.error('QQ setupAgent: mounting preset "%s" failed for %s: %o', presetId ?? '(default)', sessionId, error)
        throw error instanceof Error ? error : new Error(String(error))
      }
    } else {
      log.warn(
        'QQ setupAgent: agentPresets service is absent; %s will run on the empty global layer '
        + '(only QQ-specific tools will be visible). Load an agent-presets plugin in the host composition.',
        sessionId,
      )
    }

    // 2. Register the QQ-specific scoped tools and approval answerer.
    const target = (): ReplyTarget =>
      routes.get(sessionId)?.target ?? targetOfSession(sessionId)
    registerQQTools(agentCtx, sessionId, api, target)
    outbound.registerApprovalAnswerer(agentCtx, sessionId)
    routes.ensure(sessionId, target())
    void attachSessionToCwdWorkspace(workspaceRegistry, defaultCwd, sessionId, log)
  }
}
