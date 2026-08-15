/**
 * Per-agent scoped composition: every time a QQ session materializes a fresh
 * DSH agent, that agent's scoped context needs the QQ tools (qq_send_media,
 * qq_api) and the inline-keyboard approval answerer. This factory produces
 * the `setup` callback that the inbound pipeline hands to `agents.create` /
 * `agents.resume`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LogSink, QQApi } from './qqapi.js'
import type { RouteStore } from './store.js'
import type {
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
}

/** Built handler compatible with `InboundPipeline.InboundDeps.setupAgent`. */
export type SetupHandler = (agentCtx: Context, sessionId: string) => void

export function createSetupAgent(deps: SetupDeps): SetupHandler {
  const { log, api, routes, outbound, workspaceRegistry, defaultCwd } = deps
  return (agentCtx, sessionId) => {
    const target = (): ReplyTarget =>
      routes.get(sessionId)?.target ?? targetOfSession(sessionId)
    registerQQTools(agentCtx, sessionId, api, target)
    outbound.registerApprovalAnswerer(agentCtx, sessionId)
    routes.ensure(sessionId, target())
    void attachSessionToCwdWorkspace(workspaceRegistry, defaultCwd, sessionId, log)
  }
}