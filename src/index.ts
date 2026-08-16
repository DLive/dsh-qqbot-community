/**
 * dsh-qqbot-community — QQ Official Bot adapter for DeepSeek Harness.
 *
 * Composition root: validates config (see ./config.js), instantiates the
 * QQ OpenAPI client, all five persistent stores, the inbound/outbound
 * pipelines and the WebSocket gateway, wires the slash-command and
 * per-agent setup hooks, and registers the lifecycle effect that loads
 * stores, starts the gateway and tears everything down on dispose.
 */
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentPresetsLike,
  type AgentRegistryService,
  type ApprovalServiceLike,
  type AttachmentStoreService,
  type SessionPersistenceService,
  type WebServerService,
  type WorkspaceRegistryService,
} from './types.js'
import { QQApi } from './qqapi.js'
import { QQGateway } from './gateway.js'
import { RefIndexStore } from './refindex.js'
import { AlwaysAllowStore, RouteStore } from './store.js'
import { InboundPipeline, type InboundHooks, normalizeMessage } from './inbound.js'
import { OutboundPipeline } from './outbound.js'
import { createLogSink } from './log.js'
import { unarchiveOwnQQSessions } from './dsh-bookkeeping.js'
import { createSlashHandler } from './slash-commands.js'
import { createSetupAgent } from './setup-agent.js'
import { ThreadStore } from './threadstore.js'
import { createHttpApiHandler, resolveHttpApiMount } from './http-api.js'
import { Config, type Config as ConfigType } from './config.js'

// Re-export the schema so DSH can mount this plugin via `name: 'qqbot-community'`.
export { Config, type Config as ConfigType }

export const name = 'qqbot-community'

export const inject = ['agents', 'sessionPersistence', 'workspaceRegistry']

/** Resolve the `~/.dsh` storage root once. */
function resolveDshHome(): { home: string; storages: string } {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return { home, storages: join(home, 'storages') }
}

/** Pull optional DSH services without throwing at plugin load. */
function resolveOptionalServices(ctx: Context, log: ReturnType<typeof createLogSink>): {
  attachments: AttachmentStoreService | undefined
  approval: ApprovalServiceLike | undefined
  agentPresets: AgentPresetsLike | undefined
  webServer: WebServerService | undefined
} {
  const get = ctx.get as (name: string, strict?: boolean) => unknown
  const attachments = get('attachments', false) as AttachmentStoreService | undefined
  const approval = get('approval', false) as ApprovalServiceLike | undefined
  const agentPresets = get('agentPresets', false) as AgentPresetsLike | undefined
  const webServer = get('webServer', false) as WebServerService | undefined
  if (attachments === undefined && log.debug !== undefined) {
    log.debug('attachments service not present; image attachments will fall back to text paths')
  }
  if (approval === undefined && log.debug !== undefined) {
    log.debug('approval service not present; inline-keyboard approval answerer disabled')
  }
  if (agentPresets === undefined && log.debug !== undefined) {
    log.debug('agentPresets service not present; QQ agents will run on the empty global layer')
  }
  return { attachments, approval, agentPresets, webServer }
}

/** Strict, narrow validator for QQ INTERACTION_CREATE payloads. */
function asInteractionButton(payload: unknown): { id: string; buttonData: string } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const root = payload as Record<string, unknown>
  if (typeof root.id !== 'string') return undefined
  const data = root.data
  if (data === null || typeof data !== 'object') return undefined
  const resolved = (data as Record<string, unknown>).resolved
  if (resolved === null || typeof resolved !== 'object') return undefined
  const buttonData = (resolved as Record<string, unknown>).button_data
  if (typeof buttonData !== 'string') return undefined
  return { id: root.id, buttonData }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('qqbot-community')
  const log = createLogSink(logger, config.debug === true)
  if (log.debug !== undefined) {
    log.debug('qqbot-community apply() reached (cwd=%s sandbox=%s)', config.cwd ?? '(none)', String(config.sandbox))
  }

  const { home, storages } = resolveDshHome()
  const agents = (ctx as unknown as { agents: AgentRegistryService }).agents
  const sessionPersistence = (ctx as unknown as { sessionPersistence?: SessionPersistenceService }).sessionPersistence
  const workspaceRegistry = (ctx as unknown as { workspaceRegistry?: WorkspaceRegistryService }).workspaceRegistry
  const { attachments, approval, agentPresets, webServer } = resolveOptionalServices(ctx, log)

  const api = new QQApi(config, log)
  const refIndex = new RefIndexStore(join(storages, 'qq-refindex.jsonl'))
  const routes = new RouteStore(join(storages, 'qq-routes.json'))
  const alwaysAllow = new AlwaysAllowStore(join(storages, 'qq-always-allow.json'))
  const threads = new ThreadStore(join(storages, 'qq-threads.json'))

  const inbound = new InboundPipeline({
    config,
    api,
    log,
    refIndex,
    routes,
    agents,
    sessionPersistence,
    attachments,
    approval,
    threads,
  })
  const outbound = new OutboundPipeline({ config, api, log, routes, alwaysAllow, inbound })
  outbound.bind(ctx)

  // Now that outbound exists, build the handlers that close over it.
  const onSlashCommand = createSlashHandler({ log, alwaysAllow, threads, agents, approval, outbound, agentPresets })
  // `config.agentPreset` carries schemastery's `.default('standard')`, so it
  // is always a non-empty string at runtime; we still defensively fall back
  // to 'standard' for any empty override written by hand.
  const presetOverride: string = (typeof config.agentPreset === 'string' && config.agentPreset.length > 0)
    ? config.agentPreset
    : 'standard'
  const setupAgent = createSetupAgent({
    log,
    api,
    routes,
    outbound,
    workspaceRegistry,
    defaultCwd: config.cwd ?? process.cwd(),
    // Resolve the preset per session: a `/new <preset>` override recorded for
    // that session id wins over the plugin-config value. When the host has no
    // `agentPresets` service (older host, custom profile), leave the function
    // undefined and `createSetupAgent` will log a warning at agent-creation time.
    resolvePreset: agentPresets === undefined
      ? undefined
      : (sessionId: string) => agentPresets.resolve(threads.presetFor(sessionId) ?? presetOverride),
    agentPresets,
  })
  // The two callbacks above close over the same pipelines that depend on
  // them; attach them after construction so the cycle resolves cleanly.
  const hooks: InboundHooks = { onSlashCommand, setupAgent }
  inbound.attachHooks(hooks)

  const gateway = new QQGateway(
    config,
    api,
    {
      onMessage: (payload, eventType) => {
        const message = normalizeMessage(payload, eventType)
        if (message === undefined) return
        void inbound.handle(message).catch((error: unknown) => {
          logger.error('inbound handling failed: %o', error)
        })
      },
      onInteraction: (payload) => {
        const interaction = asInteractionButton(payload)
        if (interaction === undefined) return
        if (outbound.handleApprovalCallback(interaction.buttonData) !== undefined) {
          void api.ackInteraction(interaction.id).catch((error: unknown) => {
            logger.warn('interaction ack failed: %o', error)
          })
        }
      },
      onReady: () => { logger.info('QQ gateway ready (appid=%s)', config.id) },
    },
    log,
    join(storages, 'qq-gateway-session.json'),
  )

  // Optional HTTP push API: config validation fails the load loudly here; the
  // route itself is registered inside the lifecycle effect below so Cordis
  // owns its teardown together with the gateway.
  let httpApiMount: ReturnType<typeof resolveHttpApiMount> | undefined
  if (config.httpApi?.enable === true) {
    if (webServer === undefined) {
      throw new Error('qqbot-community: httpApi.enable=true，但宿主未提供 webServer 服务（该 API 仅在 dsh web 等 Web 组合下可用）')
    }
    httpApiMount = resolveHttpApiMount(config.httpApi)
  }

  ctx.effect(() => {
    // All startup work runs inside the effect so Cordis owns its teardown.
    // Best-effort unarchive runs first so the first inbound is not blocked
    // by a synchronous file read on the plugin-loading thread.
    void unarchiveOwnQQSessions(home, 'qq:', log)
    void refIndex.init()
    void routes.load()
    void alwaysAllow.load()
    void threads.load()
    void gateway.start()

    // Registered after the stores start loading: the channels endpoint reads
    // them, and the webServer tolerates requests racing a still-loading store.
    let stopHttpApi: (() => void) | undefined
    if (httpApiMount !== undefined && webServer !== undefined) {
      stopHttpApi = webServer.register({
        kind: 'prefix',
        path: httpApiMount.path,
        handler: createHttpApiHandler({
          mountPath: httpApiMount.path,
          token: httpApiMount.token,
          config,
          log,
          api,
          routes,
          threads,
          ensureAgent: (sessionId: string) => inbound.ensureAgent(sessionId),
        }),
      })
      logger.info('httpApi: 已挂载 POST %s/send 与 GET %s/channels', httpApiMount.path, httpApiMount.path)
    }

    const onAgentDisposed = ctx.on as unknown as (
      name: 'agent/disposed',
      listener: (payload: { agent: { id: string } }) => void,
    ) => () => void
    const stopDisposed = onAgentDisposed('agent/disposed', ({ agent }) => {
      if (!agent.id.startsWith('qq:')) return
      // Force-close any in-flight C2C stream for the disposed agent so the
      // QQ "generating" bubble does not linger and the next inbound on the
      // same openid does not get HTTP 40034021 ("其它流式消息发送中").
      void outbound.closeStream(agent.id)
      inbound.onAgentDisposed(agent.id)
    })

    return () => {
      // Remove the HTTP route first so no new request reaches a dying plugin.
      stopHttpApi?.()
      if (typeof stopDisposed === 'function') stopDisposed()
      void outbound.disposeAllStreams()
      inbound.dispose()
      gateway.dispose()
      api.dispose()
      void outbound.dispose()
    }
  }, 'qqbot-community.gateway()')
}