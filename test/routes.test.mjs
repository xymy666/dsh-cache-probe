import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { ROUTES } from '../src/routes.mjs'

/**
 * Wait for one predicate.
 * @param predicate - condition.
 * @param timeout - maximum wait in milliseconds.
 */
async function waitFor(predicate, timeout = 500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Fake LLM service.
 * @param options - optional gate before the first token.
 * @returns the fake service.
 */
function makeLlm(options = {}) {
  const calls = []
  return {
    calls,
    listProviders() {
      return [{ id: 'a6', name: 'a6中转' }, { id: 'hs', name: 'HS' }]
    },
    async listModels(provider) {
      return provider === 'a6'
        ? [{ id: 'm1', name: 'M1' }]
        : [{ id: 'm2', name: 'M2' }]
    },
    async resolveModelInfo(provider, model) {
      if (options.reasoning === false) return { provider, id: model, name: model }
      return {
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }],
          defaultEffort: 'low',
        },
      }
    },
    async prepareCall(config, _signal, configure) {
      const proposed = typeof configure === 'function'
        ? { ...config, ...configure({}, { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }) }
        : config
      return {
        config: proposed,
        stream: async function* stream() {
          calls.push(proposed)
          if (options.gate !== undefined) await options.gate
          yield { type: 'text-delta', text: '1\n' }
          await new Promise((resolve) => setTimeout(resolve, 5))
          const output = proposed.maxTokens ?? 32
          yield { type: 'usage', usage: { inputTokens: 20, cacheReadTokens: 10, outputTokens: output, totalTokens: 30 + output } }
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
        },
      }
    },
  }
}

/**
 * Build a fake host context and capture the registered routes.
 * @param options - `llm`, `sessions`, `projections`, `pairing`.
 * @returns the captured routes and context.
 */
function setup(options = {}) {
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
    get(name) {
      if (name === 'sessions') return options.sessions
      if (name === 'sessionProjections') return options.projections
      if (name === 'remoteWebUiPairing') return options.pairing
      return undefined
    },
  }
  apply(ctx)
  return { routes, ctx }
}

/**
 * Build one fake request.
 * @param options - method, url, body, headers, remote address.
 * @returns the request.
 */
function makeRequest({ method = 'POST', url = ROUTES.run, body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers: {
      host: '127.0.0.1:56338',
      ...(method === 'POST' ? { 'x-dsh-cache-probe': '1', 'content-type': 'application/json' } : {}),
      ...headers,
    },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

/**
 * Invoke one route.
 * @param route - captured route.
 * @param request - fake request.
 * @returns the fake response.
 */
async function invoke(route, request) {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers[name] = value
    },
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers)
    },
    write(chunk) {
      this.body += chunk
      return true
    },
    flush() {},
    flushHeaders() {},
    on() {
      return this
    },
    off() {
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
      this.writableEnded = true
    },
    json() {
      return JSON.parse(this.body)
    },
  }
  await route.handler(request, response)
  return response
}

test('registers the models and run routes as exact paths', () => {
  const { routes } = setup()
  assert.deepEqual(routes.map((route) => route.path), [ROUTES.models, ROUTES.run])
  assert.ok(routes.every((route) => route.kind === 'exact'))
})

test('lists active providers, models, and a default route', async () => {
  const { routes } = setup()
  const response = await invoke(routes[0], makeRequest({ method: 'GET', url: ROUTES.models }))
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.providers.map((entry) => entry.id), ['a6', 'hs'])
  assert.deepEqual(body.providers[0].models[0].reasoning.efforts.map((effort) => effort.id), ['off', 'low'])
  assert.deepEqual(body.defaultRoute, { provider: 'a6', model: 'm1' })
})

test('omits reasoning when the model has none', async () => {
  const { routes } = setup({ llm: makeLlm({ reasoning: false }) })
  const response = await invoke(routes[0], makeRequest({ method: 'GET', url: ROUTES.models }))
  const body = response.json()
  assert.equal('reasoning' in body.providers[0].models[0], false)
  assert.equal('reasoning' in body.providers[1].models[0], false)
})

test('uses the session model selection for the default route', async () => {
  const session = {
    id: 's1',
    header: {},
    requestHeader: () => ({ config: { provider: 'a6', model: 'm1' } }),
    snapshotEvents: () => [],
  }
  const { routes } = setup({
    sessions: { list: () => [session] },
    projections: { stateOf: () => ({ lastUsed: { provider: 'hs', model: 'm2' } }) },
  })
  const response = await invoke(routes[0], makeRequest({ method: 'GET', url: `${ROUTES.models}?sessionId=s1` }))
  assert.deepEqual(response.json().defaultRoute, { provider: 'hs', model: 'm2' })
})

test('runs a cache test and returns structured attempts plus report', async () => {
  const llm = makeLlm()
  const { routes } = setup({ llm })
  const response = await invoke(routes[1], makeRequest({
    body: {
      kind: 'cache',
      provider: 'a6',
      model: 'm1',
      cache: { size: 2_000, rounds: 1, wait: 0, timeout: 10 },
    },
  }))
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.ok, true)
  assert.equal(body.kind, 'cache')
  assert.equal(body.channelName, 'a6中转')
  assert.equal(body.cache.attempts.length, 2)
  assert.equal(llm.calls[0].reasoningEffort, 'low')
  assert.match(body.cache.report, /缓存探测/u)
  assert.match(body.cache.summary.headline, /复测命中/u)
})

test('passes the selected reasoning effort to the request', async () => {
  const llm = makeLlm()
  const { routes } = setup({ llm })
  const response = await invoke(routes[1], makeRequest({
    body: {
      kind: 'speed',
      provider: 'a6',
      model: 'm1',
      reasoning: { cache: 'low', speed: 'off', pelican: 'low' },
      speed: { tokens: 32, rounds: 1, gap: 0, timeout: 10 },
    },
  }))
  assert.equal(response.statusCode, 200)
  assert.equal(llm.calls[0].reasoningEffort, 'off')
})

test('accepts the 0.5.0 single-string reasoning value', async () => {
  const llm = makeLlm()
  const { routes } = setup({ llm })
  const response = await invoke(routes[1], makeRequest({
    body: {
      kind: 'speed',
      provider: 'a6',
      model: 'm1',
      reasoning: 'off',
      speed: { tokens: 32, rounds: 1, gap: 0, timeout: 10 },
    },
  }))
  assert.equal(response.statusCode, 200)
  assert.equal(llm.calls[0].reasoningEffort, 'off')
})

test('keeps each test on its own reasoning effort', async () => {
  const llm = makeLlm()
  const { routes } = setup({ llm })
  const response = await invoke(routes[1], makeRequest({
    body: {
      kind: 'pelican',
      provider: 'a6',
      model: 'm1',
      reasoning: { cache: 'low', speed: 'high', pelican: 'off' },
      pelican: { timeout: 10 },
    },
  }))
  assert.equal(response.statusCode, 200)
  assert.equal(llm.calls[0].reasoningEffort, 'off')
  assert.match(response.json().pelican.report, /思考等级：off/u)
})

test('runs a speed test and returns structured attempts plus report', async () => {
  const { routes } = setup()
  const response = await invoke(routes[1], makeRequest({
    body: {
      kind: 'speed',
      provider: 'hs',
      model: 'm2',
      speed: { tokens: 32, rounds: 2, gap: 0, timeout: 10 },
    },
  }))
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.kind, 'speed')
  assert.equal(body.speed.attempts.length, 2)
  assert.match(body.speed.report, /测速/u)
  assert.match(body.speed.summary.headline, /TTFT/u)
})

test('streams speed progress as NDJSON', async () => {
  const { routes } = setup()
  const response = await invoke(routes[1], makeRequest({
    headers: { 'x-dsh-cache-probe-stream': '1' },
    body: {
      kind: 'speed',
      provider: 'a6',
      model: 'm1',
      speed: { tokens: 32, rounds: 1, gap: 0, timeout: 10 },
    },
  }))
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'], /application\/x-ndjson/u)
  const events = response.body.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(events.map((event) => event.type), ['start', 'attempt-start', 'attempt', 'done'])
  assert.equal(events[0].total, 1)
  assert.equal(events.at(-1).speed.attempts.length, 1)
})

test('streams a failed attempt and still sends done', async () => {
  const llm = makeLlm()
  llm.prepareCall = async () => {
    throw Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' })
  }
  const { routes } = setup({ llm })
  const response = await invoke(routes[1], makeRequest({
    headers: { 'x-dsh-cache-probe-stream': '1' },
    body: {
      kind: 'speed',
      provider: 'a6',
      model: 'm1',
      speed: { tokens: 32, rounds: 1, gap: 0, timeout: 10 },
    },
  }))
  const events = response.body.trim().split('\n').map((line) => JSON.parse(line))
  const attempt = events.find((event) => event.type === 'attempt')
  assert.equal(attempt.attempt.error.code, 'NO_ADAPTER')
  assert.equal(events.at(-1).type, 'done')
})

test('runs a pelican test and returns the extracted SVG', async () => {
  const llm = makeLlm()
  llm.prepareCall = async (config) => ({
    config: { ...config },
    stream: async function* stream() {
      yield { type: 'text-delta', text: '```svg\n<svg viewBox="0 0 10 10"><circle r="4"/></svg>\n```' }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 40, totalTokens: 60 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const { routes } = setup({ llm })
  const response = await invoke(routes[1], makeRequest({
    body: {
      kind: 'pelican',
      provider: 'a6',
      model: 'm1',
      pelican: { timeout: 10 },
    },
  }))
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.kind, 'pelican')
  assert.equal(body.pelican.svgSource, 'fence')
  assert.match(body.pelican.svg, /<circle r="4"\/>/u)
  assert.match(body.pelican.report, /鹈鹕测试/u)
  assert.equal(body.pelican.attempt.summary.output, 40)
})

test('streams pelican progress with a single round', async () => {
  const llm = makeLlm()
  llm.prepareCall = async (config) => ({
    config: { ...config },
    stream: async function* stream() {
      yield { type: 'text-delta', text: '<svg></svg>' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const { routes } = setup({ llm })
  const response = await invoke(routes[1], makeRequest({
    headers: { 'x-dsh-cache-probe-stream': '1' },
    body: {
      kind: 'pelican',
      provider: 'a6',
      model: 'm1',
      pelican: { timeout: 10 },
    },
  }))
  const events = response.body.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(events.map((event) => event.type), ['start', 'attempt-start', 'attempt', 'done'])
  assert.equal(events[0].total, 1)
  assert.equal(events.at(-1).pelican.svgSource, 'inline')
})

test('includes real session traffic only when a session is supplied', async () => {
  const events = [{
    type: 'assistant/message',
    data: {
      usage: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 10 },
      message: { source: { provider: 'a6', model: 'm1' } },
    },
  }]
  const session = { id: 's1', header: {}, snapshotEvents: () => events, requestHeader: () => undefined }
  const { routes } = setup({ sessions: { list: () => [session] } })
  const response = await invoke(routes[1], makeRequest({
    body: {
      kind: 'cache',
      provider: 'a6',
      model: 'm1',
      sessionId: 's1',
      cache: { size: 2_000, rounds: 1, wait: 0, timeout: 10 },
    },
  }))
  const body = response.json()
  assert.equal(body.cache.sessionChannels.length, 1)
  assert.equal(body.cache.sessionChannels[0].provider, 'a6')
})

test('rejects invalid kinds, routes, and options', async () => {
  const { routes } = setup()
  const invalidKind = await invoke(routes[1], makeRequest({ body: { kind: 'all', provider: 'a6', model: 'm1' } }))
  assert.equal(invalidKind.statusCode, 400)

  const invalidRoute = await invoke(routes[1], makeRequest({ body: { kind: 'cache', provider: '', model: 'm1' } }))
  assert.equal(invalidRoute.statusCode, 400)

  const invalidOption = await invoke(routes[1], makeRequest({
    body: { kind: 'cache', provider: 'a6', model: 'm1', cache: { rounds: 0 } },
  }))
  assert.equal(invalidOption.statusCode, 400)
})

test('rejects a second concurrent run with 409', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const llm = makeLlm({ gate })
  const { routes } = setup({ llm })
  const body = {
    kind: 'speed',
    provider: 'a6',
    model: 'm1',
    speed: { tokens: 32, rounds: 1, gap: 0, timeout: 10 },
  }
  const first = invoke(routes[1], makeRequest({ body }))
  await waitFor(() => llm.calls.length > 0)
  const second = await invoke(routes[1], makeRequest({ body }))
  assert.equal(second.statusCode, 409)
  release()
  const completed = await first
  assert.equal(completed.statusCode, 200)
})

test('enforces the loopback fence and the probe header', async () => {
  const { routes } = setup()
  const remote = await invoke(routes[1], makeRequest({ remoteAddress: '192.168.1.9' }))
  assert.equal(remote.statusCode, 403)

  const missingHeader = await invoke(routes[1], makeRequest({ headers: { 'x-dsh-cache-probe': undefined } }))
  assert.equal(missingHeader.statusCode, 403)
})

test('rejects the wrong method', async () => {
  const { routes } = setup()
  const response = await invoke(routes[0], makeRequest({ method: 'POST', url: ROUTES.models }))
  assert.equal(response.statusCode, 405)
})