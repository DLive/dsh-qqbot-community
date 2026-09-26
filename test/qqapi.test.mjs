import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QQApi } from '../lib/qqapi.js'
import { QQGateway } from '../lib/gateway.js'

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
      gatewayUrl: async () => { throw new Error('gateway unavailable') },
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
