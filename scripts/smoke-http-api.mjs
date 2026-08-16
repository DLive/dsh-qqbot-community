/**
 * Dev-only smoke test for the HTTP push API (lib/http-api.js).
 *
 * Stubs QQApi.sendText and the ensureAgent entry, mounts the real handler on
 * a real node:http server, and asserts the wire contract: auth, validation,
 * chunking, shorthand parsing, channels listing, record injection, and QQ
 * failure mapping. Run: node scripts/smoke-http-api.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpApiHandler } from '../lib/http-api.js'
import { RouteStore } from '../lib/store.js'
import { ThreadStore } from '../lib/threadstore.js'

const dir = mkdtempSync(join(tmpdir(), 'qqbot-smoke-'))
const routes = new RouteStore(join(dir, 'routes.json'))
const threads = new ThreadStore(join(dir, 'threads.json'))
await routes.load()
await threads.load()
routes.anchor('qq:v2:c2c:USER1', { kind: 'c2c', userId: 'USER1' }, 'm-anchor-1')
routes.anchor('qq:v2:group:GRPFIRST', { kind: 'group', groupId: 'GRPFIRST' }, 'm-anchor-2')

const sent = []
const injected = []
let failNextSend = false
const deps = {
  mountPath: '/external/qq',
  token: 'test-token-1234',
  config: { textChunkLimit: 50 },
  log: { info() {}, warn() {}, error() {} },
  api: {
    async sendText(target, text, msgId) {
      if (failNextSend) { failNextSend = false; throw new Error('QQ HTTP 429') }
      sent.push({ target, text, msgId })
      return `mid-${sent.length}`
    },
  },
  routes,
  threads,
  ensureAgent: async (sessionId) => ({
    id: sessionId,
    inject: (message) => injected.push({ sessionId, message }),
  }),
}

const server = createServer(createHttpApiHandler(deps))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const auth = { authorization: 'Bearer test-token-1234', 'content-type': 'application/json' }
let failed = false
const check = (pass, name) => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`)
  if (!pass) failed = true
}

// 1. Missing/incorrect token → 401 on every endpoint.
let res = await fetch(`${base}/external/qq/channels`)
check(res.status === 401, '401 without token')
res = await fetch(`${base}/external/qq/channels`, { headers: { authorization: 'Bearer wrong-token' } })
check(res.status === 401, '401 with wrong token')

// 2. Index endpoint.
res = await fetch(`${base}/external/qq`, { headers: auth })
check(res.status === 200 && (await res.json()).ok === true, 'index responds with endpoints')

// 3. Validation: missing target, empty text, bad shorthand.
res = await fetch(`${base}/external/qq/send`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x' }) })
check(res.status === 400, '400 missing target')
res = await fetch(`${base}/external/qq/send`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: 'c2c:USER1' }) })
check(res.status === 400, '400 missing text')
res = await fetch(`${base}/external/qq/send`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: 'bogus:USER1', text: 'x' }) })
check(res.status === 400, '400 bad shorthand')

// 4. Method and endpoint discipline.
res = await fetch(`${base}/external/qq/send`, { headers: auth })
check(res.status === 405, '405 GET on send')
res = await fetch(`${base}/external/qq/nope`, { headers: auth })
check(res.status === 404, '404 unknown endpoint')

// 5. Chunked send without msgId (active message).
res = await fetch(`${base}/external/qq/send`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: 'c2c:USER1', text: 'A'.repeat(120) }) })
let data = await res.json()
check(res.status === 200 && data.ok === true && data.chunks === 3 && sent.length === 3, 'send splits 120 chars at limit 50 → 3 chunks')
check(sent.every((s) => s.msgId === undefined && s.target.kind === 'c2c'), 'chunks sent active (no msgId)')

// 6. Session-id shorthand + msgId passive anchor.
res = await fetch(`${base}/external/qq/send`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: 'qq:v2:c2c:USER1#n2', text: 'hello', msgId: 'M1' }) })
data = await res.json()
check(res.status === 200 && sent.at(-1).msgId === 'M1', 'session-id shorthand accepted; msgId passed through')

// 7. Channels listing: deduped per target, current thread resolved, newest first.
res = await fetch(`${base}/external/qq/channels`, { headers: auth })
data = await res.json()
const byId = Object.fromEntries(data.channels.map((c) => [c.id, c]))
check(data.ok === true && Object.keys(byId).length === 2, 'channels lists both targets')
check(byId.USER1?.currentSessionId === 'qq:v2:c2c:USER1' && byId.USER1?.kind === 'c2c', 'channel row carries kind + current session id')

// 8. record: true injects into the current session without waking the agent.
res = await fetch(`${base}/external/qq/send`, { method: 'POST', headers: auth, body: JSON.stringify({ target: { kind: 'c2c', userId: 'USER1' }, text: '构建完成', record: true }) })
data = await res.json()
check(data.ok === true && data.recorded === true, 'record reports recorded:true')
check(injected.length === 1 && injected[0].sessionId === 'qq:v2:c2c:USER1' && injected[0].message.content[0].text.includes('构建完成'), 'record injects push text into current session')

// 9. QQ send failure mid-flight → 502 with partial receipt.
failNextSend = true
res = await fetch(`${base}/external/qq/send`, { method: 'POST', headers: auth, body: JSON.stringify({ channel: 'c2c:USER1', text: 'fail-fast' }) })
data = await res.json()
check(res.status === 502 && data.ok === false && typeof data.error === 'string', 'QQ failure maps to 502 with error detail')

server.close()
rmSync(dir, { recursive: true, force: true })
console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE PASSED')
process.exit(failed ? 1 : 0)
