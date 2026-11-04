import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PELICAN_PROMPT,
  buildPelicanPrompt,
  extractSvg,
  normalizePelicanError,
  runPelicanTest,
  summarizePelicanResult,
} from '../src/pelican.mjs'

/**
 * Build a fake LLM that streams one reply.
 * @param text - text chunks to emit.
 * @param options - usage toggle and terminal failure.
 * @returns the fake service.
 */
function makeLlm(text, options = {}) {
  const calls = []
  return {
    calls,
    async prepareCall(config) {
      return {
        config: { ...config },
        stream: async function* stream(request) {
          calls.push({ config, request })
          if (options.failPrepare !== undefined) throw options.failPrepare
          yield { type: 'text-delta', text }
          if (options.withUsage !== false) {
            yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 120, totalTokens: 160 } }
          }
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
        },
      }
    },
  }
}

const ROUTE = { provider: 'a6', model: 'deepseek-v4.1-flash-1017' }
const OPTIONS = { tokens: 512, timeout: 10 }

test('builds a unique prompt around the shared instruction', () => {
  const first = buildPelicanPrompt('aaa')
  const second = buildPelicanPrompt('bbb')
  assert.ok(first.includes(PELICAN_PROMPT))
  assert.ok(first.endsWith('Sketch id: aaa'))
  assert.notEqual(first, second)
})

test('extracts a fenced SVG and closes a truncated document', () => {
  const text = 'Here you go:\n```svg\n<svg viewBox="0 0 10 10"><circle r="4"/></svg>\n```\nEnjoy.'
  const result = extractSvg(text)
  assert.equal(result.source, 'fence')
  assert.ok(result.svg.includes('<circle r="4"/>'))
  assert.equal(result.length, result.svg.length)

  const truncated = extractSvg('```svg\n<svg viewBox="0 0 10 10"><rect width="4" height="4"/>')
  assert.equal(truncated.source, 'fence')
  assert.ok(truncated.svg.endsWith('</svg>'))
})

test('falls back to an inline SVG document', () => {
  const result = extractSvg('Sure. <svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg> Done.')
  assert.equal(result.source, 'inline')
  assert.ok(result.svg.startsWith('<svg'))
  assert.ok(result.svg.endsWith('</svg>'))
})

test('strips scripts, event handlers, foreignObject and external hrefs', () => {
  const dirty = [
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
    '<style>@import url(https://evil.example/a.css);</style>',
    '<script>alert(2)</script>',
    '<foreignObject><div>x</div></foreignObject>',
    '<a href="https://evil.example/x"><text>link</text></a>',
    '<image xlink:href="//evil.example/y"/>',
    '<circle onclick="alert(3)" r="2" only="keep"/>',
    '</svg>',
  ].join('')
  const result = extractSvg(dirty)
  assert.equal(result.source, 'inline')
  assert.ok(!result.svg.includes('<script'))
  assert.ok(!result.svg.includes('onload'))
  assert.ok(!result.svg.includes('foreignObject'))
  assert.ok(!result.svg.includes('https://evil.example'))
  assert.ok(!result.svg.includes('//evil.example'))
  assert.ok(!result.svg.includes('onclick'))
  assert.ok(result.svg.includes('only="keep"'))
  assert.ok(!result.svg.includes('@import'))
  assert.ok(!result.svg.includes('url(https://'))
})

test('strips fixed root width/height but keeps viewBox', () => {
  const result = extractSvg('<svg width="1200" height="800" viewBox="0 0 1200 800" style="width:1200px;background:#fff"><rect width="4" height="4"/></svg>')
  assert.doesNotMatch(result.svg, /<svg[^>]*\swidth\s*=/iu)
  assert.doesNotMatch(result.svg, /<svg[^>]*\sheight\s*=/iu)
  assert.match(result.svg, /viewBox="0 0 1200 800"/u)
  assert.match(result.svg, /background:#fff/u)
  assert.doesNotMatch(result.svg, /width:1200px/u)
})

test('returns null and keeps the source length zero when no SVG exists', () => {
  const result = extractSvg('I cannot draw that.')
  assert.equal(result.svg, null)
  assert.equal(result.source, 'none')
  assert.equal(result.length, 0)
  assert.equal(extractSvg(undefined).svg, null)
})

test('runs one request and reports timings and usage', async () => {
  const llm = makeLlm('```svg\n<svg></svg>\n```')
  let clock = 0
  const attempt = await runPelicanTest({
    llm,
    route: ROUTE,
    options: OPTIONS,
    now: () => {
      clock += 250
      return clock
    },
  })
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].config.maxTokens, 512)
  assert.equal(llm.calls[0].request.messages[0].content[0].text.includes('pelican riding a bicycle'), true)
  assert.equal(attempt.summary.output, 120)
  assert.equal(typeof attempt.ttftMs, 'number')
  assert.equal(typeof attempt.durationMs, 'number')
})

test('normalizes failures to a stable code', () => {
  assert.deepEqual(normalizePelicanError(Object.assign(new Error('nope'), { code: 'RATE_LIMIT' })), {
    code: 'RATE_LIMIT',
    message: 'nope',
  })
  assert.equal(normalizePelicanError(new Error('plain')).code, 'PROBE_FAILED')
})

test('summarizes both a generated SVG and a missing one', () => {
  const attempt = { index: 0, ttftMs: 400, durationMs: 2_000, tps: 60, summary: { output: 120 } }
  const generated = summarizePelicanResult({
    route: ROUTE,
    channelName: 'a6中转',
    options: OPTIONS,
    attempt,
    extracted: { svg: '<svg></svg>', source: 'fence', length: 11 },
  })
  assert.match(generated.summary.headline, /已生成 SVG/u)
  assert.match(generated.report, /SVG：11 字符（fence）/u)

  const missing = summarizePelicanResult({
    route: ROUTE,
    channelName: 'a6中转',
    options: OPTIONS,
    attempt,
    extracted: { svg: null, source: 'none', length: 0 },
  })
  assert.equal(missing.summary.headline, '未提取到 SVG')
  assert.match(missing.report, /SVG：未提取到/u)

  const failed = summarizePelicanResult({
    route: ROUTE,
    channelName: 'a6中转',
    options: OPTIONS,
    attempt: { index: 0, error: { code: 'RATE_LIMIT', message: 'rate limited' } },
    extracted: { svg: null, source: 'none', length: 0 },
  })
  assert.equal(failed.summary.headline, '无可用响应')
  assert.match(failed.report, /① 失败：rate limited（RATE_LIMIT）/u)
})
