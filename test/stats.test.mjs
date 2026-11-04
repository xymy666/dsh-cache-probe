import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateSessionChannels,
  averageCacheAttempts,
  averageSpeedAttempts,
  formatDuration,
  formatLatency,
  formatRate,
  formatThroughput,
  formatTokens,
  median,
  range,
  summarizeUsage,
} from '../src/stats.mjs'

test('summarizes a cache hit', () => {
  const summary = summarizeUsage({
    inputTokens: 20,
    outputTokens: 1,
    totalTokens: 3001,
    cacheReadTokens: 2980,
  })
  assert.deepEqual(summary, {
    uncached: 20,
    cacheRead: 2980,
    cacheWrite: 0,
    output: 1,
    prompt: 3000,
    hitRate: 2980 / 3000,
  })
})

test('treats absent cache fields as zero', () => {
  const summary = summarizeUsage({ inputTokens: 120, outputTokens: 4 })
  assert.equal(summary.cacheRead, 0)
  assert.equal(summary.cacheWrite, 0)
  assert.equal(summary.hitRate, 0)
})

test('counts cache writes in the billed prompt', () => {
  const summary = summarizeUsage({
    inputTokens: 100,
    outputTokens: 2,
    cacheReadTokens: 300,
    cacheWriteTokens: 600,
  })
  assert.equal(summary.prompt, 1000)
  assert.equal(summary.hitRate, 0.3)
})

test('rejects malformed usage', () => {
  assert.equal(summarizeUsage(undefined), undefined)
  assert.equal(summarizeUsage({}), undefined)
  assert.equal(summarizeUsage({ inputTokens: -1, outputTokens: 1 }), undefined)
})

test('aggregates settled messages by provider', () => {
  const events = [
    {
      type: 'assistant/message',
      data: {
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 },
        message: { source: { provider: 'a6', model: 'm1' } },
      },
    },
    {
      type: 'assistant/message',
      data: {
        usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 200 },
        message: { source: { provider: 'a6', model: 'm1' } },
      },
    },
    {
      type: 'assistant/message',
      data: {
        usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 50 },
        message: { source: { provider: 'hs', model: 'm2' } },
      },
    },
    { type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } },
    { type: 'tool/result', data: {} },
  ]
  const rows = aggregateSessionChannels(events)
  assert.equal(rows.length, 2)
  const a6 = rows.find((row) => row.provider === 'a6')
  assert.equal(a6.requests, 2)
  assert.equal(a6.cacheRead, 1100)
  assert.equal(a6.prompt, 1400)
  assert.equal(a6.hitRate, 1100 / 1400)
  assert.deepEqual(a6.models, ['m1'])
  assert.equal(rows[0].provider, 'a6')
})

test('formats token counts and rates', () => {
  assert.equal(formatTokens(1234567), '1,234,567')
  assert.equal(formatTokens(0), '0')
  assert.equal(formatRate(0.99333), '99.3%')
  assert.equal(formatRate(null), '—')
  assert.equal(formatDuration(912), '912ms')
  assert.equal(formatDuration(1234), '1.2s')
})

test('formats latency and throughput', () => {
  assert.equal(formatLatency(402), '402ms')
  assert.equal(formatLatency(1240), '1.24s')
  assert.equal(formatLatency(undefined), '—')
  assert.equal(formatThroughput(85.333), '85.3 tok/s')
  assert.equal(formatThroughput(0), '—')
  assert.equal(formatThroughput(null), '—')
})

test('computes median and range', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), null)
  assert.equal(median([Number.NaN, 5]), 5)
  assert.deepEqual(range([3, 1, 2]), { min: 1, max: 3 })
  assert.equal(range([]), null)
})

test('averages cache retests without warm-up and weights the hit rate', () => {
  const attempts = [
    { index: 0, summary: { prompt: 1000, uncached: 1000, cacheRead: 0, cacheWrite: 0 }, durationMs: 1000 },
    { index: 1, summary: { prompt: 1000, uncached: 100, cacheRead: 900, cacheWrite: 0 }, durationMs: 2000 },
    { index: 2, summary: { prompt: 2000, uncached: 1000, cacheRead: 1000, cacheWrite: 0 }, durationMs: 4000 },
    { index: 3, error: { code: 'RATE_LIMIT', message: 'limited' } },
  ]
  const avg = averageCacheAttempts(attempts)
  assert.equal(avg.count, 2)
  assert.equal(avg.prompt, 1500)
  assert.equal(avg.uncached, 550)
  assert.equal(avg.cacheRead, 950)
  assert.equal(avg.cacheWrite, 0)
  assert.equal(avg.hitRate, 1900 / 3000)
  assert.equal(avg.durationMs, 3000)

  const withWarmup = averageCacheAttempts(attempts, { includeWarmup: true })
  assert.equal(withWarmup.count, 3)
  assert.equal(withWarmup.hitRate, 1900 / 4000)
  assert.equal(averageCacheAttempts([]), null)
  assert.equal(averageCacheAttempts([{ index: 1, error: { code: 'X', message: 'x' } }]), null)
})

test('averages speed rounds independently', () => {
  const attempts = [
    { index: 0, summary: { output: 100 }, ttftMs: 400, tps: 50, durationMs: 1000 },
    { index: 1, summary: { output: 200 }, ttftMs: 600, tps: 40, durationMs: 3000 },
    { index: 2, error: { code: 'RATE_LIMIT', message: 'limited' } },
  ]
  const avg = averageSpeedAttempts(attempts)
  assert.equal(avg.count, 2)
  assert.equal(avg.output, 150)
  assert.equal(avg.ttftMs, 500)
  assert.equal(avg.tps, 45)
  assert.equal(avg.durationMs, 2000)

  const noUsage = averageSpeedAttempts([
    { index: 0, ttftMs: 400, durationMs: 1000 },
    { index: 1, ttftMs: 600, durationMs: 3000 },
  ])
  assert.equal(noUsage.output, null)
  assert.equal(noUsage.tps, null)
  assert.equal(noUsage.ttftMs, 500)
  assert.equal(averageSpeedAttempts([]), null)
})