import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { apply } from '../lib/index.js'
import { ROUTES } from '../src/routes.mjs'

/**
 * Build a fake LLM that answers every request with usage.
 * @returns the fake service.
 */
function makeLlm() {
  return {
    listProviders() {
      return [{ id: 'a6', name: 'a6中转' }]
    },
    async listModels() {
      return [{ id: 'm1', name: 'M1' }]
    },
    async prepareCall(config) {
      return {
        config: { ...config },
        stream: async function* stream() {
          yield { type: 'text-delta', text: '1\n' }
          await new Promise((resolve) => setTimeout(resolve, 5))
          const output = config.maxTokens ?? 32
          yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: output, totalTokens: 15 + output } }
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
        },
      }
    },
  }
}

/**
 * Build a fake LLM whose stream waits until its signal aborts.
 * @returns the fake service.
 */
function makeSlowLlm() {
  return {
    listProviders() {
      return [{ id: 'a6', name: 'a6中转' }]
    },
    async listModels() {
      return [{ id: 'm1', name: 'M1' }]
    },
    async prepareCall(config, signal) {
      return {
        config: { ...config },
        stream: async function* stream() {
          yield { type: 'text-delta', text: '1\n' }
          await new Promise((resolve, reject) => {
            const abort = () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            }
            if (signal?.aborted === true) {
              abort()
              return
            }
            signal?.addEventListener('abort', abort, { once: true })
          })
        },
      }
    },
  }
}

/**
 * Start one real loopback HTTP server around the captured routes.
 * @param options - optional fake LLM override.
 * @returns `{ url, close }`.
 */
async function startServer(options = {}) {
  const routes = []
  const ctx = {
    llm: options.llm ?? makeLlm(),
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    logger: { info() {}, warn() {} },
    get() {
      return undefined
    },
  }
  apply(ctx)

  const server = createServer((req, res) => {
    const route = routes.find((candidate) => candidate.path === new URL(req.url ?? '/', 'http://x').pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'missing' } }))
      return
    }
    void route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('serves the catalog and a run over real loopback HTTP', async () => {
  const server = await startServer()
  try {
    const models = await fetch(`${server.url}${ROUTES.models}`)
    assert.equal(models.status, 200)
    const catalog = await models.json()
    assert.equal(catalog.ok, true)
    assert.deepEqual(catalog.providers[0].models, [{ id: 'm1', name: 'M1' }])

    const run = await fetch(`${server.url}${ROUTES.run}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-cache-probe': '1',
      },
      body: JSON.stringify({
        kind: 'speed',
        provider: 'a6',
        model: 'm1',
        speed: { tokens: 32, rounds: 1, gap: 0, timeout: 10 },
      }),
    })
    assert.equal(run.status, 200)
    const payload = await run.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.speed.attempts.length, 1)
    assert.match(payload.speed.report, /测速/u)
  } finally {
    await server.close()
  }
})

test('streams NDJSON over real loopback HTTP', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.url}${ROUTES.run}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-cache-probe': '1',
        'x-dsh-cache-probe-stream': '1',
      },
      body: JSON.stringify({
        kind: 'speed',
        provider: 'a6',
        model: 'm1',
        speed: { tokens: 32, rounds: 2, gap: 0, timeout: 10 },
      }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/u)
    const text = await response.text()
    const events = text.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(events[0].type, 'start')
    assert.equal(events.at(-1).type, 'done')
    assert.equal(events.filter((event) => event.type === 'attempt').length, 2)
  } finally {
    await server.close()
  }
})

test('aborting the client releases the single-flight gate', async () => {
  const server = await startServer({ llm: makeSlowLlm() })
  try {
    const body = JSON.stringify({
      kind: 'speed',
      provider: 'a6',
      model: 'm1',
      speed: { tokens: 32, rounds: 1, gap: 0, timeout: 30 },
    })
    const abort = new AbortController()
    const first = await fetch(`${server.url}${ROUTES.run}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-cache-probe': '1',
        'x-dsh-cache-probe-stream': '1',
      },
      body,
      signal: abort.signal,
    })
    const reader = first.body.getReader()
    await reader.read()
    abort.abort()
    await reader.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 200))

    const second = await fetch(`${server.url}${ROUTES.run}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-cache-probe': '1',
        'x-dsh-cache-probe-stream': '1',
      },
      body,
    })
    assert.equal(second.status, 200)
    await second.body?.cancel?.()
  } finally {
    await server.close()
  }
})

test('rejects a real HTTP run without the custom header', async () => {
  const server = await startServer()
  try {
    const run = await fetch(`${server.url}${ROUTES.run}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'speed', provider: 'a6', model: 'm1' }),
    })
    assert.equal(run.status, 403)
    const payload = await run.json()
    assert.equal(payload.error.code, 'FORBIDDEN')
  } finally {
    await server.close()
  }
})