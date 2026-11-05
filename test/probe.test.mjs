import test from 'node:test'
import assert from 'node:assert/strict'

import { ProbeError, formatProbeReport, resolveRoute, runProbe } from '../src/probe.mjs'

/**
 * Build a fake LLM service that returns one canned usage per attempt.
 * @param options - usages, terminal finish reason, and an optional prepare failure.
 * @returns the fake service plus its recorded calls.
 */
function fakeLlm({ usages, finish = { kind: 'stop' }, failPrepare }) {
  const calls = []
  return {
    calls,
    async prepareCall(config, _signal, configure) {
      if (failPrepare !== undefined) throw failPrepare
      const resolved = configure === undefined
        ? { ...config }
        : configure(
          { ...config },
          { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
        )
      return {
        config: resolved,
        stream: async function* stream(options) {
          calls.push({ config: resolved, options })
          const usage = usages[Math.min(calls.length - 1, usages.length - 1)]
          if (usage !== undefined) yield { type: 'usage', usage }
          yield { type: 'finish', reason: finish }
        },
      }
    },
  }
}

const ROUTE = { provider: 'a6', model: 'deepseek-v4.1-flash-1017' }
const OPTIONS = { size: 2_000, rounds: 1, wait: 0, timeout: 10 }

test('sends one warm-up and one measurement with the same payload', async () => {
  const llm = fakeLlm({
    usages: [
      { inputTokens: 3_000, outputTokens: 1, totalTokens: 3_001 },
      { inputTokens: 20, outputTokens: 1, cacheReadTokens: 2_980, totalTokens: 3_001 },
    ],
  })
  const sleeps = []
  const result = await runProbe({
    llm,
    route: ROUTE,
    options: OPTIONS,
    signal: undefined,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    now: () => 0,
  })

  assert.equal(result.attempts.length, 2)
  assert.equal(result.attempts[0].index, 0)
  assert.equal(result.attempts[0].summary.cacheRead, 0)
  assert.equal(result.attempts[1].summary.cacheRead, 2_980)
  assert.equal(result.attempts[1].summary.prompt, 3_000)
  assert.equal(result.attempts[1].summary.hitRate, 2_980 / 3_000)
  assert.equal(sleeps.length, 0)

  assert.equal(llm.calls.length, 2)
  const first = llm.calls[0].options.messages[0].content[0].text
  const second = llm.calls[1].options.messages[0].content[0].text
  assert.equal(first, second)
  assert.ok(first.includes('Cache probe '))
  assert.ok(first.includes('Reply with exactly: OK'))
  assert.equal(llm.calls[0].config.maxTokens, 32)
  assert.equal(llm.calls[0].config.reasoningEffort, 'low')
})

test('reports attempt starts and failed records to stream callbacks', async () => {
  const starts = []
  const records = []
  const llm = {
    async prepareCall() {
      throw Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' })
    },
  }
  const result = await runProbe({
    llm,
    route: ROUTE,
    options: OPTIONS,
    onAttemptStart: (index) => starts.push(index),
    onAttempt: (record) => records.push(record),
  })
  assert.deepEqual(starts, [0])
  assert.equal(records.length, 1)
  assert.equal(records[0].error.code, 'NO_ADAPTER')
  assert.equal(result.attempts.length, 1)
})

test('waits between measurements', async () => {
  const llm = fakeLlm({
    usages: [
      { inputTokens: 3_000, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 1, cacheReadTokens: 2_980 },
    ],
  })
  const sleeps = []
  await runProbe({
    llm,
    route: ROUTE,
    options: { ...OPTIONS, rounds: 2, wait: 10 },
    signal: undefined,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    now: () => 0,
  })
  assert.deepEqual(sleeps, [10_000, 10_000])
})

test('records a missing usage without inventing a hit', async () => {
  const llm = fakeLlm({ usages: [undefined] })
  const result = await runProbe({
    llm,
    route: ROUTE,
    options: OPTIONS,
    signal: undefined,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(result.attempts.length, 2)
  assert.equal(result.attempts[0].summary, undefined)
  assert.equal(result.attempts[0].finish.kind, 'stop')
  assert.equal(result.attempts[1].summary, undefined)
})

test('counts thinking characters separately from the answer', async () => {
  const fake = {
    async prepareCall(config) {
      return {
        config: { ...config },
        stream: async function* stream() {
          yield { type: 'reasoning-delta', text: 'think' }
          yield { type: 'reasoning-delta', text: 'ing' }
          yield { type: 'text-delta', text: 'answer' }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 9, totalTokens: 19 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const result = await runProbe({
    llm: fake,
    route: ROUTE,
    options: OPTIONS,
    signal: undefined,
    sleep: async () => {},
    now: () => 0,
  })
  // Warm-up and measurement run the same stream, so both carry the split.
  for (const attempt of result.attempts) {
    assert.equal(attempt.reasoningChars, 8)
    assert.equal(attempt.textChars, 6)
    assert.equal(attempt.text, 'answer')
  }
})

test('keeps usage from an error terminal when the channel still reported it', async () => {
  const llm = fakeLlm({
    usages: [
      { inputTokens: 3_000, outputTokens: 0 },
      { inputTokens: 3_000, outputTokens: 0 },
    ],
    finish: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'empty' } },
  })
  const result = await runProbe({
    llm,
    route: ROUTE,
    options: OPTIONS,
    signal: undefined,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(result.attempts[0].summary.prompt, 3_000)
  assert.equal(result.attempts[0].finish.kind, 'error')
})

test('reports a prepare failure as the attempt error and stops', async () => {
  const failure = Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' })
  const llm = fakeLlm({ usages: [], failPrepare: failure })
  const result = await runProbe({
    llm,
    route: ROUTE,
    options: OPTIONS,
    signal: undefined,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0].error.code, 'NO_ADAPTER')
})

test('reports an error terminal without usage as a failure', async () => {
  const llm = fakeLlm({
    usages: [undefined],
    finish: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'empty' } },
  })
  const result = await runProbe({
    llm,
    route: ROUTE,
    options: OPTIONS,
    signal: undefined,
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(result.attempts[0].error.code, 'EMPTY_RESPONSE')
})

test('refuses to run after the caller aborted', async () => {
  const llm = fakeLlm({ usages: [] })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runProbe({
      llm,
      route: ROUTE,
      options: OPTIONS,
      signal: controller.signal,
      sleep: async () => {},
      now: () => 0,
    }),
    (error) => error instanceof ProbeError && error.code === 'ABORTED',
  )
})

test('resolves an explicit route before any session source', () => {
  const route = resolveRoute({
    session: {},
    projections: { stateOf: () => ({ pending: { provider: 'hs', model: 'm2' } }) },
    explicit: ROUTE,
    events: [],
  })
  assert.equal(route.provider, 'a6')
})

test('resolves the pending selection, then the request header, then the last message', () => {
  const fromProjection = resolveRoute({
    session: {},
    projections: { stateOf: () => ({ pending: { provider: 'hs', model: 'm2' }, lastUsed: null }) },
    events: [],
  })
  assert.equal(fromProjection.provider, 'hs')

  const fromHeader = resolveRoute({
    session: { requestHeader: () => ({ config: { provider: 'gpt', model: 'm3' } }) },
    projections: undefined,
    events: [],
  })
  assert.equal(fromHeader.provider, 'gpt')

  const fromMessage = resolveRoute({
    session: {},
    projections: undefined,
    events: [{ type: 'assistant/message', data: { message: { source: { provider: 'a6', model: 'm1' } } } }],
  })
  assert.equal(fromMessage.provider, 'a6')
})

test('formats a successful report with both views', () => {
  const text = formatProbeReport({
    route: ROUTE,
    channelName: 'a6中转',
    options: { ...OPTIONS, rounds: 1 },
    payloadChars: 12_000,
    attempts: [
      { index: 0, summary: { prompt: 3_000, cacheRead: 0, uncached: 3_000, cacheWrite: 0, hitRate: 0 }, durationMs: 900, finish: { kind: 'stop' } },
      { index: 1, summary: { prompt: 3_000, cacheRead: 2_980, uncached: 20, cacheWrite: 0, hitRate: 2_980 / 3_000 }, durationMs: 800, finish: { kind: 'stop' } },
    ],
    sessionChannels: [{ provider: 'a6', requests: 12, prompt: 130_000, cacheRead: 120_000, hitRate: 120_000 / 130_000 }],
  })
  assert.match(text, /^缓存探测 a6中转 \/ deepseek-v4\.1-flash-1017：复测命中 99\.3%/u)
  assert.match(text, /真实流量 a6：命中 92\.3%/u)
  assert.match(text, /① 预热 prompt 3,000/u)
  assert.match(text, /② 复测1 prompt 3,000 · 读 2,980（99\.3%）/u)
  assert.match(text, /结论：缓存生效/u)
})

test('formats a zero-hit verdict', () => {
  const text = formatProbeReport({
    route: ROUTE,
    channelName: 'a6',
    options: { ...OPTIONS, rounds: 1 },
    payloadChars: 4_000,
    attempts: [
      { index: 0, summary: { prompt: 1_000, cacheRead: 0, uncached: 1_000, cacheWrite: 0, hitRate: 0 }, durationMs: 500, finish: { kind: 'stop' } },
      { index: 1, summary: { prompt: 1_000, cacheRead: 0, uncached: 1_000, cacheWrite: 0, hitRate: 0 }, durationMs: 500, finish: { kind: 'stop' } },
    ],
    sessionChannels: [],
  })
  assert.match(text, /未观测到命中/u)
  assert.match(text, /结论：未观测到缓存命中/u)
  assert.match(text, /真实流量：暂无已结算请求/u)
})