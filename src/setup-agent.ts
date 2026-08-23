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
import { type QuestionBridge, registerAskUserInterceptor } from './questions.js'
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
  /** QQ-side user-questions bridge; `undefined` disables the forwarding. */
  readonly questions: QuestionBridge | undefined
  /** Extra system-prompt text for group-chat sessions (optional). */
  readonly groupPrompt: string | undefined
  /** Extra system-prompt text for C2C (private) sessions (optional). */
  readonly directPrompt: string | undefined
}

/** Built handler compatible with `InboundPipeline.InboundDeps.setupAgent`. */
export type SetupHandler = (
  agentCtx: Context,
  sessionId: string,
) => void | Promise<void>

export function createSetupAgent(deps: SetupDeps): SetupHandler {
  const { log, api, routes, outbound, workspaceRegistry, defaultCwd, resolvePreset, agentPresets, questions, groupPrompt, directPrompt } = deps
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

    // 1b. Register a scope-specific extra system-prompt section when configured.
    //     `groupPrompt` / `directPrompt` are appended after the preset's own prompt
    //     sections. The host DSH `agent/system-prompt` event carries a mutable
    //     sections array; listeners push additional entries. This is a best-effort
    //     injection — if the host version doesn't emit that event the config value
    //     is silently skipped (no user-visible error).
    const scopeKind = sessionId.includes(':c2c:') ? 'c2c' : sessionId.includes(':group:') ? 'group' : undefined
    const extraPrompt = scopeKind === 'group' ? groupPrompt : scopeKind === 'c2c' ? directPrompt : undefined
    if (extraPrompt !== undefined && extraPrompt.length > 0) {
      try {
        const onSystemPrompt = agentCtx.on as unknown as (
          event: 'agent/system-prompt',
          handler: (sections: Array<{ text: string; weight?: number }>) => void,
        ) => () => void
        onSystemPrompt('agent/system-prompt', (sections) => {
          sections.push({ text: extraPrompt, weight: 100 })
        })
        log.info('QQ setupAgent: registered %s scope extra prompt for %s', scopeKind, sessionId)
      } catch (error) {
        log.debug?.('QQ setupAgent: system-prompt injection not supported by host: %o', error)
      }
    }

    // 2. Register the QQ-specific scoped tools and approval answerer.
    const target = (): ReplyTarget =>
      routes.get(sessionId)?.target ?? targetOfSession(sessionId)
    registerQQTools(agentCtx, sessionId, api, target)
    outbound.registerApprovalAnswerer(agentCtx, sessionId)
    if (questions !== undefined) registerAskUserInterceptor(agentCtx, sessionId, questions)
    routes.ensure(sessionId, target())
    void attachSessionToCwdWorkspace(workspaceRegistry, defaultCwd, sessionId, log)
  }
}
