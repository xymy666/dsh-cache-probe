import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SPEED_PROMPT,
  buildSpeedPrompt,
  formatSpeedReport,
  runSpeedTest,
  tokensPerSecond,
} from '../src/speed.mjs'

/** Route used by every test. */
const ROUTE = { provider: 'a6', model: 'deepseek-v4.1-flash-1017' }

/**
 * Build a clock that returns values in order and repeats the last one.
 * @param values - timestamp sequence.
 * @returns the clock function.
 */
function fakeClock(values) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

/**
 * Build a fake streaming LLM for speed tests.
 * @param options - per-round output counts, optional failure index, usage toggle.
 * @returns the fake service and its recorded calls.
 */
function fakeSpeedLlm({ outputs = [256, 255, 256], failAt = -1, withUsage = true } = {}) {
  const calls = []
  return {
    calls,
    async prepareCall(config) {
      const index = calls.length
      if (index === failAt) {
        throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' })
      }
      return {
        config: { ...config },
        stream: async function* stream(options) {
          calls.push({ config, text: options.messages[0].content[0].text })
          yield { type: 'text-delta', text: '1\n' }
          if (withUsage) {
            const output = outputs[index] ?? outputs.at(-1)
            yield {
              type: 'usage',
              usage: { inputTokens: 30, outputTokens: output, totalTokens: 30 + output },
            }
          }
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
        },
      }
    },
  }
}

/** Speed controls used by direct runner tests. */
const OPTIONS = { tokens: 256, rounds: 3, gap: 0, timeout: 10 }

test('builds a unique prompt per round', () => {
  const first = buildSpeedPrompt('aaa')
  const second = buildSpeedPrompt('bbb')
  assert.notEqual(first, second)
  assert.ok(first.includes(SPEED_PROMPT))
  assert.ok(first.startsWith('Run aaa'))
})

test('measures TTFT, decode time, and throughput across three rounds', async () => {
  const llm = fakeSpeedLlm()
  const result = await runSpeedTest({
    llm,
    route: ROUTE,
    options: OPTIONS,
    signal: undefined,
    sleep: async () => {},
    now: fakeClock([0, 400, 3400, 4000, 4400, 7400, 8000, 8400, 11400]),
  })

  assert.equal(result.attempts.length, 3)
  assert.equal(result.attempts[0].ttftMs, 400)
  assert.equal(result.attempts[0].decodeMs, 3000)
  assert.equal(result.attempts[0].durationMs, 3400)
  assert.equal(result.attempts[0].tps, 256 / 3)
  assert.equal(result.attempts[1].tps, 255 / 3)
  assert.equal(llm.calls.length, 3)
  assert.notEqual(llm.calls[0].text, llm.calls[1].text)
})

test('reports attempt starts and failed records to stream callbacks', async () => {
  const starts = []
  const records = []
  const result = await runSpeedTest({
    llm: fakeSpeedLlm({ failAt: 0 }),
    route: ROUTE,
    options: { ...OPTIONS, rounds: 2 },
    signal: undefined,
    sleep: async () => {},
    onAttemptStart: (index) => starts.push(index),
    onAttempt: (record) => records.push(record),
  })
  assert.deepEqual(starts, [0])
  assert.equal(records.length, 1)
  assert.equal(records[0].error.code, 'RATE_LIMIT')
  assert.equal(result.attempts.length, 1)
})

test('waits between rounds when gap is positive', async () => {
  const llm = fakeSpeedLlm({ outputs: [256, 256] })
  const sleeps = []
  await runSpeedTest({
    llm,
    route: ROUTE,
    options: { ...OPTIONS, rounds: 3, gap: 1 },
    signal: undefined,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    now: fakeClock([0, 100, 1100, 2000, 2100, 3100, 4000, 4100, 5100]),
  })
  assert.deepEqual(sleeps, [1_000, 1_000])
})

test('keeps TTFT but reports no throughput when usage is absent', async () => {
  const llm = fakeSpeedLlm({ withUsage: false })
  const result = await runSpeedTest({
    llm,
    route: ROUTE,
    options: { ...OPTIONS, rounds: 1 },
    signal: undefined,
    sleep: async () => {},
    now: fakeClock([0, 200, 1200]),
  })
  assert.equal(result.attempts[0].ttftMs, 200)
  assert.equal(result.attempts[0].summary, undefined)
  assert.equal(result.attempts[0].tps, null)
})

test('stops after a failed round and keeps earlier results', async () => {
  const llm = fakeSpeedLlm({ failAt: 1 })
  const result = await runSpeedTest({
    llm,
    route: ROUTE,
    options: OPTIONS,
    signal: undefined,
    sleep: async () => {},
    now: fakeClock([0, 100, 1100, 2000, 2100, 3100]),
  })
  assert.equal(result.attempts.length, 2)
  assert.equal(result.attempts[0].tps, 256 / 1)
  assert.equal(result.attempts[1].error.code, 'RATE_LIMIT')
})

test('throughput needs output tokens and a positive decode window', () => {
  assert.equal(tokensPerSecond({ output: 256 }, 3_000), 256 / 3)
  assert.equal(tokensPerSecond({ output: 0 }, 3_000), null)
  assert.equal(tokensPerSecond({ output: 256 }, 0), null)
  assert.equal(tokensPerSecond(undefined, 3_000), null)
})

test('formats a three-round speed report', () => {
  const summary = (output) => ({
    uncached: 30,
    cacheRead: 0,
    cacheWrite: 0,
    output,
    prompt: 30,
    hitRate: 0,
  })
  const text = formatSpeedReport({
    route: ROUTE,
    channelName: 'a6中转',
    options: { tokens: 256, rounds: 3, gap: 1, timeout: 120 },
    attempts: [
      { index: 0, ttftMs: 410, decodeMs: 3_000, durationMs: 3_410, tps: 256 / 3, textChars: 300, summary: summary(256), finish: { kind: 'max-tokens' } },
      { index: 1, ttftMs: 388, decodeMs: 3_050, durationMs: 3_438, tps: 255 / 3.05, textChars: 280, summary: summary(255), finish: { kind: 'max-tokens' } },
      { index: 2, ttftMs: 402, decodeMs: 3_000, durationMs: 3_402, tps: 256 / 3, textChars: 300, summary: summary(256), finish: { kind: 'max-tokens' } },
    ],
  })
  assert.match(text, /^测速 a6中转 \/ deepseek-v4\.1-flash-1017：TTFT 402ms · 85\.3 tok\/s/u)
  assert.match(text, /prompt 30 tok · 目标 256 tok · 3 轮/u)
  assert.match(text, /① 256 tok · TTFT 410ms · 85\.3 tok\/s · 总 3\.4s/u)
  assert.match(text, /汇总：TTFT 388ms–410ms（中位 402ms）/u)
  assert.match(text, /结论：首 token 402ms，生成 85\.3 tok\/s/u)
})

test('formats a report without usage', () => {
  const text = formatSpeedReport({
    route: ROUTE,
    channelName: 'a6中转',
    options: { tokens: 256, rounds: 1, gap: 1, timeout: 120 },
    attempts: [
      { index: 0, ttftMs: 200, decodeMs: 1_000, durationMs: 1_200, tps: null, textChars: 20, finish: { kind: 'max-tokens' } },
    ],
  })
  assert.match(text, /^测速 a6中转 \/ deepseek-v4\.1-flash-1017：TTFT 200ms/u)
  assert.match(text, /— tok · TTFT 200ms · — · 总 1\.2s/u)
  assert.match(text, /结论：首 token 200ms，输出速度无法计算（无 usage）/u)
})

test('formats a fully failed speed run', () => {
  const text = formatSpeedReport({
    route: ROUTE,
    channelName: 'a6中转',
    options: { tokens: 256, rounds: 2, gap: 1, timeout: 120 },
    attempts: [
      { index: 0, error: { code: 'RATE_LIMIT', message: 'rate limited' } },
      { index: 1, error: { code: 'RATE_LIMIT', message: 'rate limited' } },
    ],
  })
  assert.match(text, /^测速 a6中转 \/ deepseek-v4\.1-flash-1017：无可用响应/u)
  assert.match(text, /① 失败：渠道限流（RATE_LIMIT）：rate limited/u)
  assert.match(text, /结论：无法测速/u)
})