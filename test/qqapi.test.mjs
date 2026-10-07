import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QQApi, QQApiError } from '../lib/qqapi.js'
import { WebSocketServer } from 'ws'
import { QQGateway } from '../lib/gateway.js'

function apiResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

function tokenResponse(token, expiresIn = 300) {
  return { ok: true, json: async () => ({ access_token: token, expires_in: expiresIn }) }
}

async function flush() {
  // Let the fetch promise and the refresh rejection/continuation settle.
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function withMocks(run) {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalNow = Date.now
  const timers = new Map()
  let nextTimer = 0
  let now = 100_000
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextTimer
    timers.set(id, { callback, delay })
    return id
  }
  globalThis.clearTimeout = (id) => { timers.delete(id) }
  Date.now = () => now
  const fire = async (delay) => {
    const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay)
    assert.ok(entry, `expected timer with delay ${delay}`)
    timers.delete(entry[0])
    entry[1].callback()
    await flush()
  }
  try {
    await run({ timers, fire, setNow: (value) => { now = value } })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    Date.now = originalNow
  }
}

function createApi(errors) {
  return new QQApi({ id: 'test-app', secret: 'test-secret' }, {
    info() {}, warn() {}, error: (...args) => { errors.push(args) },
  })
}

test('401 refreshes an unexpired token and replays the same request once', async () => {
  await withMocks(async () => {
    const api = createApi([])
    const requests = []
    let tokenRequests = 0
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('getAppAccessToken')) return tokenResponse(++tokenRequests === 1 ? 'old' : 'new')
      requests.push({ url: String(url), ...options })
      return requests.length === 1
        ? apiResponse(401, { code: 11244, err_code: 40011027 })
        : apiResponse(200, { id: 'sent' })
    }
    try {
      assert.deepEqual(await api.request('POST', '/messages', { msg_seq: 7 }, { query: { test: '1' } }), { id: 'sent' })
      assert.equal(tokenRequests, 2)
      assert.equal(requests.length, 2)
      assert.equal(requests[0].headers.Authorization, 'QQBot old')
      assert.equal(requests[1].headers.Authorization, 'QQBot new')
      assert.equal(requests[0].url, requests[1].url)
      assert.equal(requests[0].body, requests[1].body)
    } finally { api.dispose() }
  })
})

test('repeated 401 is bounded and leaves the rejected token invalidated', async () => {
  await withMocks(async () => {
    const api = createApi([])
    let tokenRequests = 0
    let requests = 0
    globalThis.fetch = async (url) => {
      if (String(url).includes('getAppAccessToken')) return tokenResponse(`token-${++tokenRequests}`)
      requests++
      return apiResponse(401, { code: 11244 })
    }
    try {
      await assert.rejects(api.request('GET', '/gateway'), (error) => error instanceof QQApiError && error.status === 401 && error.body.code === 11244)
      assert.equal(requests, 2)
      assert.equal(tokenRequests, 2)
      assert.equal(await api.ensureToken(), 'token-3')
    } finally { api.dispose() }
  })
})

test('late concurrent 401 does not invalidate a newer token', async () => {
  await withMocks(async () => {
    const api = createApi([])
    let tokenRequests = 0
    let rejectLate
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('getAppAccessToken')) return tokenResponse(++tokenRequests === 1 ? 'old' : 'new')
      if (options.headers.Authorization === 'QQBot new') return apiResponse(200, { ok: true })
      if (String(url).endsWith('/late')) return new Promise((resolve) => { rejectLate = () => resolve(apiResponse(401, { code: 11244 })) })
      return apiResponse(401, { code: 11244 })
    }
    try {
      await api.ensureToken()
      const late = api.request('GET', '/late')
      await flush()
      await api.request('GET', '/first')
      rejectLate()
      await late
      assert.equal(tokenRequests, 2)
    } finally { api.dispose() }
  })
})

test('non-authentication errors are not retried', async () => {
  await withMocks(async () => {
    const api = createApi([])
    let requests = 0
    globalThis.fetch = async (url) => {
      if (String(url).includes('getAppAccessToken')) return tokenResponse('valid')
      requests++
      return apiResponse(403, { message: 'permission denied' })
    }
    try {
      await assert.rejects(api.request('GET', '/gateway'), (error) => error.status === 403)
      assert.equal(requests, 1)
    } finally { api.dispose() }
  })
})

test('gateway identifies with the token obtained after gateway discovery', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => server.once('listening', resolve))
  let currentToken = 'old'
  const api = {
    ensureToken: async () => currentToken,
    gatewayUrl: async () => {
      currentToken = 'new'
      return `ws://127.0.0.1:${server.address().port}`
    },
  }
  const gateway = new QQGateway({}, api, { onMessage() {}, onInteraction() {} }, {
    info() {}, warn() {}, error() {},
  }, '/nonexistent-qq-gateway-session-test.json')
  const identified = new Promise((resolve) => server.once('connection', (socket) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())))
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
  }))
  try {
    await gateway.start()
    const frame = await identified
    assert.equal(frame.op, 2)
    assert.equal(frame.d.token, 'QQBot new')
  } finally {
    gateway.dispose()
    for (const socket of server.clients) socket.terminate()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('refresh keeps a still-valid token and retries every failure until recovery', async () => {
  await withMocks(async ({ timers, fire, setNow }) => {
    const errors = []
    const api = createApi(errors)
    const outcomes = [tokenResponse('first'), new Error('reset 1'), new Error('reset 2'), tokenResponse('second')]
    let requests = 0
    globalThis.fetch = async () => {
      requests++
      const outcome = outcomes.shift()
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    try {
      assert.equal(await api.ensureToken(), 'first')
      await fire(240_000)
      assert.equal(await api.ensureToken(), 'first')
      await fire(10_000)
      assert.equal(await api.ensureToken(), 'first')
      assert.equal(errors.length, 2)
      setNow(401_000) // old token has expired; ensureToken must not return it
      await fire(10_000)
      assert.equal(await api.ensureToken(), 'second')
      assert.equal(requests, 4)
      assert.equal(errors.length, 2)
      assert.equal([...timers.values()][0].delay, 240_000)
    } finally {
      api.dispose()
    }
  })
})

test('expired token is not reused while refresh is failing', async () => {
  await withMocks(async ({ timers, setNow }) => {
    const api = createApi([])
    const outcomes = [tokenResponse('expired', 1), new Error('offline')]
    globalThis.fetch = async () => {
      const outcome = outcomes.shift()
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    try {
      assert.equal(await api.ensureToken(), 'expired')
      setNow(102_000)
      await assert.rejects(api.ensureToken(), /offline/)
      assert.equal([...timers.values()][0].delay, 10_000)
    } finally {
      api.dispose()
    }
  })
})

test('gateway retries when the first token request fails on startup', async () => {
  await withMocks(async ({ fire, timers }) => {
    let attempts = 0
    const api = {
      ensureToken: async () => {
        if (++attempts === 1) throw new Error('offline')
        return 'recovered'
      },
      gatewayUrl: async () => {
        await api.ensureToken()
        throw new Error('gateway unavailable')
      },
    }
    const gateway = new QQGateway({}, api, { onMessage() {}, onInteraction() {} }, {
      info() {}, warn() {}, error() {},
    }, '/nonexistent-qq-gateway-session-test.json')
    try {
      await gateway.start()
      await flush()
      assert.equal(attempts, 1)
      await fire(1_000)
      assert.equal(attempts, 2)
      assert.equal([...timers.values()][0].delay, 2_000)
    } finally {
      gateway.dispose()
    }
  })
})

test('initial token failure schedules retries, and disposal cancels retries', async () => {
  await withMocks(async ({ timers, fire }) => {
    const errors = []
    const api = createApi(errors)
    const outcomes = [new Error('reset 1'), new Error('reset 2'), tokenResponse('recovered')]
    globalThis.fetch = async () => {
      const outcome = outcomes.shift()
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    await assert.rejects(api.ensureToken(), /reset 1/)
    assert.equal(timers.size, 1)
    await fire(10_000)
    assert.equal(errors.length, 2)
    assert.equal(timers.size, 1)
    await fire(10_000)
    assert.equal(await api.ensureToken(), 'recovered')
    api.dispose()
    assert.equal(timers.size, 0)
    await assert.rejects(api.ensureToken(), /disposed/)
  })
})
