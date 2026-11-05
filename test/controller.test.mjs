import test from 'node:test'
import assert from 'node:assert/strict'

import { catalogRoutes, createController } from '../src/client.mjs'

/** One fake layout service. */
function makeLayout() {
  const selected = []
  return {
    selected,
    selectPanel(id) {
      selected.push(id)
    },
  }
}

/** One fake Storage. */
function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    dump() {
      return Object.fromEntries(values)
    },
  }
}

/** One fake fetch response. */
function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

/**
 * One fake NDJSON response.
 * @param events - events to emit, one per read.
 * @param options - `signal` and `hang` after the events.
 * @returns a fetch-like response with a streaming body.
 */
function ndjsonResponse(events, options = {}) {
  const encoder = new TextEncoder()
  let index = 0
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/x-ndjson; charset=utf-8' : null
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index < events.length) {
              const value = encoder.encode(`${JSON.stringify(events[index])}\n`)
              index += 1
              return { done: false, value }
            }
            if (options.hang === true) {
              return new Promise((resolve, reject) => {
                const signal = options.signal
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
            }
            return { done: true, value: undefined }
          },
          releaseLock() {},
        }
      },
    },
  }
}

/** Catalog returned by the models route. */
const CATALOG = {
  ok: true,
  providers: [
    { id: 'a6', name: 'a6中转', models: [{ id: 'm1', name: 'M1' }] },
    { id: 'hs', name: 'HS', models: [{ id: 'm2', name: 'M2' }] },
    { id: 'empty', name: 'Empty', models: [] },
  ],
  defaultRoute: { provider: 'hs', model: 'm2' },
}

test('opens the page and loads the catalog with the session default', async () => {
  const layout = makeLayout()
  const urls = []
  const controller = createController({
    layout,
    storage: makeStorage(),
    fetchImpl: async (url) => {
      urls.push(String(url))
      return response(CATALOG)
    },
  })
  controller.open('s1')
  assert.deepEqual(layout.selected, ['channel-test'])
  await controller.ensureCatalog()
  const state = controller.getSnapshot()
  assert.equal(state.catalog.providers.length, 3)
  assert.equal(state.provider, 'hs')
  assert.deepEqual(state.route, { provider: 'hs', model: 'm2' })
  assert.equal(state.modelByProvider.hs, 'm2')
  assert.match(urls[0], /sessionId=s1/u)
})

test('prefers the saved route over the host default', async () => {
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage({
      'dsh-cache-probe.page.route.v1': JSON.stringify({ provider: 'a6', model: 'm1' }),
    }),
    fetchImpl: async () => response(CATALOG),
  })
  await controller.ensureCatalog()
  const state = controller.getSnapshot()
  assert.equal(state.provider, 'a6')
  assert.deepEqual(state.route, { provider: 'a6', model: 'm1' })
  assert.equal(state.modelByProvider.a6, 'm1')
})

test('persists route and advanced options', () => {
  const storage = makeStorage()
  const controller = createController({
    layout: makeLayout(),
    storage,
    fetchImpl: async () => response(CATALOG),
  })
  controller.setRoute('a6', 'm1')
  controller.setCacheOption('rounds', 99)
  controller.setSpeedOption('tokens', 1)
  assert.equal(controller.getSnapshot().cacheOptions.rounds, 99)
  assert.equal(controller.getSnapshot().speedOptions.tokens, 32)
  const savedSelection = JSON.parse(storage.dump()['dsh-cache-probe.page.route.v1'])
  assert.equal(savedSelection.provider, 'a6')
  assert.equal(savedSelection.model, 'm1')
  assert.equal(savedSelection.modelByProvider.a6, 'm1')
  const savedOptions = JSON.parse(storage.dump()['dsh-cache-probe.page.options.v1'])
  assert.equal(savedOptions.cache.rounds, 99)
  assert.equal(savedOptions.speed.tokens, 32)
})

test('runs one cache test and stores its payload', async () => {
  const calls = []
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/models')) return response(CATALOG)
      return response({
        ok: true,
        kind: 'cache',
        cache: { attempts: [], report: 'cache report', summary: { headline: 'cache headline', verdict: 'ok' } },
      })
    },
  })
  await controller.ensureCatalog()
  await controller.run('cache')
  const state = controller.getSnapshot()
  assert.equal(state.cache.summary.headline, 'cache headline')
  assert.equal(state.running, false)
  const runCall = calls.find((call) => call.url.includes('/run'))
  assert.equal(runCall.init.headers['x-dsh-cache-probe'], '1')
  assert.equal(runCall.init.headers['x-dsh-cache-probe-stream'], '1')
  const body = JSON.parse(runCall.init.body)
  assert.equal(body.kind, 'cache')
  assert.equal(body.provider, 'hs')
  assert.equal(body.model, 'm2')
})

test('persists the last result with a checked timestamp', async () => {
  const storage = makeStorage()
  const controller = createController({
    layout: makeLayout(),
    storage,
    fetchImpl: async (url) => {
      if (String(url).includes('/models')) return response(CATALOG)
      return response({
        ok: true,
        kind: 'speed',
        speed: { attempts: [], report: 'speed report', summary: { headline: 'TTFT 400ms', verdict: 'ok' } },
      })
    },
  })
  await controller.ensureCatalog()
  const before = Date.now()
  await controller.run('speed')
  const after = Date.now()

  const state = controller.getSnapshot()
  assert.equal(typeof state.speedCheckedAt, 'number')
  assert.ok(state.speedCheckedAt >= before && state.speedCheckedAt <= after)
  assert.deepEqual(state.speedRoute.provider, 'hs')
  assert.equal(state.speedRoute.providerName, 'HS')

  const saved = JSON.parse(storage.dump()['dsh-cache-probe.page.result.v1'])
  assert.equal(saved.speed.payload.summary.headline, 'TTFT 400ms')
  assert.equal(saved.speed.route.model, 'm2')

  const restored = createController({
    layout: makeLayout(),
    storage,
    fetchImpl: async () => response(CATALOG),
  })
  await restored.ensureCatalog()
  const next = restored.getSnapshot()
  assert.equal(next.speed.summary.headline, 'TTFT 400ms')
  assert.equal(next.speedCheckedAt, state.speedCheckedAt)
  assert.equal(next.speedRoute.provider, 'hs')
})

test('updates one kind without dropping the other saved result', async () => {
  const storage = makeStorage()
  const controller = createController({
    layout: makeLayout(),
    storage,
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models')) return response(CATALOG)
      const body = JSON.parse(init.body)
      return response({
        ok: true,
        kind: body.kind,
        [body.kind]: { attempts: [], report: `${body.kind} report`, summary: { headline: `${body.kind} headline`, verdict: 'ok' } },
      })
    },
  })
  await controller.ensureCatalog()
  await controller.run('speed')
  await controller.run('cache')

  const saved = JSON.parse(storage.dump()['dsh-cache-probe.page.result.v1'])
  assert.equal(saved.cache.payload.summary.headline, 'cache headline')
  assert.equal(saved.speed.payload.summary.headline, 'speed headline')

  const restored = createController({
    layout: makeLayout(),
    storage,
    fetchImpl: async () => response(CATALOG),
  })
  await restored.ensureCatalog()
  assert.equal(restored.getSnapshot().cache.summary.headline, 'cache headline')
  assert.equal(restored.getSnapshot().speed.summary.headline, 'speed headline')
})

test('keeps results when the selection or options change', async () => {
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async (url) => {
      if (String(url).includes('/models')) return response(CATALOG)
      return response({
        ok: true,
        kind: 'cache',
        cache: { attempts: [], report: 'cache report', summary: { headline: 'cache headline', verdict: 'ok' } },
      })
    },
  })
  await controller.ensureCatalog()
  await controller.run('cache')
  controller.setProvider('a6')
  controller.setSpeedOption('tokens', 128)
  const state = controller.getSnapshot()
  assert.equal(state.cache.summary.headline, 'cache headline')
  assert.equal(state.cacheCheckedAt !== null, true)
  assert.equal(state.cacheRoute.provider, 'hs')
})

test('ignores a damaged saved result', () => {
  const storage = makeStorage({ 'dsh-cache-probe.page.result.v1': '{not json' })
  const controller = createController({
    layout: makeLayout(),
    storage,
    fetchImpl: async () => response(CATALOG),
  })
  const state = controller.getSnapshot()
  assert.equal(state.cache, null)
  assert.equal(state.speed, null)
  assert.equal(state.cacheCheckedAt, null)
})

test('streams per-round progress and stores the final payload', async () => {
  const first = {
    index: 0,
    summary: { output: 32, prompt: 20 },
    ttftMs: 400,
    decodeMs: 1_000,
    durationMs: 1_400,
    tps: 32,
    textChars: 10,
  }
  const second = {
    index: 1,
    summary: { output: 32, prompt: 20 },
    ttftMs: 420,
    decodeMs: 1_100,
    durationMs: 1_520,
    tps: 29.1,
    textChars: 10,
  }
  const done = {
    ok: true,
    kind: 'speed',
    route: { provider: 'hs', model: 'm2' },
    channelName: 'HS',
    durationMs: 3_000,
    speed: {
      attempts: [first, second],
      report: 'speed report',
      summary: { headline: 'TTFT 410ms', verdict: 'ok' },
    },
  }
  const events = [
    { type: 'start', kind: 'speed', route: { provider: 'hs', model: 'm2' }, channelName: 'HS', options: { tokens: 32, rounds: 2, gap: 1, timeout: 10 }, total: 2 },
    { type: 'attempt-start', index: 0 },
    { type: 'attempt', index: 0, attempt: first, completed: 1, total: 2 },
    { type: 'wait', seconds: 1 },
    { type: 'wait-done' },
    { type: 'attempt-start', index: 1 },
    { type: 'attempt', index: 1, attempt: second, completed: 2, total: 2 },
    { type: 'done', ...done },
  ]
  const snapshots = []
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models')) return response(CATALOG)
      return ndjsonResponse(events, { signal: init.signal })
    },
  })
  await controller.ensureCatalog()
  controller.subscribe(() => snapshots.push(controller.getSnapshot()))
  await controller.run('speed')

  const state = controller.getSnapshot()
  assert.equal(state.speed.summary.headline, 'TTFT 410ms')
  assert.equal(state.progress, null)
  assert.equal(state.running, false)
  assert.ok(snapshots.some((snapshot) => snapshot.progress?.activeIndex === 0))
  assert.ok(snapshots.some((snapshot) => snapshot.progress?.phase === 'wait'))
  assert.ok(snapshots.some((snapshot) => snapshot.progress?.attempts.length === 1))
})

test('cancel keeps partial progress without an error banner', async () => {
  const first = {
    index: 0,
    summary: { output: 32, prompt: 20 },
    ttftMs: 400,
    decodeMs: 1_000,
    durationMs: 1_400,
    tps: 32,
    textChars: 10,
  }
  const events = [
    { type: 'start', kind: 'speed', route: { provider: 'hs', model: 'm2' }, channelName: 'HS', options: { tokens: 32, rounds: 2, gap: 1, timeout: 10 }, total: 2 },
    { type: 'attempt-start', index: 0 },
    { type: 'attempt', index: 0, attempt: first, completed: 1, total: 2 },
  ]
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models')) return response(CATALOG)
      return ndjsonResponse(events, { signal: init.signal, hang: true })
    },
  })
  await controller.ensureCatalog()
  const running = controller.run('speed')
  while (controller.getSnapshot().progress?.attempts.length !== 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  controller.cancel()
  await running

  const state = controller.getSnapshot()
  assert.equal(state.running, false)
  assert.equal(state.error, null)
  assert.equal(state.speed, null)
  assert.equal(state.progress.cancelled, true)
  assert.equal(state.progress.attempts.length, 1)
})

test('run all executes cache then speed then pelican', async () => {
  const order = []
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models')) return response(CATALOG)
      const body = JSON.parse(init.body)
      order.push(body.kind)
      return response({
        ok: true,
        kind: body.kind,
        [body.kind]: body.kind === 'pelican'
          ? { attempt: { index: 0, ttftMs: 300, durationMs: 1_000 }, text: '<svg></svg>', svg: '<svg></svg>', svgLength: 11, report: 'pelican report', summary: { headline: 'pelican', verdict: 'ok' } }
          : { attempts: [], report: `${body.kind} report`, summary: { headline: body.kind, verdict: 'ok' } },
      })
    },
  })
  await controller.ensureCatalog()
  await controller.runAll()
  assert.deepEqual(order, ['cache', 'speed', 'pelican'])
  assert.equal(controller.getSnapshot().cache.summary.headline, 'cache')
  assert.equal(controller.getSnapshot().speed.summary.headline, 'speed')
  assert.equal(typeof controller.getSnapshot().cacheCheckedAt, 'number')
  assert.equal(typeof controller.getSnapshot().speedCheckedAt, 'number')
})

test('runs a pelican test and records its own timestamp', async () => {
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models')) return response(CATALOG)
      const body = JSON.parse(init.body)
      assert.equal(body.pelican.tokens, undefined)
      assert.equal('reasoning' in body, false)
      return response({
        ok: true,
        kind: 'pelican',
        pelican: {
          attempt: { index: 0, ttftMs: 300, durationMs: 1_200, tps: 40, summary: { output: 48 } },
          text: '<svg></svg>',
          svg: '<svg></svg>',
          svgSource: 'inline',
          svgLength: 11,
          report: 'pelican report',
          summary: { headline: '已生成 SVG', verdict: 'ok' },
        },
      })
    },
  })
  await controller.ensureCatalog()
  await controller.run('pelican')
  const state = controller.getSnapshot()
  assert.equal(state.pelican.svg, '<svg></svg>')
  assert.equal(typeof state.pelicanCheckedAt, 'number')
  assert.equal(state.pelicanRoute.provider, 'hs')
})

test('selects, persists, and sends the reasoning effort', async () => {
  const storage = makeStorage()
  const catalog = {
    ok: true,
    providers: [{
      id: 'a6',
      name: 'a6中转',
      models: [{
        id: 'm1',
        name: 'M1',
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }], defaultEffort: 'low' },
      }],
    }],
    defaultRoute: { provider: 'a6', model: 'm1' },
  }
  const bodies = []
  const controller = createController({
    layout: makeLayout(),
    storage,
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models')) return response(catalog)
      bodies.push(JSON.parse(init.body))
      return response({
        ok: true,
        kind: 'pelican',
        pelican: {
          attempt: { index: 0, ttftMs: 300, durationMs: 1_200, tps: 40, summary: { output: 48 } },
          text: '<svg></svg>',
          svg: '<svg></svg>',
          svgSource: 'inline',
          svgLength: 11,
          report: 'pelican report',
          summary: { headline: '已生成 SVG', verdict: 'ok' },
        },
      })
    },
  })
  await controller.ensureCatalog()
  assert.equal(controller.getSnapshot().reasoning, 'low')
  controller.setReasoning('off')
  assert.equal(controller.getSnapshot().reasoning, 'off')
  await controller.run('pelican')
  assert.equal(bodies[0].reasoning, 'off')
  assert.equal(bodies[0].pelican.tokens, undefined)

  const persisted = Object.values(storage.dump())
    .map((value) => { try { return JSON.parse(value) } catch { return null } })
    .find((value) => value?.reasoning === 'off')
  assert.ok(persisted)
})

test('surfaces a host error and keeps running false', async () => {
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async (url) => {
      if (String(url).includes('/models')) return response(CATALOG)
      return response({ ok: false, error: { code: 'BUSY', message: '已有渠道测试正在进行' } }, 409)
    },
  })
  await controller.ensureCatalog()
  await controller.run('speed')
  const state = controller.getSnapshot()
  assert.match(state.error, /已有渠道测试正在进行/u)
  assert.equal(state.running, false)
})

test('remembers each provider model and restores it on switch back', async () => {
  const catalog = {
    ok: true,
    providers: [
      { id: 'a6', name: 'a6中转', models: [{ id: 'm1', name: 'M1' }, { id: 'm3', name: 'M3' }] },
      { id: 'hs', name: 'HS', models: [{ id: 'm2', name: 'M2' }] },
    ],
    defaultRoute: { provider: 'hs', model: 'm2' },
  }
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async () => response(catalog),
  })
  await controller.ensureCatalog()
  controller.setProvider('a6')
  controller.setModel('m3')
  assert.deepEqual(controller.getSnapshot().route, { provider: 'a6', model: 'm3' })

  controller.setProvider('hs')
  assert.deepEqual(controller.getSnapshot().route, { provider: 'hs', model: 'm2' })

  controller.setProvider('a6')
  assert.deepEqual(controller.getSnapshot().route, { provider: 'a6', model: 'm3' })
  assert.equal(controller.getSnapshot().modelByProvider.a6, 'm3')
})

test('keeps an empty provider selected but refuses to run', async () => {
  const calls = []
  const controller = createController({
    layout: makeLayout(),
    storage: makeStorage(),
    fetchImpl: async (url) => {
      calls.push(String(url))
      return response(CATALOG)
    },
  })
  await controller.ensureCatalog()
  controller.setProvider('empty')
  const state = controller.getSnapshot()
  assert.equal(state.provider, 'empty')
  assert.equal(state.route, null)
  assert.equal(state.modelByProvider.empty, undefined)

  await controller.run('cache')
  assert.match(controller.getSnapshot().error, /请选择供应商和模型/u)
  assert.equal(calls.some((url) => url.includes('/run')), false)
})

test('close returns the center column to the conversation', () => {
  const layout = makeLayout()
  const controller = createController({
    layout,
    storage: makeStorage(),
    fetchImpl: async () => response(CATALOG),
  })
  controller.close()
  assert.deepEqual(layout.selected, [null])
})

test('flattens a catalog into selectable routes', () => {
  const routes = catalogRoutes(CATALOG)
  assert.deepEqual(routes.map((route) => route.key), ['a6\u0000m1', 'hs\u0000m2'])
  assert.equal(routes[1].providerName, 'HS')
})