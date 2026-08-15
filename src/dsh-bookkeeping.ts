/**
 * DSH-side bookkeeping: two small helpers that keep QQ sessions visible
 * inside the host application's sidebar / workspace tree. Both functions
 * are best-effort — failures must not crash the plugin.
 *
 *   • `unarchiveOwnQQSessions` strips archived entries whose id starts with
 *     `qq:` so newly-resumed sessions are not hidden from the sidebar.
 *   • `attachSessionToCwdWorkspace` ensures the workspace owning the agent's
 *     cwd exists and the session is attached to it, so the session groups
 *     under the right project in the sidebar.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogSink } from './qqapi.js'
import type { WorkspaceLike, WorkspaceRegistryService } from './types.js'

/** Strip archived QQ sessions from `~/.dsh/storages/workspace.json`. */
export async function unarchiveOwnQQSessions(home: string, prefix: string, log: LogSink): Promise<void> {
  const path = join(home, 'storages', 'workspace.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    if (log.debug !== undefined) log.debug('unarchive: workspace.json not JSON (%o)', error)
    return
  }
  const root = parsed as { global?: { archivedSessionIds?: unknown } }
  const archived = root.global?.archivedSessionIds
  if (!Array.isArray(archived) || archived.length === 0) return
  const kept = archived.filter((id) => typeof id === 'string' && !id.startsWith(prefix))
  if (kept.length === archived.length) return
  const next = { ...root, global: { ...root.global, archivedSessionIds: kept } }
  try {
    await writeFile(path, JSON.stringify(next, null, 2))
  } catch (error) {
    if (log.debug !== undefined) log.debug('unarchive: write failed (%o)', error)
  }
}

/** Group the session under the workspace that owns its cwd (sidebar grouping). */
export async function attachSessionToCwdWorkspace(
  registry: WorkspaceRegistryService | undefined,
  cwd: string,
  sessionId: string,
  log: LogSink,
): Promise<void> {
  if (registry === undefined) return
  let workspace: WorkspaceLike | undefined
  try {
    workspace = await registry.resolveByPath(cwd)
    if (workspace === undefined) workspace = await registry.create(cwd)
  } catch (error) {
    if (log.debug !== undefined) log.debug('attachSessionToCwdWorkspace: resolve/create failed for %s (%o)', cwd, error)
    return
  }
  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    // Header/cwd drift: sidebar grouping is skipped, replies are unaffected.
    if (log.debug !== undefined) log.debug('attachSessionToCwdWorkspace: attachSession(%s) failed (%o)', sessionId, error)
  }
}