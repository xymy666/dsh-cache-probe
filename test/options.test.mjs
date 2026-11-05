import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CACHE_DEFAULTS,
  CACHE_LIMITS,
  PELICAN_DEFAULTS,
  REASONING_DEFAULT,
  SPEED_DEFAULTS,
  OptionError,
  clampOption,
  normalizeCacheOptions,
  normalizePelicanOptions,
  normalizeReasoning,
  normalizeReasoningSelection,
  normalizeSpeedOptions,
} from '../src/options.mjs'

test('fills cache, speed and pelican defaults', () => {
  assert.deepEqual(normalizeCacheOptions(undefined), CACHE_DEFAULTS)
  assert.deepEqual(normalizeSpeedOptions(undefined), SPEED_DEFAULTS)
  assert.deepEqual(normalizePelicanOptions(undefined), PELICAN_DEFAULTS)
  assert.equal(Object.isFrozen(normalizeCacheOptions({})), true)
  assert.equal(Object.isFrozen(normalizePelicanOptions({})), true)
})

test('accepts complete valid options and ignores unknown keys', () => {
  const cache = normalizeCacheOptions({ size: 4_000, rounds: 3, wait: 0, timeout: 30, extra: 1 })
  assert.deepEqual(cache, { size: 4_000, rounds: 3, wait: 0, timeout: 30 })
  const speed = normalizeSpeedOptions({ tokens: 512, rounds: 2, gap: 5, timeout: 60, extra: true })
  assert.deepEqual(speed, { tokens: 512, rounds: 2, gap: 5, timeout: 60 })
})

test('rejects non-objects, non-integers, and out-of-range values', () => {
  assert.throws(() => normalizeCacheOptions([]), OptionError)
  assert.throws(() => normalizeCacheOptions('x'), OptionError)
  assert.throws(() => normalizeCacheOptions({ rounds: 1.5 }), /必须是安全整数/u)
  assert.throws(() => normalizeCacheOptions({ size: 1_999 }), /2000–200000/u)
  assert.throws(() => normalizeSpeedOptions({ tokens: 2_049 }), /32–2048/u)
  assert.throws(() => normalizeSpeedOptions({ gap: -1 }), /0–30/u)
  assert.throws(() => normalizePelicanOptions({ timeout: 301 }), /10–300/u)
  assert.throws(() => normalizePelicanOptions('x'), OptionError)
})

test('normalizes one reasoning level', () => {
  assert.equal(normalizeReasoning(undefined), undefined)
  assert.equal(normalizeReasoning(''), undefined)
  assert.equal(normalizeReasoning('off'), 'off')
  assert.equal(normalizeReasoning(' max '), 'max')
  assert.throws(() => normalizeReasoning(1), /必须是字符串/u)
  assert.throws(() => normalizeReasoning('   '), /不能为空/u)
})

test('splits reasoning into one selection per test', () => {
  assert.deepEqual(normalizeReasoningSelection(undefined), {
    cache: REASONING_DEFAULT,
    speed: REASONING_DEFAULT,
    pelican: REASONING_DEFAULT,
  })
  assert.deepEqual(normalizeReasoningSelection({ cache: 'off', pelican: 'max' }), {
    cache: 'off',
    speed: REASONING_DEFAULT,
    pelican: 'max',
  })
  assert.deepEqual(normalizeReasoningSelection('off'), {
    cache: 'off',
    speed: 'off',
    pelican: 'off',
  })
  assert.equal(Object.isFrozen(normalizeReasoningSelection({})), true)
  assert.throws(() => normalizeReasoningSelection(1), /必须是对象或字符串/u)
  assert.throws(() => normalizeReasoningSelection([]), /必须是对象或字符串/u)
})

test('ignores the removed pelican token cap', () => {
  const options = normalizePelicanOptions({ tokens: 2_048, timeout: 120 })
  assert.deepEqual(options, { timeout: 120 })
})

test('cache and speed rounds have no upper bound', () => {
  assert.equal(normalizeCacheOptions({ rounds: 100 }).rounds, 100)
  assert.equal(normalizeSpeedOptions({ rounds: 250 }).rounds, 250)
  assert.throws(() => normalizeCacheOptions({ rounds: 0 }), /不小于 1/u)
  assert.throws(() => normalizeSpeedOptions({ rounds: 0 }), /不小于 1/u)
  assert.equal(clampOption(100, CACHE_LIMITS.rounds, 2), 100)
})

test('clamps UI values without throwing', () => {
  assert.equal(clampOption(5, [1, 5], 2), 5)
  assert.equal(clampOption(9, [1, 5], 2), 5)
  assert.equal(clampOption(0, [1, 5], 2), 1)
  assert.equal(clampOption(Number.NaN, [1, 5], 2), 2)
  assert.equal(clampOption('4', [1, 5], 2), 2)
})