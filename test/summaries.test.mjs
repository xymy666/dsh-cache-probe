import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeProbeResult } from '../src/probe.mjs'
import { summarizeSpeedResult } from '../src/speed.mjs'

/** One cache attempt. */
function cacheAttempt(index, hitRate, cacheRead = 1_000) {
  return {
    index,
    summary: {
      uncached: 1_000 - cacheRead,
      cacheRead,
      cacheWrite: 0,
      output: 32,
      prompt: 1_000,
      hitRate,
    },
  }
}

test('summarizes the latest and best cache hit', () => {
  const summary = summarizeProbeResult([
    cacheAttempt(0, 0, 0),
    cacheAttempt(1, 0.75),
    cacheAttempt(2, 0.9),
  ])
  assert.equal(summary.headline, '复测命中 90.0%')
  assert.equal(summary.lastHitRate, 0.9)
  assert.equal(summary.bestHitRate, 0.9)
  assert.match(summary.verdict, /^缓存生效/u)
})

test('reports no usable usage for an empty cache run', () => {
  const summary = summarizeProbeResult([{ index: 0, error: { code: 'TIMEOUT', message: 'x' } }])
  assert.equal(summary.headline, '无可用 usage')
  assert.match(summary.verdict, /无法统计/u)
  assert.equal(summary.bestHitRate, null)
})

test('summarizes speed medians and ranges', () => {
  const attempts = [
    { index: 0, ttftMs: 400, tps: 80, durationMs: 3_000, textChars: 10 },
    { index: 1, ttftMs: 500, tps: 70, durationMs: 3_200, textChars: 10 },
    { index: 2, ttftMs: 450, tps: 75, durationMs: 3_100, textChars: 10 },
  ]
  const summary = summarizeSpeedResult(attempts)
  assert.equal(summary.medianTtft, 450)
  assert.equal(summary.medianTps, 75)
  assert.deepEqual(summary.ttftRange, { min: 400, max: 500 })
  assert.deepEqual(summary.tpsRange, { min: 70, max: 80 })
  assert.match(summary.verdict, /^首 token 450ms/u)
})

test('speed summary handles a run without usage', () => {
  const summary = summarizeSpeedResult([{ index: 0, ttftMs: 300, tps: null, durationMs: 1_000, textChars: 0 }])
  assert.equal(summary.headline, 'TTFT 300ms')
  assert.match(summary.verdict, /输出速度无法计算/u)
})