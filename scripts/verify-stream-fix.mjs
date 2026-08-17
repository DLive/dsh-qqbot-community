// Temporary verification script for the streaming serialization fix.
import { OutboundPipeline } from '../lib/outbound.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makePipeline(apiImpl) {
  const calls = []
  let inflight = 0
  let maxInflight = 0
  let staticSends = 0
  const api = {
    async sendStreamFrame(userId, frame) {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      calls.push({ frame: { ...frame } })
      try {
        return await apiImpl(userId, frame)
      } finally {
        inflight -= 1
      }
    },
    async sendText() { staticSends += 1; return 'msg-1' },
  }
  const log = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  }
  const config = {
    streamThrottleMs: 50,
    textChunkLimit: 4000,
    deliverWindowMs: 900,
    deliverMaxWaitMs: 6000,
    replyPassiveLimit: 4,
    markdown: false,
  }
  const routes = {
    get() { return { target: { kind: 'c2c', userId: 'u1' }, lastMsgId: 'm1' } },
    consumePassive() { return 'm1' },
  }
  const pipeline = new OutboundPipeline({
    config,
    api,
    log,
    routes,
    alwaysAllow: { isAlwaysAllowed: () => false },
    inbound: { stopTyping() {} },
  })
  return { pipeline, calls, get maxInflight() { return maxInflight }, get staticSends() { return staticSends } }
}

// Scenario 1: fast model deltas + slow QQ API → frames strictly serialized,
// final DONE frame carries the complete text.
{
  const suite = makePipeline(async (_userId, _frame) => {
    await sleep(80)
    return 'stream-msg-id-1'
  })
  const { pipeline, calls } = suite
  const sid = 'qq:v2:c2c:u1#n1'
  let text = ''
  for (let i = 0; i < 30; i += 1) {
    text += String(i % 10)
    pipeline.onStreamDelta(sid, text)
    await sleep(15)
  }
  await pipeline.onAssistantMessage(sid, text)
  await sleep(300)

  const states = [...new Set(calls.map((c) => c.frame.state))]
  const sequential = calls.every((c, i) => c.frame.index === i)
  const finalText = calls.at(-1)?.frame.text
  const maxInflight = suite.maxInflight
  const pass = maxInflight === 1 && states.includes(1) && states.includes(10) && sequential && finalText === text
  console.log('[scenario 1] frames=%d maxConcurrent=%d states=%s sequential=%s finalTextOk=%s',
    calls.length, maxInflight, states.join(','), sequential, finalText === text)
  console.log('[scenario 1]', pass ? 'PASS' : 'FAIL')
  if (!pass) process.exit(1)
}

// Scenario 2: QQ rejects stream frames → stream fails fast, no further
// concurrent retries, static text fallback delivers the message.
{
  let failures = 0
  const suite = makePipeline(async (_userId, _frame) => {
    failures += 1
    const error = new Error('QQ POST failed: HTTP 400 {"message":"其它流式消息发送中"}')
    error.name = 'QQApiError'
    throw error
  })
  const { pipeline, calls } = suite
  const sid = 'qq:v2:c2c:u1#n2'
  let text = ''
  for (let i = 0; i < 10; i += 1) {
    text += 'x'
    pipeline.onStreamDelta(sid, text)
    await sleep(10)
  }
  await pipeline.onAssistantMessage(sid, text)
  await sleep(1200)

  const { maxInflight, staticSends } = suite
  const pass = maxInflight === 1 && calls.length === 1 && failures === 1 && staticSends >= 1
  console.log('[scenario 2] streamCalls=%d failures=%d staticSends=%d maxConcurrent=%d',
    calls.length, failures, staticSends, maxInflight)
  console.log('[scenario 2]', pass ? 'PASS' : 'FAIL')
  if (!pass) process.exit(1)
}

console.log('RESULT: ALL PASS')
