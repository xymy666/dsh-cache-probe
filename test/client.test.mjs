import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { apply } from '../src/client.mjs'

test('registers the sidebar page, main page, and one composer button', () => {
  const registrations = []
  const ctx = {
    get(key) {
      if (key === 'layout') return { selectPanel() {} }
      return undefined
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(_name, factory) {
        const value = factory()
        if (value !== undefined && typeof value[Symbol.iterator] === 'function') {
          for (const _disposer of value) { /* drain the generator */ }
        }
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }

  apply(ctx)

  assert.deepEqual(registrations.map(({ definition }) => definition.name), [
    'sidebar.panellist',
    'main',
    'conversation.composer.dock',
  ])
  const [sidebar, main, dock] = registrations
  assert.equal(sidebar.definition.id, 'channel-test')
  assert.equal(sidebar.definition.order, 40)
  assert.equal(typeof sidebar.definition.label, 'function')

  assert.equal(main.definition.key, 'channel-test')
  const face = main.definition.inject()
  assert.equal(typeof face.controller.open, 'function')
  assert.equal(typeof face.controller.runAll, 'function')
  assert.equal(typeof face.translate, 'function')

  assert.equal(dock.definition.id, 'channel-test')
  assert.equal(dock.definition.order, 2)
})

test('renders the page shell with the injected translator', () => {
  const registrations = []
  const ctx = {
    get(key) {
      if (key === 'layout') return { selectPanel() {} }
      return undefined
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(_name, factory) {
        const value = factory()
        if (value !== undefined && typeof value[Symbol.iterator] === 'function') {
          for (const _disposer of value) { /* drain */ }
        }
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }
  apply(ctx)

  const previousReact = globalThis.React
  const previousH = globalThis.h
  globalThis.React = {
    Fragment: 'Fragment',
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useState(value) {
      return [value, () => {}]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
  globalThis.h = (type, props, ...children) => ({
    type,
    props,
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  })

  try {
    const main = registrations.find(({ definition }) => definition.name === 'main')
    const tree = main.component(main.definition.inject())
    const strings = []
    collectStrings(tree, strings)
    assert.ok(strings.includes('panel.title'))
    assert.ok(strings.includes('label.provider'))
    assert.ok(strings.includes('label.model'))
    assert.ok(strings.includes('action.runAll'))
    assert.ok(strings.includes('action.cache'))
    assert.ok(strings.includes('action.speed'))
    assert.ok(strings.includes('error.noRoute'))
    assert.equal(strings.includes('label.lastChecked'), false)
    assert.equal(strings.includes('m1'), false)
  } finally {
    globalThis.React = previousReact
    globalThis.h = previousH
  }
})

test('renders cache and speed result cards with attempts', () => {
  const registrations = []
  const ctx = {
    get(key) {
      if (key === 'layout') return { selectPanel() {} }
      return undefined
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(_name, factory) {
        const value = factory()
        if (value !== undefined && typeof value[Symbol.iterator] === 'function') {
          for (const _disposer of value) { /* drain */ }
        }
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }
  apply(ctx)

  const cacheResult = {
    attempts: [
      { index: 0, summary: { prompt: 1_000, uncached: 1_000, cacheRead: 0, cacheWrite: 0, hitRate: 0, output: 32 }, durationMs: 1_000 },
      { index: 1, summary: { prompt: 1_000, uncached: 100, cacheRead: 900, cacheWrite: 0, hitRate: 0.9, output: 32 }, durationMs: 1_100 },
    ],
    payloadChars: 12_000,
    sessionChannels: [{ provider: 'a6', requests: 2, prompt: 2_000, hitRate: 0.5 }],
    report: 'CACHE REPORT',
    summary: { headline: '复测命中 90.0%', verdict: '缓存生效' },
  }
  const speedResult = {
    attempts: [
      { index: 0, summary: { output: 32, prompt: 20 }, ttftMs: 400, decodeMs: 1_000, durationMs: 1_400, tps: 32, textChars: 10 },
    ],
    report: 'SPEED REPORT',
    summary: { headline: 'TTFT 400ms · 32.0 tok/s', verdict: '首 token 400ms' },
  }
  const fakeController = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      catalog: {
        providers: [
          { id: 'a6', name: 'a6中转', models: [{ id: 'm1', name: 'M1' }] },
          { id: 'empty', name: 'Empty', models: [] },
        ],
      },
      catalogError: null,
      catalogLoading: false,
      provider: 'a6',
      route: { provider: 'a6', model: 'm1' },
      modelByProvider: { a6: 'm1' },
      sessionId: undefined,
      cacheOptions: { size: 12_000, rounds: 2, wait: 10, timeout: 120 },
      speedOptions: { tokens: 256, rounds: 3, gap: 1, timeout: 120 },
      pelicanOptions: { timeout: 120 },
      reasoningOptions: { cache: 'low', speed: 'low', pelican: 'low' },
      cache: cacheResult,
      speed: speedResult,
      cacheCheckedAt: Date.now() - 60_000,
      speedCheckedAt: Date.now() - 30_000,
      cacheRoute: { provider: 'a6', model: 'm1', providerName: 'a6中转' },
      speedRoute: { provider: 'hs', model: 'm2', providerName: 'HS' },
      progress: null,
      batch: null,
      running: false,
      activeKind: null,
      error: null,
    }),
    ensureCatalog: async () => {},
    reloadCatalog: async () => {},
    close() {},
    setProvider() {},
    setModel() {},
    setRoute() {},
    setCacheOption() {},
    setSpeedOption() {},
    setReasoningOption() {},
    run: async () => {},
    runAll: async () => {},
  }

  const previousReact = globalThis.React
  const previousH = globalThis.h
  globalThis.React = {
    Fragment: 'Fragment',
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useState(value) {
      return [value, () => {}]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
  globalThis.h = (type, props, ...children) => {
    if (typeof type === 'function') return type({ ...props, children })
    return {
      type,
      props,
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }
  }

  try {
    const main = registrations.find(({ definition }) => definition.name === 'main')
    const tree = main.component({ controller: fakeController, translate: (key) => key })
    const strings = []
    collectStrings(tree, strings)
    assert.ok(strings.includes('复测命中 90.0%'))
    assert.ok(strings.includes('TTFT 400ms · 32.0 tok/s'))
    assert.ok(strings.includes('CACHE REPORT'))
    assert.ok(strings.includes('SPEED REPORT'))
    assert.ok(strings.includes('a6中转'))
    assert.ok(strings.includes('M1'))
    assert.ok(strings.includes('Empty · label.noModels'))
    assert.ok(strings.includes('90.0%'))
    assert.ok(strings.includes('label.lastChecked'))
    assert.ok(strings.includes('table.averageRetest'))
    assert.ok(strings.includes('table.average'))
    assert.ok(strings.includes('action.pelican'))
    assert.ok(strings.includes('pelican.title'))
    assert.ok(strings.includes('pelican.empty'))
    assert.ok(strings.includes('a6中转 / m1'))
    assert.ok(strings.includes('HS / m2'))
    assert.ok(strings.includes('label.fromRoute'))
    assert.ok(strings.includes('form.reasoningCache'))
    assert.ok(strings.includes('form.reasoningSpeed'))
    assert.ok(strings.includes('form.reasoningPelican'))
  } finally {
    globalThis.React = previousReact
    globalThis.h = previousH
  }
})

test('renders the live progress panel while a test runs', () => {
  const registrations = []
  const ctx = {
    get(key) {
      if (key === 'layout') return { selectPanel() {} }
      return undefined
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(_name, factory) {
        const value = factory()
        if (value !== undefined && typeof value[Symbol.iterator] === 'function') {
          for (const _disposer of value) { /* drain */ }
        }
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }
  apply(ctx)

  const startedAt = Date.now() - 12_000
  const progress = {
    kind: 'cache',
    route: { provider: 'a6', model: 'm1' },
    channelName: 'a6中转',
    options: { size: 12_000, rounds: 2, wait: 10, timeout: 120 },
    total: 3,
    attempts: [
      { index: 0, summary: { prompt: 1_000, uncached: 1_000, cacheRead: 0, cacheWrite: 0, hitRate: 0, output: 32 }, durationMs: 1_000 },
    ],
    activeIndex: 1,
    phase: 'wait',
    startedAt,
    activeSince: null,
    waitUntil: Date.now() + 7_000,
    waitSeconds: 10,
    cancelled: false,
    error: null,
  }
  const fakeController = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      catalog: { providers: [{ id: 'a6', name: 'a6中转', models: [{ id: 'm1', name: 'M1' }] }] },
      catalogError: null,
      catalogLoading: false,
      provider: 'a6',
      route: { provider: 'a6', model: 'm1' },
      modelByProvider: { a6: 'm1' },
      sessionId: undefined,
      cacheOptions: { size: 12_000, rounds: 2, wait: 10, timeout: 120 },
      speedOptions: { tokens: 256, rounds: 3, gap: 1, timeout: 120 },
      pelicanOptions: { timeout: 120 },
      reasoningOptions: { cache: 'low', speed: 'low', pelican: 'low' },
      cache: null,
      speed: null,
      progress,
      batch: { index: 1, total: 2 },
      running: true,
      activeKind: 'cache',
      error: null,
    }),
    ensureCatalog: async () => {},
    reloadCatalog: async () => {},
    close() {},
    setProvider() {},
    setModel() {},
    setRoute() {},
    setCacheOption() {},
    setSpeedOption() {},
    setReasoningOption() {},
    run: async () => {},
    runAll: async () => {},
    cancel() {},
  }

  const previousReact = globalThis.React
  const previousH = globalThis.h
  globalThis.React = {
    Fragment: 'Fragment',
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useState(value) {
      return [value, () => {}]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
  globalThis.h = (type, props, ...children) => {
    if (typeof type === 'function') return type({ ...props, children })
    return {
      type,
      props,
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }
  }

  try {
    const main = registrations.find(({ definition }) => definition.name === 'main')
    const tree = main.component({ controller: fakeController, translate: (key) => key })
    const strings = []
    collectStrings(tree, strings)
    assert.ok(strings.includes('progress.cacheTitle'))
    assert.ok(strings.includes('progress.waitCache'))
    assert.ok(strings.includes('action.stop'))
    assert.ok(strings.includes('table.warmup'))
    assert.ok(strings.includes('table.retest'))
  } finally {
    globalThis.React = previousReact
    globalThis.h = previousH
  }
})

test('every page translation key exists in both dictionaries', async () => {
  let dictionaries
  const ctx = {
    get(key) {
      if (key === 'layout') return { selectPanel() {} }
      return undefined
    },
    locale: {
      bind: () => (key) => key,
      register(_ns, value) {
        dictionaries = value
        return () => {}
      },
    },
    slots: {
      inject() {
        return () => {}
      },
      register() {
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }
  apply(ctx)
  assert.ok(dictionaries !== undefined)

  const source = await readFile(new URL('../src/client.mjs', import.meta.url), 'utf8')
  const keys = [...source.matchAll(/\bt\('([a-z]+\.[a-zA-Z]+)'\)/gu)].map((match) => match[1])
  assert.ok(keys.length > 20)
  for (const key of new Set(keys)) {
    assert.equal(typeof dictionaries.zh[key], 'string', `missing zh ${key}`)
    assert.equal(typeof dictionaries.en[key], 'string', `missing en ${key}`)
  }
})

/**
 * Collect string leaves from a fake render tree.
 * @param value - tree node.
 * @param output - accumulator.
 */
function collectStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output)
    return
  }
  if (value !== null && typeof value === 'object' && Array.isArray(value.children)) {
    for (const child of value.children) collectStrings(child, output)
  }
}