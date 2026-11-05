/**
 * Browser half of dsh-cache-probe.
 *
 * One composer button and one sidebar panel open the same global page. The page
 * selects any active provider/model, runs the cache or speed test through the
 * plugin's host routes, and renders structured attempts in place — no slash
 * command and no chat message is involved.
 *
 * @module dsh-cache-probe/client
 */

import {
  CACHE_DEFAULTS,
  CACHE_LIMITS,
  PELICAN_DEFAULTS,
  PELICAN_LIMITS,
  REASONING_DEFAULT,
  REASONING_KINDS,
  SPEED_DEFAULTS,
  SPEED_LIMITS,
  clampOption,
  normalizeCacheOptions,
  normalizePelicanOptions,
  normalizeReasoningSelection,
  normalizeSpeedOptions,
} from './options.mjs'
import {
  averageCacheAttempts,
  averageSpeedAttempts,
  formatDuration,
  formatLatency,
  formatOutputSplit,
  formatRate,
  formatThroughput,
  formatTokens,
} from './stats.mjs'

/** Locale namespace and stable page id shared by all three seats. */
const NS = 'dsh-cache-probe'
const PANEL_ID = 'channel-test'

/** Conversation root marker used to recover the session id from the composer. */
const SESSION_ATTRIBUTE = 'data-conversation-session'
const STYLE_ATTRIBUTE = 'data-dsh-cache-probe-style'
const ROUTE_KEY = 'dsh-cache-probe.page.route.v1'
const OPTIONS_KEY = 'dsh-cache-probe.page.options.v1'
const RESULT_KEY = 'dsh-cache-probe.page.result.v1'
const API_MODELS = 'api/dsh-cache-probe/models'
const API_RUN = 'api/dsh-cache-probe/run'

/** Chinese copy owned by this plugin. */
const zh = {
  'panel.label': '渠道测试',
  'panel.title': '渠道测试',
  'panel.subtitle': '测试任意已配置渠道的提示词缓存命中率与响应速度',
  'panel.back': '返回会话',
  'panel.note': '测试只影响本页，不会切换当前会话的聊天模型。',
  'panel.openTitle': '打开渠道测试页面',
  'action.runAll': '全部运行',
  'action.cache': '测缓存',
  'action.speed': '测速',
  'action.pelican': '鹈鹕测试',
  'action.copy': '复制报告',
  'action.copied': '已复制',
  'action.retry': '重试',
  'action.refresh': '刷新渠道',
  'action.stop': '停止测试',
  'state.ready': '就绪',
  'state.loading': '加载渠道中…',
  'state.running': '运行中…',
  'state.cache': '缓存测试中…',
  'state.speed': '测速中…',
  'state.pelican': '鹈鹕测试中…',
  'state.done': '完成',
  'cache.title': '缓存命中率',
  'cache.empty': '尚未运行缓存测试。',
  'speed.title': '响应速度',
  'speed.empty': '尚未运行测速。',
  'pelican.title': '鹈鹕测试',
  'pelican.empty': '尚未运行鹈鹕测试。',
  'pelican.generated': '已生成 SVG',
  'pelican.missing': '无 SVG',
  'pelican.blocked': '已拦截不安全 SVG',
  'pelican.preview': '鹈鹕预览',
  'pelican.raw': '原始响应',
  'pelican.blocked': '已拦截不安全 SVG',
  'label.channel': '测试渠道',
  'label.provider': '供应商',
  'label.model': '模型',
  'label.noReasoning': '不支持思考',
  'label.noModels': '无可用模型',
  'label.chooseProvider': '请先选择供应商',
  'label.chooseModel': '请选择模型',
  'label.advanced': '高级设置',
  'label.realTraffic': '真实流量（不含本次测试）',
  'label.lastChecked': '上次检测 {time}',
  'label.fromRoute': '来自 {route}',
  'label.textReport': '文本报告',
  'label.noVisible': '无可见文本',
  'reasoning.off': '无思考（off）',
  'reasoning.minimal': '最低（minimal）',
  'reasoning.low': '低（low）',
  'reasoning.medium': '中（medium）',
  'reasoning.high': '高（high）',
  'reasoning.xhigh': '很高（xhigh）',
  'reasoning.max': '最高（max）',
  'table.round': '轮次',
  'table.warmup': '预热',
  'table.retest': '复测 {n}',
  'table.prompt': 'prompt',
  'table.uncached': '未缓存',
  'table.cacheRead': '缓存读',
  'table.cacheWrite': '缓存写',
  'table.hit': '命中',
  'table.duration': '耗时',
  'table.output': '思考/正文 tok',
  'table.outputHint': '思考 token / 最终答案 token；速度按（思考 + 正文）÷ 生成时间计算',
  'table.ttft': 'TTFT',
  'table.tps': 'tok/s',
  'table.total': '总耗时',
  'table.channel': '渠道',
  'table.requests': '请求数',
  'table.billed': '计费输入',
  'table.svgLength': 'SVG 字符数',
  'table.average': '平均',
  'table.averageRetest': '平均（复测 {n} 轮）',
  'table.averageHint': 'token 与耗时为算术平均；命中率为总缓存读 ÷ 总 prompt。',
  'form.size': '载荷字符数',
  'form.cacheRounds': '缓存复测次数',
  'form.wait': '缓存等待秒数',
  'form.tokens': '目标输出 tokens',
  'form.speedRounds': '测速轮数',
  'form.gap': '轮间隔秒数',
  'form.timeout': '单次超时秒数',
  'form.reasoningCache': '缓存思考等级',
  'form.reasoningSpeed': '测速思考等级',
  'form.reasoningPelican': '鹈鹕思考等级',
  'form.roundsHint': '轮次不设上限；每轮都是真实请求，轮次越多耗时和费用越高。',
  'error.catalog': '无法加载渠道列表',
  'error.noRoute': '没有可用渠道',
  'error.pi': '内部错误',
  'progress.cacheTitle': '正在测缓存',
  'progress.speedTitle': '正在测速',
  'progress.pelicanTitle': '正在画鹈鹕',
  'progress.pelicanRequesting': '鹈鹕请求中…',
  'progress.pelicanRound': '鹈鹕请求',
  'progress.batch': '全部运行 {index}/{total}',
  'progress.elapsed': '已用 {time}',
  'progress.warmup': '预热请求中…',
  'progress.requesting': '第 {n} 轮请求中…',
  'progress.retestRequesting': '复测 {n} 请求中…',
  'progress.waitCache': '等待缓存生效 {s}s…',
  'progress.waitGap': '等待下一轮 {s}s…',
  'progress.starting': '正在准备请求…',
  'progress.cancelled': '测试已停止',
  'progress.completed': '已完成 {done}/{total} 轮',
  'progress.speedRound': '第 {n} 轮',
  'progress.error': '测试失败',
  'progress.largeRun': '共 {total} 轮，完成后在结果表格中查看。',
}

/** English copy. */
const en = {
  'panel.label': 'Channel test',
  'panel.title': 'Channel test',
  'panel.subtitle': 'Measure prompt-cache hit rate and response speed for any configured channel',
  'panel.back': 'Back to chat',
  'panel.note': 'Tests stay on this page and do not switch the chat model of the current session.',
  'panel.openTitle': 'Open the channel-test page',
  'action.runAll': 'Run all',
  'action.cache': 'Cache test',
  'action.speed': 'Speed test',
  'action.pelican': 'Pelican test',
  'action.copy': 'Copy report',
  'action.copied': 'Copied',
  'action.retry': 'Retry',
  'action.refresh': 'Refresh channels',
  'action.stop': 'Stop test',
  'state.ready': 'Ready',
  'state.loading': 'Loading channels…',
  'state.running': 'Running…',
  'state.cache': 'Testing cache…',
  'state.speed': 'Testing speed…',
  'state.pelican': 'Testing pelican…',
  'state.done': 'Done',
  'cache.title': 'Cache hit rate',
  'cache.empty': 'No cache test has run yet.',
  'speed.title': 'Response speed',
  'speed.empty': 'No speed test has run yet.',
  'pelican.title': 'Pelican test',
  'pelican.empty': 'No pelican test has run yet.',
  'pelican.generated': 'SVG generated',
  'pelican.missing': 'No SVG',
  'pelican.blocked': 'Blocked unsafe SVG',
  'pelican.preview': 'Pelican preview',
  'pelican.raw': 'Raw response',
  'pelican.blocked': 'Blocked unsafe SVG',
  'label.channel': 'Test channel',
  'label.provider': 'Provider',
  'label.model': 'Model',
  'label.noReasoning': 'Not supported',
  'label.noModels': 'No models',
  'label.chooseProvider': 'Choose a provider first',
  'label.chooseModel': 'Choose a model',
  'label.advanced': 'Advanced',
  'label.realTraffic': 'Real traffic (excluding this test)',
  'label.lastChecked': 'Last checked {time}',
  'label.fromRoute': 'From {route}',
  'label.textReport': 'Text report',
  'label.noVisible': 'no visible text',
  'reasoning.off': 'No thinking (off)',
  'reasoning.minimal': 'Minimal',
  'reasoning.low': 'Low',
  'reasoning.medium': 'Medium',
  'reasoning.high': 'High',
  'reasoning.xhigh': 'Very high',
  'reasoning.max': 'Max',
  'table.round': 'Round',
  'table.warmup': 'Warm-up',
  'table.retest': 'Retest {n}',
  'table.prompt': 'prompt',
  'table.uncached': 'Uncached',
  'table.cacheRead': 'Cache read',
  'table.cacheWrite': 'Cache write',
  'table.hit': 'Hit',
  'table.duration': 'Time',
  'table.output': 'Think/Answer tok',
  'table.outputHint': 'Thinking tokens / final answer tokens. Speed = (thinking + answer) ÷ generation time.',
  'table.ttft': 'TTFT',
  'table.tps': 'tok/s',
  'table.total': 'Total',
  'table.channel': 'Channel',
  'table.requests': 'Requests',
  'table.billed': 'Billed input',
  'table.svgLength': 'SVG chars',
  'table.average': 'Average',
  'table.averageRetest': 'Average ({n} retests)',
  'table.averageHint': 'Tokens and time are arithmetic means; hit rate is total cache read ÷ total prompt.',
  'form.size': 'Payload characters',
  'form.cacheRounds': 'Cache retests',
  'form.wait': 'Cache wait (s)',
  'form.tokens': 'Target output tokens',
  'form.speedRounds': 'Speed rounds',
  'form.gap': 'Round gap (s)',
  'form.timeout': 'Request timeout (s)',
  'form.reasoningCache': 'Cache reasoning',
  'form.reasoningSpeed': 'Speed reasoning',
  'form.reasoningPelican': 'Pelican reasoning',
  'form.roundsHint': 'Rounds have no upper bound; every round is a real request, so more rounds cost more time and money.',
  'error.catalog': 'Could not load channels',
  'error.noRoute': 'No channel available',
  'error.pi': 'Internal error',
  'progress.cacheTitle': 'Testing cache',
  'progress.speedTitle': 'Testing speed',
  'progress.pelicanTitle': 'Drawing a pelican',
  'progress.pelicanRequesting': 'Pelican request in flight…',
  'progress.pelicanRound': 'Pelican request',
  'progress.batch': 'Run all {index}/{total}',
  'progress.elapsed': 'Elapsed {time}',
  'progress.warmup': 'Warm-up in flight…',
  'progress.requesting': 'Round {n} in flight…',
  'progress.retestRequesting': 'Retest {n} in flight…',
  'progress.waitCache': 'Waiting for cache {s}s…',
  'progress.waitGap': 'Waiting for next round {s}s…',
  'progress.starting': 'Preparing request…',
  'progress.cancelled': 'Test stopped',
  'progress.completed': '{done}/{total} rounds completed',
  'progress.speedRound': 'Round {n}',
  'progress.error': 'Test failed',
  'progress.largeRun': '{total} rounds; the full table appears when finished.',
}

/** Services this plugin reads before mounting its seats. */
export const inject = ['slots', 'locale', 'layout']

/**
 * Activate the browser half.
 * @param ctx - Web client root Context.
 */
export function apply(ctx) {
  const t = ctx.locale === undefined ? (key) => key : ctx.locale.bind(NS)
  if (ctx.locale !== undefined) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cache-probe: dictionaries')
  }
  ctx.effect(() => installStyles(), 'dsh-cache-probe: styles')

  let layout
  try {
    layout = ctx.get('layout')
  } catch {
    layout = undefined
  }
  if (layout === undefined) {
    console.warn('[cache-probe] the layout service is absent; the page cannot be selected')
  }
  const controller = createController({ layout })

  ctx.effect(
    () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 40,
      label: () => t('panel.label'),
    }, PanelIcon)),
    'dsh-cache-probe: sidebar entry',
  )

  ctx.effect(
    () => ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({ controller, translate: t }),
    }, PanelPage)),
    'dsh-cache-probe: channel-test page',
  )

  const OpenButton = createOpenButton(controller, t)
  ctx.effect(
    () => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: PANEL_ID,
      order: 2,
    }, OpenButton)),
    'dsh-cache-probe: composer button',
  )

  const version = typeof __DSH_PLUGIN_VERSION__ === 'string' ? __DSH_PLUGIN_VERSION__ : 'dev'
  console.info(`[cache-probe] active v${version} (channel-test page)`)
}

/**
 * Create the page controller. It lives for the lifetime of the plugin fiber, so
 * switching panels and coming back keeps the last results; route and advanced
 * options survive a document reload through localStorage.
 * @param options - `{ layout, fetchImpl, storage }`, all optional for tests.
 * @returns the controller with a stable snapshot store.
 */
export function createController(options = {}) {
  const layout = options.layout
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const storage = options.storage ?? safeStorage()
  const stored = readStored(storage)

  let state = {
    catalog: null,
    catalogError: null,
    catalogLoading: false,
    provider: stored.selection?.provider ?? null,
    route: stored.selection?.model === undefined
      ? null
      : { provider: stored.selection.provider, model: stored.selection.model },
    modelByProvider: stored.modelByProvider,
    sessionId: undefined,
    cacheOptions: stored.cache,
    speedOptions: stored.speed,
    pelicanOptions: stored.pelican,
    reasoningOptions: stored.reasoning,
    cache: stored.results.cache?.payload ?? null,
    speed: stored.results.speed?.payload ?? null,
    pelican: stored.results.pelican?.payload ?? null,
    cacheCheckedAt: stored.results.cache?.checkedAt ?? null,
    speedCheckedAt: stored.results.speed?.checkedAt ?? null,
    pelicanCheckedAt: stored.results.pelican?.checkedAt ?? null,
    cacheRoute: stored.results.cache?.route ?? null,
    speedRoute: stored.results.speed?.route ?? null,
    pelicanRoute: stored.results.pelican?.route ?? null,
    progress: null,
    batch: null,
    running: false,
    activeKind: null,
    error: null,
  }
  let catalogPromise
  let currentAbort
  let cancelRequested = false
  const listeners = new Set()

  /**
   * Replace the snapshot and notify mounted readers.
   * @param patch - fields to merge.
   */
  function setState(patch) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  /**
   * Reconcile all three reasoning selections with one model's capabilities.
   *
   * A model without reasoning pins every kind to null. Otherwise each kind
   * keeps a still-supported choice and otherwise falls back to `low`, then
   * `off`, then the first advertised effort.
   * @param model - catalog model entry, or undefined.
   * @param current - current `{ cache, speed, pelican }` selections.
   * @returns a complete `{ cache, speed, pelican }` object.
   */
  function reconcileReasoning(model, current) {
    const output = {}
    for (const kind of REASONING_KINDS) {
      output[kind] = pickReasoning(model, current?.[kind])
    }
    return output
  }

  /**
   * Resolve all three selections for one route against a catalog.
   * @param catalog - loaded catalog.
   * @param route - `{ provider, model }` or null.
   * @param current - current selections.
   * @returns a complete `{ cache, speed, pelican }` object.
   */
  function reasoningForRoute(catalog, route, current) {
    if (route === null) {
      const empty = {}
      for (const kind of REASONING_KINDS) empty[kind] = REASONING_DEFAULT
      return empty
    }
    const provider = catalogProviders(catalog).find((entry) => entry.id === route.provider)
    const model = providerModels(provider).find((entry) => entry.id === route.model)
    return reconcileReasoning(model, current)
  }

  /**
   * Fetch the provider/model catalog once.
   * @param force - ignore the cached catalog.
   * @returns the catalog, or null after a failure.
   */
  function ensureCatalog(force = false) {
    if (!force && state.catalog !== null) return Promise.resolve(state.catalog)
    if (catalogPromise !== undefined) return catalogPromise
    setState({ catalogLoading: true, catalogError: null })
    catalogPromise = (async () => {
      try {
        const query = state.sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(state.sessionId)}`
        const body = await requestJson(`${API_MODELS}${query}`)
        const providers = Array.isArray(body.providers) ? body.providers : []
        const catalog = { providers }
        const saved = state.provider === null
          ? null
          : { provider: state.provider, model: state.route?.model }
        const resolved = resolveSelection(catalog, saved, body.defaultRoute, state.modelByProvider)
        const changed = state.provider !== resolved.provider || !sameRoute(state.route, resolved.route)
        setState({
          catalog,
          provider: resolved.provider,
          route: resolved.route,
          modelByProvider: resolved.modelByProvider,
          reasoningOptions: reasoningForRoute(catalog, resolved.route, state.reasoningOptions),
          catalogLoading: false,
          catalogError: null,
          ...(changed ? { progress: null, error: null } : {}),
        })
        if (resolved.provider !== null) {
          persistSelection(storage, resolved.provider, resolved.route?.model ?? null, resolved.modelByProvider)
        }
        return catalog
      } catch (error) {
        setState({ catalogError: messageOf(error), catalogLoading: false })
        return null
      } finally {
        catalogPromise = undefined
      }
    })()
    return catalogPromise
  }

  /**
   * Drop the cached catalog and load it again.
   * @returns the new catalog, or null.
   */
  function reloadCatalog() {
    setState({ catalog: null, catalogError: null })
    return ensureCatalog(true)
  }

  /**
   * Select the page in the layout, remembering the originating session.
   * @param sessionId - optional conversation session id.
   */
  function open(sessionId) {
    if (typeof sessionId === 'string' && sessionId.length > 0) setState({ sessionId })
    selectPanel(PANEL_ID)
    void ensureCatalog()
  }

  /** Return the center column to the conversation. */
  function close() {
    selectPanel(null)
  }

  /**
   * Select one provider, restoring that provider's last model when possible.
   * @param providerId - provider id.
   */
  function setProvider(providerId) {
    if (typeof providerId !== 'string' || providerId.length === 0) return
    if (state.provider === providerId) return
    const provider = catalogProviders(state.catalog).find((entry) => entry.id === providerId)
    if (provider === undefined) return
    const models = providerModels(provider)
    const remembered = state.modelByProvider[providerId]
    const rememberedModel = models.find((model) => model.id === remembered)?.id ?? null
    const model = rememberedModel ?? models[0]?.id ?? null
    const nextMap = { ...state.modelByProvider }
    if (model === null) delete nextMap[providerId]
    else nextMap[providerId] = model
    const route = model === null ? null : { provider: providerId, model }
    const selectedModel = models.find((entry) => entry.id === model)
    setState({
      provider: providerId,
      route,
      modelByProvider: nextMap,
      reasoningOptions: reconcileReasoning(selectedModel, state.reasoningOptions),
      progress: null,
      error: null,
    })
    persistSelection(storage, providerId, model, nextMap)
  }

  /**
   * Select one model under the current provider.
   * @param modelId - model id.
   */
  function setModel(modelId) {
    if (state.provider === null || typeof modelId !== 'string' || modelId.length === 0) return
    const provider = catalogProviders(state.catalog).find((entry) => entry.id === state.provider)
    if (provider === undefined) return
    const models = providerModels(provider)
    const selectedModel = models.find((model) => model.id === modelId)
    if (selectedModel === undefined) return
    const route = { provider: state.provider, model: modelId }
    const changed = !sameRoute(state.route, route)
    const nextMap = { ...state.modelByProvider, [state.provider]: modelId }
    const reasoningOptions = reconcileReasoning(selectedModel, state.reasoningOptions)
    setState(changed
      ? { route, modelByProvider: nextMap, reasoningOptions, progress: null, error: null }
      : { route, modelByProvider: nextMap, reasoningOptions })
    persistSelection(storage, state.provider, modelId, nextMap)
  }

  /**
   * Select one provider/model pair directly.
   * @param provider - provider id.
   * @param model - model id.
   */
  function setRoute(provider, model) {
    if (typeof provider !== 'string' || provider.length === 0) return
    if (typeof model !== 'string' || model.length === 0) return
    const route = { provider, model }
    const changed = state.provider !== provider || !sameRoute(state.route, route)
    const nextMap = { ...state.modelByProvider, [provider]: model }
    const providerEntry = catalogProviders(state.catalog).find((entry) => entry.id === provider)
    const modelEntry = providerModels(providerEntry).find((entry) => entry.id === model)
    setState({
      provider,
      route,
      modelByProvider: nextMap,
      reasoningOptions: reconcileReasoning(modelEntry, state.reasoningOptions),
      ...(changed ? { progress: null, error: null } : {}),
    })
    persistSelection(storage, provider, model, nextMap)
  }

  /**
   * Update one cache option within its declared range.
   * @param key - option key.
   * @param value - candidate number.
   */
  function setCacheOption(key, value) {
    const limits = CACHE_LIMITS[key]
    if (limits === undefined) return
    const next = { ...state.cacheOptions, [key]: clampOption(value, limits, state.cacheOptions[key]) }
    setState({ cacheOptions: next, progress: null, error: null })
    persistOptions(storage, next, state.speedOptions, state.pelicanOptions, state.reasoningOptions)
  }

  /**
   * Update one speed option within its declared range.
   * @param key - option key.
   * @param value - candidate number.
   */
  function setSpeedOption(key, value) {
    const limits = SPEED_LIMITS[key]
    if (limits === undefined) return
    const next = { ...state.speedOptions, [key]: clampOption(value, limits, state.speedOptions[key]) }
    setState({ speedOptions: next, progress: null, error: null })
    persistOptions(storage, state.cacheOptions, next, state.pelicanOptions, state.reasoningOptions)
  }

  /**
   * Update one pelican option within its declared range.
   * @param key - option key.
   * @param value - candidate number.
   */
  function setPelicanOption(key, value) {
    const limits = PELICAN_LIMITS[key]
    if (limits === undefined) return
    const next = { ...state.pelicanOptions, [key]: clampOption(value, limits, state.pelicanOptions[key]) }
    setState({ pelicanOptions: next, progress: null, error: null })
    persistOptions(storage, state.cacheOptions, state.speedOptions, next, state.reasoningOptions)
  }

  /**
   * Select the reasoning effort for one test.
   * @param kind - `cache`, `speed`, or `pelican`.
   * @param value - model-declared effort id.
   */
  function setReasoningOption(kind, value) {
    if (!REASONING_KINDS.includes(kind)) return
    if (typeof value !== 'string' || value.length === 0) return
    if (state.reasoningOptions[kind] === value) return
    const next = { ...state.reasoningOptions, [kind]: value }
    setState({ reasoningOptions: next, progress: null, error: null })
    persistOptions(storage, state.cacheOptions, state.speedOptions, state.pelicanOptions, next)
  }

  /**
   * Build the local progress placeholder shown before the first stream event.
   * @param kind - `cache` or `speed`.
   * @returns a complete progress object.
   */
  function initialProgress(kind) {
    const route = state.route
    const options = kind === 'cache'
      ? state.cacheOptions
      : kind === 'speed' ? state.speedOptions : state.pelicanOptions
    const total = kind === 'cache'
      ? state.cacheOptions.rounds + 1
      : kind === 'speed' ? state.speedOptions.rounds : 1
    const provider = catalogProviders(state.catalog).find((entry) => entry.id === route?.provider)
    return {
      kind,
      route: route === null ? null : { ...route },
      channelName: provider?.name ?? route?.provider ?? '',
      options,
      reasoning: state.reasoningOptions[kind],
      total,
      attempts: [],
      activeIndex: null,
      phase: 'starting',
      startedAt: Date.now(),
      activeSince: null,
      waitUntil: null,
      waitSeconds: null,
      cancelled: false,
      error: null,
    }
  }

  /**
   * Keep partial process rows on failure; drop an empty placeholder.
   * @param error - thrown value.
   * @returns progress patch or null.
   */
  function sourceRoute() {
    if (state.route === null) return null
    const provider = catalogProviders(state.catalog).find((entry) => entry.id === state.route.provider)
    return {
      provider: state.route.provider,
      model: state.route.model,
      ...(typeof provider?.name === 'string' && provider.name.length > 0 ? { providerName: provider.name } : {}),
    }
  }

  /**
   * Store one completed payload in memory and localStorage.
   * @param kind - `cache` or `speed`.
   * @param payload - final section payload.
   */
  function recordResult(kind, payload) {
    const route = sourceRoute()
    const checkedAt = persistResult(storage, kind, payload, route)
    setState({
      [kind]: payload,
      [`${kind}CheckedAt`]: checkedAt,
      [`${kind}Route`]: route,
      progress: null,
    })
  }

  function failedProgress(error) {
    const current = state.progress
    if (current === null || current.attempts.length === 0) return null
    return { ...current, phase: 'error', error: messageOf(error) }
  }

  /**
   * Run one test and surface a request-level error in the page banner.
   * @param kind - `cache` or `speed`.
   */
  async function run(kind) {
    if (state.running) return
    cancelRequested = false
    setState({
      running: true,
      activeKind: kind,
      error: null,
      [kind]: null,
      [`${kind}CheckedAt`]: null,
      [`${kind}Route`]: null,
      progress: initialProgress(kind),
      batch: null,
    })
    try {
      await execute(kind)
    } catch (error) {
      if (!(error instanceof CancelledError)) {
        setState({ error: messageOf(error), progress: failedProgress(error) })
      }
    } finally {
      currentAbort = undefined
      setState({ running: false, activeKind: null })
    }
  }

  /** Run the cache test, then the speed test; one failure does not skip the other. */
  async function runAll() {
    if (state.running) return
    cancelRequested = false
    const kinds = ['cache', 'speed', 'pelican']
    setState({
      running: true,
      activeKind: null,
      error: null,
      progress: null,
      batch: { index: 0, total: kinds.length },
    })
    try {
      for (let index = 0; index < kinds.length; index += 1) {
        if (cancelRequested) break
        const kind = kinds[index]
        setState({
          activeKind: kind,
          [kind]: null,
          [`${kind}CheckedAt`]: null,
          [`${kind}Route`]: null,
          progress: initialProgress(kind),
          batch: { index: index + 1, total: kinds.length },
        })
        try {
          await execute(kind)
        } catch (error) {
          if (error instanceof CancelledError) break
          setState({ error: messageOf(error), progress: failedProgress(error) })
        }
      }
    } finally {
      currentAbort = undefined
      setState({ running: false, activeKind: null, batch: null })
    }
  }

  /**
   * Perform one host request and store its section payload.
   * @param kind - `cache` or `speed`.
   * @returns the section payload.
   */
  async function execute(kind) {
    if (state.route === null) throw new Error('请选择供应商和模型')
    if (cancelRequested) throw new CancelledError()
    const body = {
      kind,
      provider: state.route.provider,
      model: state.route.model,
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      cache: state.cacheOptions,
      speed: state.speedOptions,
      pelican: state.pelicanOptions,
      reasoning: state.reasoningOptions,
    }
    const controller = new AbortController()
    currentAbort = controller
    return requestStream(kind, body, controller.signal)
  }

  /**
   * Announce cancellation and abort the active stream.
   */
  function cancel() {
    if (!state.running) return
    cancelRequested = true
    if (state.progress !== null) {
      setState({ progress: { ...state.progress, phase: 'cancelled', cancelled: true } })
    }
    currentAbort?.abort()
  }

  /**
   * POST one run, consuming an NDJSON progress stream or falling back to JSON.
   * @param kind - `cache` or `speed`.
   * @param body - request body.
   * @param signal - cancellation signal.
   * @returns the final section payload.
   */
  async function requestStream(kind, body, signal) {
    let response
    try {
      response = await fetchImpl(API_RUN, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-dsh-cache-probe': '1',
          'x-dsh-cache-probe-stream': '1',
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (isAbortError(error, signal)) throw new CancelledError()
      throw new ApiError('NETWORK', messageOf(error))
    }

    if (!response.ok) {
      let errorBody
      try {
        errorBody = await response.json()
      } catch {
        errorBody = undefined
      }
      throw new ApiError(
        typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'HTTP_ERROR',
        typeof errorBody?.error?.message === 'string' ? errorBody.error.message : `HTTP ${response.status}`,
      )
    }

    const contentType = headerValue(response, 'content-type').toLowerCase()
    if (!contentType.includes('application/x-ndjson')) {
      let result
      try {
        result = await response.json()
      } catch (error) {
        if (isAbortError(error, signal)) throw new CancelledError()
        throw new ApiError('INVALID_RESPONSE', '测试响应不是合法 JSON')
      }
      if (result?.ok !== true) {
        throw new ApiError(
          typeof result?.error?.code === 'string' ? result.error.code : 'INVALID_RESPONSE',
          typeof result?.error?.message === 'string' ? result.error.message : '测试响应失败',
        )
      }
      if (cancelRequested) throw new CancelledError()
      const payload = result[kind]
      recordResult(kind, payload)
      return payload
    }

    const reader = response.body?.getReader?.()
    if (reader === undefined) throw new ApiError('STREAM_UNAVAILABLE', '测试流不可用')
    const decoder = new TextDecoder()
    let buffer = ''
    let donePayload = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line !== '') {
            const payload = consumeStreamLine(kind, line)
            if (payload !== undefined) donePayload = payload
          }
          newline = buffer.indexOf('\n')
        }
      }
      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        const payload = consumeStreamLine(kind, buffer.trim())
        if (payload !== undefined) donePayload = payload
      }
    } catch (error) {
      if (isAbortError(error, signal) || error instanceof CancelledError) throw new CancelledError()
      if (error instanceof ApiError) throw error
      throw new ApiError('STREAM_FAILED', messageOf(error))
    }

    if (donePayload === null) throw new ApiError('STREAM_INCOMPLETE', '测试流提前结束')
    return donePayload
  }

  /**
   * Parse one NDJSON line and apply its event.
   * @param kind - `cache` or `speed`.
   * @param line - one JSON line.
   * @returns the final payload when this is a done event.
   */
  function consumeStreamLine(kind, line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw new ApiError('STREAM_INVALID', '测试流数据损坏')
    }
    return applyStreamEvent(kind, event)
  }

  /**
   * Apply one progress event to the snapshot.
   * @param kind - `cache` or `speed`.
   * @param event - stream event.
   * @returns the final payload for `done`, otherwise undefined.
   */
  function applyStreamEvent(kind, event) {
    const progress = state.progress
    if (progress?.cancelled === true) {
      if (event?.type === 'done') throw new CancelledError()
      return undefined
    }
    switch (event?.type) {
      case 'start': {
        const total = Number.isFinite(event.total) ? event.total : progress?.total
        setState({
          progress: {
            ...(progress ?? initialProgress(kind)),
            kind,
            route: event.route ?? progress?.route ?? null,
            channelName: event.channelName ?? progress?.channelName ?? '',
            options: event.options ?? progress?.options ?? {},
            total,
            attempts: progress?.attempts ?? [],
            activeIndex: null,
            phase: 'starting',
            cancelled: progress?.cancelled ?? false,
            error: null,
          },
        })
        return undefined
      }
      case 'attempt-start':
        if (progress !== null) {
          setState({
            progress: {
              ...progress,
              activeIndex: Number(event.index),
              activeSince: Date.now(),
              phase: 'request',
              waitUntil: null,
              waitSeconds: null,
            },
          })
        }
        return undefined
      case 'attempt': {
        if (progress === null || event.attempt === undefined) return undefined
        const attempts = [
          ...progress.attempts.filter((attempt) => attempt.index !== event.attempt.index),
          event.attempt,
        ].sort((left, right) => left.index - right.index)
        setState({
          progress: {
            ...progress,
            attempts,
            activeIndex: null,
            activeSince: null,
            phase: 'between',
          },
        })
        return undefined
      }
      case 'wait':
        if (progress !== null) {
          const seconds = Number(event.seconds)
          setState({
            progress: {
              ...progress,
              phase: 'wait',
              waitSeconds: Number.isFinite(seconds) ? seconds : null,
              waitUntil: Date.now() + (Number.isFinite(seconds) ? Math.max(0, seconds) * 1_000 : 0),
              activeIndex: null,
              activeSince: null,
            },
          })
        }
        return undefined
      case 'wait-done':
        if (progress !== null) {
          setState({
            progress: {
              ...progress,
              phase: 'between',
              waitUntil: null,
              waitSeconds: null,
            },
          })
        }
        return undefined
      case 'done': {
        const payload = event[kind]
        if (payload === undefined) throw new ApiError('INVALID_RESPONSE', '测试完成事件缺少结果')
        recordResult(kind, payload)
        return payload
      }
      case 'error':
        throw new ApiError(
          typeof event.error?.code === 'string' ? event.error.code : 'STREAM_ERROR',
          typeof event.error?.message === 'string' ? event.error.message : '测试失败',
        )
      default:
        return undefined
    }
  }

  /**
   * Run one bounded JSON request against the plugin routes.
   * @param path - document-relative route.
   * @param init - fetch options.
   * @returns the parsed success body.
   */
  async function requestJson(path, init) {
    let response
    try {
      response = await fetchImpl(path, { credentials: 'same-origin', ...init })
    } catch (error) {
      throw new ApiError('NETWORK', messageOf(error))
    }
    let body
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (!response.ok || body?.ok !== true) {
      throw new ApiError(
        typeof body?.error?.code === 'string' ? body.error.code : 'HTTP_ERROR',
        typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`,
      )
    }
    return body
  }

  /** Ask the layout to select a panel; retry once if the main seat has not mounted yet. */
  function selectPanel(id) {
    try {
      layout?.selectPanel?.(id)
    } catch {
      setTimeout(() => {
        try {
          layout?.selectPanel?.(id)
        } catch {
          // The seat may still be unavailable; the sidebar entry remains usable.
        }
      }, 0)
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open,
    close,
    ensureCatalog,
    reloadCatalog,
    setProvider,
    setModel,
    setRoute,
    setCacheOption,
    setSpeedOption,
    setPelicanOption,
    setReasoningOption,
    run,
    runAll,
    cancel,
  }
}

/**
 * List usable providers from a host catalog.
 * @param catalog - `{ providers }` or null.
 * @returns provider entries with an object shape.
 */
export function catalogProviders(catalog) {
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  return providers.filter((provider) => provider !== null && typeof provider === 'object')
}

/**
 * List one provider's usable models.
 * @param provider - catalog provider entry or null.
 * @returns model entries with an object shape.
 */
export function providerModels(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : []
  return models.filter((model) => model !== null && typeof model === 'object')
}

/**
 * List one model's advertised reasoning efforts.
 * @param model - catalog model entry.
 * @returns effort descriptors with a usable id.
 */
export function modelReasoning(model) {
  const efforts = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []
  return efforts.filter((effort) => effort !== null
    && typeof effort === 'object'
    && typeof effort.id === 'string'
    && effort.id.length > 0)
}

/**
 * Pick a selectable effort for one model, keeping a saved value when possible.
 * @param model - catalog model entry.
 * @param current - saved effort id, or null.
 * @returns an effort id, or null for a model without reasoning.
 */
export function pickReasoning(model, current) {
  const efforts = modelReasoning(model)
  const ids = efforts.map((effort) => effort.id)
  if (ids.length === 0) return null
  if (typeof current === 'string' && ids.includes(current)) return current
  if (ids.includes('low')) return 'low'
  if (ids.includes('off')) return 'off'
  return ids[0]
}

/**
 * Flatten a catalog into selectable routes.
 * @param catalog - `{ providers }` or null.
 * @returns route descriptors with provider/model display names.
 */
export function catalogRoutes(catalog) {
  const routes = []
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  for (const provider of providers) {
    if (provider === null || typeof provider !== 'object') continue
    const models = Array.isArray(provider.models) ? provider.models : []
    for (const model of models) {
      if (model === null || typeof model !== 'object') continue
      routes.push({
        key: `${provider.id}\u0000${model.id}`,
        provider: provider.id,
        model: model.id,
        providerName: provider.name,
        modelName: model.name,
      })
    }
  }
  return routes
}

/**
 * Resolve the initial provider/model selection.
 *
 * Precedence: saved provider/model, the per-provider remembered model, the
 * provider's first model, then the host default, then the first provider with a
 * model. A saved provider that currently has no models stays selected so the
 * page can show "无可用模型" instead of silently jumping to another channel.
 * @param catalog - host catalog.
 * @param saved - `{ provider, model? }` saved selection.
 * @param fallback - host-provided default route.
 * @param remembered - per-provider remembered models.
 * @returns `{ provider, route, modelByProvider }`.
 */
function resolveSelection(catalog, saved, fallback, remembered) {
  const providers = catalogProviders(catalog)
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  const nextMap = { ...remembered }
  for (const providerId of Object.keys(nextMap)) {
    if (!byId.has(providerId)) delete nextMap[providerId]
  }

  /**
   * Pick one provider candidate and its best available model.
   * @param candidate - `{ provider, model? }`.
   * @returns the resolved selection, or null when the provider is absent.
   */
  function pick(candidate) {
    if (candidate === null || candidate === undefined) return null
    const provider = byId.get(candidate.provider)
    if (provider === undefined) return null
    const models = providerModels(provider)
    const rememberedModel = nextMap[provider.id]
    const model = candidate.model !== undefined && models.some((entry) => entry.id === candidate.model)
      ? candidate.model
      : models.some((entry) => entry.id === rememberedModel)
        ? rememberedModel
        : models[0]?.id ?? null
    if (model !== null && model !== undefined) nextMap[provider.id] = model
    else delete nextMap[provider.id]
    return {
      provider: provider.id,
      route: model === null || model === undefined ? null : { provider: provider.id, model },
    }
  }

  const first = providers.find((provider) => providerModels(provider).length > 0) ?? providers[0]
  const picked = pick(saved) ?? pick(fallback) ?? (first === undefined ? null : pick({ provider: first.id }))
  return {
    provider: picked?.provider ?? null,
    route: picked?.route ?? null,
    modelByProvider: nextMap,
  }
}

/**
 * Whether two routes name the same provider/model.
 * @param left - first route or null.
 * @param right - second route or null.
 * @returns true when both are absent or both ids match.
 */
function sameRoute(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left === null || left === undefined) && (right === null || right === undefined)
  }
  return left.provider === right.provider && left.model === right.model
}

/**
 * Read persisted selection/options; corrupt values fall back to defaults.
 * @param storage - Storage-like object or undefined.
 * @returns `{ selection, modelByProvider, cache, speed }`.
 */
function readStored(storage) {
  let selection = null
  let modelByProvider = {}
  let cache = { ...CACHE_DEFAULTS }
  let speed = { ...SPEED_DEFAULTS }
  let pelican = { ...PELICAN_DEFAULTS }
  let reasoning = normalizeReasoningSelection(undefined)
  try {
    const raw = storage?.getItem?.(ROUTE_KEY)
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.provider === 'string' && parsed.provider.length > 0) {
        const model = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : undefined
        selection = { provider: parsed.provider, ...(model === undefined ? {} : { model }) }
        if (model !== undefined) modelByProvider[parsed.provider] = model
        if (parsed.modelByProvider !== null && typeof parsed.modelByProvider === 'object' && !Array.isArray(parsed.modelByProvider)) {
          for (const [provider, value] of Object.entries(parsed.modelByProvider)) {
            if (provider === '__proto__') continue
            if (typeof value === 'string' && value.length > 0) modelByProvider[provider] = value
          }
        }
      }
    }
  } catch {
    // Ignore a damaged saved selection.
  }
  try {
    const raw = storage?.getItem?.(OPTIONS_KEY)
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw)
      try {
        cache = normalizeCacheOptions(parsed?.cache)
      } catch {
        cache = { ...CACHE_DEFAULTS }
      }
      try {
        speed = normalizeSpeedOptions(parsed?.speed)
      } catch {
        speed = { ...SPEED_DEFAULTS }
      }
      try {
        pelican = normalizePelicanOptions(parsed?.pelican)
      } catch {
        pelican = { ...PELICAN_DEFAULTS }
      }
      try {
        reasoning = normalizeReasoningSelection(parsed?.reasoning)
      } catch {
        reasoning = normalizeReasoningSelection(undefined)
      }
    }
  } catch {
    // Ignore damaged saved options.
  }
  return { selection, modelByProvider, cache, speed, pelican, reasoning, results: readResults(storage) }
}

/**
 * Read the last cache and speed results.
 * @param storage - Storage-like object or undefined.
 * @returns `{ cache, speed }`, each `{ checkedAt, payload, route }` or null.
 */
function readResults(storage) {
  const results = { cache: null, speed: null, pelican: null }
  try {
    const raw = storage?.getItem?.(RESULT_KEY)
    if (typeof raw !== 'string') return results
    const parsed = JSON.parse(raw)
    for (const kind of ['cache', 'speed', 'pelican']) {
      const entry = parsed?.[kind]
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (typeof entry.checkedAt !== 'number' || !Number.isFinite(entry.checkedAt)) continue
      if (entry.payload === null || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) continue
      results[kind] = {
        checkedAt: entry.checkedAt,
        payload: entry.payload,
        route: normalizeStoredRoute(entry.route),
      }
    }
  } catch {
    // A damaged result cache must not block the page.
  }
  return results
}

/**
 * Validate one persisted source route.
 * @param value - candidate route.
 * @returns `{ provider, model, providerName? }` or null.
 */
function normalizeStoredRoute(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.provider !== 'string' || value.provider.length === 0) return null
  if (typeof value.model !== 'string' || value.model.length === 0) return null
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.providerName === 'string' && value.providerName.length > 0
      ? { providerName: value.providerName }
      : {}),
  }
}

/**
 * Persist the current provider, model, and per-provider memory.
 * @param storage - Storage-like object.
 * @param provider - selected provider id.
 * @param model - selected model id, or null.
 * @param modelByProvider - per-provider remembered models.
 */
function persistSelection(storage, provider, model, modelByProvider) {
  try {
    const payload = { provider, modelByProvider }
    if (typeof model === 'string' && model.length > 0) payload.model = model
    storage?.setItem?.(ROUTE_KEY, JSON.stringify(payload))
  } catch {
    // A disabled storage must not fail a test.
  }
}

/**
 * Persist the advanced controls.
 * @param storage - Storage-like object.
 * @param cache - cache options.
 * @param speed - speed options.
 * @param pelican - pelican options.
 * @param reasoning - per-test reasoning selections.
 */
function persistOptions(storage, cache, speed, pelican, reasoning) {
  try {
    storage?.setItem?.(OPTIONS_KEY, JSON.stringify({ cache, speed, pelican, reasoning }))
  } catch {
    // A disabled storage must not fail a test.
  }
}

/**
 * Persist the latest result for one kind, preserving the other kind.
 * @param storage - Storage-like object.
 * @param kind - `cache` or `speed`.
 * @param payload - final section payload.
 * @param route - source route or null.
 * @returns the recorded timestamp.
 */
function persistResult(storage, kind, payload, route) {
  const checkedAt = Date.now()
  try {
    let current = {}
    try {
      const parsed = JSON.parse(storage?.getItem?.(RESULT_KEY) ?? 'null')
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
    } catch {
      current = {}
    }
    current[kind] = { checkedAt, payload, route }
    storage?.setItem?.(RESULT_KEY, JSON.stringify(current))
  } catch {
    // A disabled storage must not fail a test.
  }
  return checkedAt
}

/** Browser storage, or undefined when the document forbids it. */
function safeStorage() {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** User-requested stop; never rendered as a failure banner. */
class CancelledError extends Error {
  constructor() {
    super('测试已停止')
    this.name = 'CancelledError'
  }
}

/**
 * Whether a thrown fetch/reader error was caused by the abort signal.
 * @param error - thrown value.
 * @param signal - request signal.
 * @returns true for a user cancellation.
 */
function isAbortError(error, signal) {
  return signal?.aborted === true
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
}

/**
 * Read one response header from a Headers-like object.
 * @param response - fetch response.
 * @param name - header name.
 * @returns the header value, or an empty string.
 */
function headerValue(response, name) {
  const headers = response?.headers
  if (headers === undefined || headers === null) return ''
  if (typeof headers.get === 'function') return headers.get(name) ?? ''
  return ''
}

/** Error carrying a stable route code. */
class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/**
 * Read a human message from a thrown value.
 * @param error - thrown value.
 * @returns message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The main-slot page.
 * @param props - framework main-slot share plus the injected controller.
 * @returns the channel-test page.
 */
function PanelPage({ controller, translate }) {
  const t = typeof translate === 'function' ? translate : (key) => key
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  React.useEffect(() => {
    void controller.ensureCatalog()
  }, [controller])

  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!state.running) return undefined
    const timer = setInterval(() => setTick((value) => value + 1), 500)
    return () => clearInterval(timer)
  }, [state.running, state.progress?.startedAt])

  const now = Date.now()
  const providers = catalogProviders(state.catalog)
  const selectedProvider = providers.find((provider) => provider.id === state.provider) ?? null
  const models = providerModels(selectedProvider)
  const selectedModel = models.find((model) => model.id === state.route?.model) ?? null
  const efforts = modelReasoning(selectedModel)
  const disabled = state.running || state.route === null || state.catalog === null
  const reasoningFor = (kind) => state.reasoningOptions?.[kind] ?? ''
  const status = state.running
    ? state.activeKind === 'cache'
      ? t('state.cache')
      : state.activeKind === 'speed'
        ? t('state.speed')
        : state.activeKind === 'pelican'
          ? t('state.pelican')
          : t('state.running')
    : state.cache !== null || state.speed !== null || state.pelican !== null
      ? t('state.done')
      : t('state.ready')

  return h('div', { className: 'dsh-ct-page', 'data-dsh-plugin': 'cache-probe' },
    h('div', { className: 'dsh-ct-shell' },
      h('header', { className: 'dsh-ct-header' },
        h('div', { className: 'dsh-ct-heading' },
          h('h1', { className: 'dsh-ct-title' }, t('panel.title')),
          h('p', { className: 'dsh-ct-subtitle' }, t('panel.subtitle')),
        ),
        h('div', { className: 'dsh-ct-header-actions' },
          h('div', { className: 'dsh-ct-pickers' },
            h('label', { className: 'dsh-ct-picker' },
              h('span', { className: 'dsh-ct-route-label' }, t('label.provider')),
              h('select', {
                className: 'dsh-ct-select',
                value: state.provider ?? '',
                disabled: state.running || providers.length === 0,
                onChange: (event) => {
                  if (event.target.value !== '') controller.setProvider(event.target.value)
                },
              },
              providers.length === 0
                ? h('option', { value: '' }, state.catalogLoading ? t('state.loading') : t('error.noRoute'))
                : h(React.Fragment, null,
                    h('option', { value: '', disabled: true }, t('label.provider')),
                    providers.map((provider) => h('option', { key: provider.id, value: provider.id }, providerOptionLabel(provider, t))),
                  ),
              ),
            ),
            h('label', { className: 'dsh-ct-picker' },
              h('span', { className: 'dsh-ct-route-label' }, t('label.model')),
              h('select', {
                className: 'dsh-ct-select',
                value: state.route?.model ?? '',
                disabled: state.running || models.length === 0,
                onChange: (event) => {
                  if (event.target.value !== '') controller.setModel(event.target.value)
                },
              },
              models.length === 0
                ? h('option', { value: '' }, selectedProvider === null ? t('label.chooseProvider') : t('label.noModels'))
                : h(React.Fragment, null,
                    ...(state.route?.model === undefined
                      ? [h('option', { key: '__placeholder', value: '', disabled: true }, t('label.chooseModel'))]
                      : []),
                    models.map((model) => h('option', { key: model.id, value: model.id }, model.name ?? model.id)),
                  ),
              ),
            ),
          ),
          h('button', {
            className: 'dsh-ct-button',
            type: 'button',
            disabled: state.running || state.catalogLoading,
            onClick: () => void controller.reloadCatalog(),
          }, t('action.refresh')),
          h('button', { className: 'dsh-ct-button', type: 'button', onClick: () => controller.close() }, t('panel.back')),
        ),
      ),
      h('p', { className: 'dsh-ct-note' }, t('panel.note')),
      state.catalogError === null ? null : errorBanner(state.catalogError, () => void controller.reloadCatalog(), t('action.retry')),
      state.error === null ? null : errorBanner(state.error, undefined, t('action.retry')),
      h('div', { className: 'dsh-ct-actions' },
        h('button', {
          className: 'dsh-ct-button dsh-ct-primary',
          type: 'button',
          disabled,
          onClick: () => void controller.runAll(),
        }, t('action.runAll')),
        h('button', {
          className: 'dsh-ct-button',
          type: 'button',
          disabled,
          onClick: () => void controller.run('cache'),
        }, t('action.cache')),
        h('button', {
          className: 'dsh-ct-button',
          type: 'button',
          disabled,
          onClick: () => void controller.run('speed'),
        }, t('action.speed')),
        h('button', {
          className: 'dsh-ct-button',
          type: 'button',
          disabled,
          onClick: () => void controller.run('pelican'),
        }, t('action.pelican')),
        h('span', { className: 'dsh-ct-status' }, status),
      ),
      advancedSettings(state, controller, t, efforts, reasoningFor),
      state.progress === null || state.progress === undefined
        ? h('div', { className: 'dsh-ct-grid' },
            h(CacheCard, {
              result: state.cache,
              checkedAt: state.cacheCheckedAt ?? null,
              sourceRoute: state.cacheRoute ?? null,
              currentRoute: state.route,
              t,
            }),
            h(SpeedCard, {
              result: state.speed,
              checkedAt: state.speedCheckedAt ?? null,
              sourceRoute: state.speedRoute ?? null,
              currentRoute: state.route,
              t,
            }),
            h(PelicanCard, {
              result: state.pelican,
              checkedAt: state.pelicanCheckedAt ?? null,
              sourceRoute: state.pelicanRoute ?? null,
              currentRoute: state.route,
              t,
            }),
          )
        : h(ProgressPanel, {
            progress: state.progress,
            batch: state.batch,
            now,
            t,
            running: state.running,
            onCancel: () => controller.cancel(),
          }),
    ),
  )
}

/**
 * Full-width live progress panel shown while a test runs or after it is stopped.
 * @param props - progress, batch stage, current clock, translator, stop callback.
 * @returns the progress section.
 */
function Spinner({ small = false }) {
  return h('svg', {
    className: small ? 'dsh-ct-spinner is-small' : 'dsh-ct-spinner',
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  h('circle', {
    cx: 12, cy: 12, r: 9,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2.4,
    opacity: 0.18,
  }),
  h('circle', {
    cx: 12, cy: 12, r: 9,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2.4,
    'stroke-linecap': 'round',
    'stroke-dasharray': '42.41 14.14',
  }))
}

/**
 * Full-width live progress panel shown while a test runs or after it is stopped.
 * @param props - progress, batch stage, current clock, translator, stop callback.
 * @returns the progress section.
 */
function ProgressPanel({ progress, batch, now, t, onCancel, running }) {
  const kind = progress.kind
  const cancelled = progress.cancelled === true
  const total = Number.isFinite(progress.total) ? progress.total : progress.attempts.length
  const completed = progress.attempts.length
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
  const title = cancelled
    ? t('progress.cancelled')
    : kind === 'cache'
      ? t('progress.cacheTitle')
      : kind === 'speed' ? t('progress.speedTitle') : t('progress.pelicanTitle')
  const routeLabel = [progress.channelName, progress.route?.model].filter((part) => typeof part === 'string' && part.length > 0).join(' / ')
  const elapsed = formatDuration(now - progress.startedAt)
  const batchLabel = batch === null || batch === undefined
    ? null
    : t('progress.batch').replace('{index}', String(batch.index)).replace('{total}', String(batch.total))

  const steps = []
  const showSteps = total > 0 && total <= 24
  for (let index = 0; showSteps && index < total; index += 1) {
    const attempt = progress.attempts.find((entry) => entry.index === index)
    const active = !cancelled && progress.phase !== 'error' && progress.activeIndex === index
    const state = attempt === undefined
      ? active ? 'active' : 'pending'
      : attempt.error === undefined ? 'done' : 'error'
    const label = kind === 'cache'
      ? attemptLabel(index, t)
      : kind === 'speed'
        ? t('progress.speedRound').replace('{n}', String(index + 1))
        : t('progress.pelicanRound')
    const mark = state === 'done'
      ? '✓'
      : state === 'error'
        ? '!'
        : state === 'active'
          ? h(Spinner, { small: true })
          : String(index + 1)
    steps.push(h('div', { key: index, className: `dsh-ct-step is-${state}` },
      h('span', { className: 'dsh-ct-step-mark' }, mark),
      h('span', { className: 'dsh-ct-step-label' }, label),
    ))
  }

  return h('section', { className: 'dsh-ct-progress', 'data-kind': kind },
    h('div', { className: 'dsh-ct-progress-head' },
      h('div', null,
        h('h2', { className: 'dsh-ct-progress-title' }, title),
        h('p', { className: 'dsh-ct-progress-route' }, routeLabel),
      ),
      h('div', { className: 'dsh-ct-progress-meta' },
        batchLabel === null ? null : h('span', { className: 'dsh-ct-progress-badge' }, batchLabel),
        h('span', null, t('progress.elapsed').replace('{time}', elapsed)),
        cancelled
          ? h('span', { className: 'dsh-ct-muted' }, t('progress.completed').replace('{done}', String(completed)).replace('{total}', String(total)))
          : running
            ? h('button', {
                className: 'dsh-ct-button dsh-ct-stop',
                type: 'button',
                onClick: onCancel,
              }, t('action.stop'))
            : null,
      ),
    ),
    h('div', { className: 'dsh-ct-progress-bar' },
      h('div', { className: 'dsh-ct-progress-fill', style: { width: `${percent}%` } }),
    ),
    showSteps ? h('div', { className: 'dsh-ct-steps' }, steps) : null,
    h('p', { className: 'dsh-ct-progress-status' }, progressStatus(progress, now, t)),
    progressTable(progress, t),
  )
}

/**
 * Describe the current progress phase.
 * @param progress - progress object.
 * @param now - current clock.
 * @param t - translator.
 * @returns human-facing status.
 */
function progressStatus(progress, now, t) {
  if (progress.cancelled === true) return t('progress.cancelled')
  if (progress.phase === 'error') return t('progress.error')
  if (progress.phase === 'wait') {
    const remaining = Math.max(0, Math.ceil(((progress.waitUntil ?? now) - now) / 1_000))
    const template = progress.kind === 'cache' ? t('progress.waitCache') : t('progress.waitGap')
    return template.replace('{s}', String(remaining))
  }
  if (progress.phase === 'request') {
    const index = progress.activeIndex ?? 0
    const label = progress.kind === 'cache'
      ? index === 0
        ? t('progress.warmup')
        : t('progress.retestRequesting').replace('{n}', String(index))
      : progress.kind === 'speed'
        ? t('progress.requesting').replace('{n}', String(index + 1))
        : t('progress.pelicanRequesting')
    const activeElapsed = progress.activeSince === null || progress.activeSince === undefined
      ? ''
      : ` · ${formatDuration(now - progress.activeSince)}`
    return `${label}${activeElapsed}`
  }
  if (progress.phase === 'between') {
    const total = Number.isFinite(progress.total) ? progress.total : progress.attempts.length
    return t('progress.completed').replace('{done}', String(progress.attempts.length)).replace('{total}', String(total))
  }
  return t('progress.starting')
}

/**
 * Live table with completed, active, and pending rounds.
 * @param progress - progress object.
 * @param t - translator.
 * @returns the table, or null for zero rounds.
 */
function progressTable(progress, t) {
  const total = Number.isFinite(progress.total) ? progress.total : progress.attempts.length
  if (total <= 0) return null
  if (total > 60) {
    return h('p', { className: 'dsh-ct-muted' },
      t('progress.largeRun').replace('{total}', String(total)),
    )
  }
  const kind = progress.kind
  const headers = kind === 'cache' ? cacheHeaders() : speedHeaders()
  const byIndex = new Map(progress.attempts.map((attempt) => [attempt.index, attempt]))
  const rows = []
  for (let index = 0; index < total; index += 1) {
    const attempt = byIndex.get(index)
    if (attempt !== undefined) {
      rows.push(kind === 'cache' ? cacheRow(attempt, t, headers.length) : speedRow(attempt, t, headers.length))
      continue
    }
    const active = progress.cancelled !== true
      && progress.phase !== 'error'
      && progress.activeIndex === index
    const label = kind === 'cache' ? attemptLabel(index, t) : String(index + 1)
    rows.push(h('tr', { key: index, className: active ? 'dsh-ct-row-active' : 'dsh-ct-row-pending' },
      h('td', null, label, active ? h('span', { className: 'dsh-ct-inline-spinner' }, h(Spinner, { small: true })) : null),
      ...Array.from({ length: Math.max(0, headers.length - 1) }, (_, cell) => h('td', { key: cell }, '—')),
    ))
  }
  return h('div', { className: 'dsh-ct-table-wrap' },
    h('table', { className: 'dsh-ct-table dsh-ct-live-table' },
      h('thead', null, h('tr', null, headers.map((key) => h('th', { key }, t(key))))),
      h('tbody', null, rows),
    ),
  )
}

/**
 * Render one provider option, marking providers with no models.
 * @param provider - catalog provider entry.
 * @param t - translator.
 * @returns the display label.
 */
function providerOptionLabel(provider, t) {
  const name = typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : provider.id
  return providerModels(provider).length === 0 ? `${name} · ${t('label.noModels')}` : name
}

/**
 * Render one reasoning-effort option.
 * @param effort - catalog effort descriptor.
 * @param t - translator.
 * @returns the display label.
 */
function reasoningLabel(effort, t) {
  const key = `reasoning.${effort.id}`
  const translated = t(key)
  if (translated !== key) return translated
  return typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id
}

/**
 * Build the advanced controls.
 * @param state - controller snapshot.
 * @param controller - page controller.
 * @param t - translator.
 * @param efforts - reasoning efforts the selected model advertises.
 * @returns the disclosure element.
 */
function advancedSettings(state, controller, t, efforts, reasoningFor) {
  const reasoningField = (kind, label) => effortField(label, efforts, reasoningFor(kind), (value) => controller.setReasoningOption(kind, value), t)
  return h('details', { className: 'dsh-ct-advanced' },
    h('summary', null, t('label.advanced')),
    h('fieldset', { className: 'dsh-ct-fieldset', disabled: state.running },
      h('div', { className: 'dsh-ct-fields' },
        numberField(t('form.size'), state.cacheOptions.size, CACHE_LIMITS.size, (value) => controller.setCacheOption('size', value)),
        numberField(t('form.cacheRounds'), state.cacheOptions.rounds, CACHE_LIMITS.rounds, (value) => controller.setCacheOption('rounds', value)),
        numberField(t('form.wait'), state.cacheOptions.wait, CACHE_LIMITS.wait, (value) => controller.setCacheOption('wait', value)),
        numberField(t('form.tokens'), state.speedOptions.tokens, SPEED_LIMITS.tokens, (value) => controller.setSpeedOption('tokens', value)),
        numberField(t('form.speedRounds'), state.speedOptions.rounds, SPEED_LIMITS.rounds, (value) => controller.setSpeedOption('rounds', value)),
        numberField(t('form.gap'), state.speedOptions.gap, SPEED_LIMITS.gap, (value) => controller.setSpeedOption('gap', value)),
        numberField(t('form.timeout'), state.cacheOptions.timeout, CACHE_LIMITS.timeout, (value) => {
          controller.setCacheOption('timeout', value)
          controller.setSpeedOption('timeout', value)
          controller.setPelicanOption('timeout', value)
        }),
        reasoningField('cache', t('form.reasoningCache')),
        reasoningField('speed', t('form.reasoningSpeed')),
        reasoningField('pelican', t('form.reasoningPelican')),
      ),
      state.cacheOptions.rounds > 10 || state.speedOptions.rounds > 10
        ? h('p', { className: 'dsh-ct-hint' }, t('form.roundsHint'))
        : null,
    ),
  )
}

/**
 * One reasoning-effort select.
 * @param label - field label.
 * @param efforts - advertised efforts for the selected model.
 * @param value - current effort id.
 * @param onChange - commit callback.
 * @param t - translator.
 * @returns the label element.
 */
function effortField(label, efforts, value, onChange, t) {
  // A saved effort the current model no longer advertises would render as an
  // empty box: no option matches `value`, so the browser shows a blank select.
  // Fall back to the first advertised effort instead of rendering nothing.
  const usable = typeof value === 'string' && efforts.some((effort) => effort.id === value)
    ? value
    : efforts[0]?.id ?? ''
  return h('label', { className: 'dsh-ct-field' },
    h('span', null, label),
    h('select', {
      className: 'dsh-ct-select',
      value: usable,
      disabled: efforts.length === 0,
      onChange: (event) => {
        if (event.target.value !== '') onChange(event.target.value)
      },
    },
    efforts.length === 0
      ? h('option', { value: '' }, t('label.noReasoning'))
      : efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, reasoningLabel(effort, t))),
    ),
  )
}

/**
 * One numeric field.
 * @param label - field label.
 * @param value - current value.
 * @param limits - inclusive range.
 * @param onChange - commit callback.
 * @returns the label element.
 */
function numberField(label, value, limits, onChange) {
  return h('label', { className: 'dsh-ct-field' },
    h('span', null, label),
    h('input', {
      type: 'number',
      min: limits[0],
      ...(Number.isFinite(limits[1]) ? { max: limits[1] } : {}),
      step: 1,
      value,
      onChange: (event) => {
        const next = event.target.valueAsNumber
        if (Number.isFinite(next)) onChange(next)
      },
    }),
  )
}

/**
 * One error banner.
 * @param message - error text.
 * @param onRetry - optional retry callback.
 * @param retryLabel - retry label.
 * @returns the banner element.
 */
function errorBanner(message, onRetry, retryLabel) {
  return h('div', { className: 'dsh-ct-banner', role: 'alert' },
    h('span', null, message),
    onRetry === undefined ? null : h('button', { className: 'dsh-ct-button', type: 'button', onClick: onRetry }, retryLabel),
  )
}

/**
 * Cache result card.
 * @param props - result payload and translator.
 * @returns the cache card.
 */
/**
 * Reject an SVG that still carries executable content after host-side cleanup.
 * @param svg - candidate markup.
 * @returns true when it is safe to inject.
 */
function isSafeSvg(svg) {
  // `on[a-z]+` would also match the `only` attribute, so require a word boundary.
  if (/<script[\s>]/iu.test(svg)) return false
  if (/<foreignObject[\s>]/iu.test(svg)) return false
  if (/[\s"']on(?:click|dblclick|load|error|mouseover|mouseout|mousedown|mouseup|mousemove|focus|blur|keydown|keyup|keypress|touchstart|touchend|touchmove|pointerdown|pointerup|pointerover|pointerout|animationstart|animationend|begin|end|repeat|activate|resize|scroll|wheel|input|change|submit)\s*=/iu.test(svg)) return false
  if (/(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|javascript:)/iu.test(svg)) return false
  return true
}

function PelicanCard({ result, checkedAt, sourceRoute, currentRoute, t }) {
  const summary = result?.summary
  const rawSvg = typeof result?.svg === 'string' && result.svg.length > 0 ? result.svg : null
  const safe = rawSvg !== null && isSafeSvg(rawSvg)
  const svg = safe ? rawSvg : null
  const attempt = result?.attempt
  const badge = result === null || result === undefined
    ? '—'
    : rawSvg === null
      ? t('pelican.missing')
      : safe ? t('pelican.generated') : t('pelican.blocked')
  return h('section', { className: 'dsh-ct-card', 'data-kind': 'pelican' },
    h('div', { className: 'dsh-ct-card-head' },
      h('h2', { className: 'dsh-ct-card-title' }, t('pelican.title')),
      h('span', { className: 'dsh-ct-badge' }, badge),
    ),
    resultMeta(checkedAt, sourceRoute, currentRoute, t),
    result === null || result === undefined
      ? h('p', { className: 'dsh-ct-empty' }, t('pelican.empty'))
      : h(React.Fragment, null,
          h('p', { className: 'dsh-ct-verdict' }, summary?.verdict ?? ''),
          rawSvg !== null && !safe
            ? h('p', { className: 'dsh-ct-error' }, t('pelican.blocked'))
            : null,
          svg === null
            ? null
            : h('div', { className: 'dsh-ct-pelican-preview' },
                h('div', { dangerouslySetInnerHTML: { __html: svg } }),
              ),
          h('div', { className: 'dsh-ct-pelican-stats' },
            attempt?.error === undefined
              ? h(React.Fragment, null,
                  h('span', null, `TTFT ${formatLatency(attempt?.ttftMs)}`),
                  h('span', null, formatThroughput(attempt?.tps)),
                  h('span', null, t('table.total') + ' ' + formatDuration(attempt?.durationMs)),
                  attempt?.summary?.output === undefined
                    ? null
                    : h('span', null, `输出 ${formatTokens(attempt.summary.output)} tok${attempt.summary.reasoning === undefined ? '' : `（推理 ${formatTokens(attempt.summary.reasoning)}）`}`),
                  h('span', null, `${t('table.svgLength')} ${result.svgLength ?? 0}`),
                )
              : h('span', { className: 'dsh-ct-error' }, attempt.error.message),
          ),
          reportDetails(result.report, t),
          typeof result.text === 'string' && result.text.length > 0
            ? h('details', { className: 'dsh-ct-report' },
                h('summary', null, t('pelican.raw')),
                h('pre', { className: 'dsh-ct-pre' }, result.text),
                h(CopyButton, { text: result.text, t }),
              )
            : null,
        ),
  )
}

function CacheCard({ result, checkedAt, sourceRoute, currentRoute, t }) {
  const summary = result?.summary
  return h('section', { className: 'dsh-ct-card', 'data-kind': 'cache' },
    h('div', { className: 'dsh-ct-card-head' },
      h('h2', { className: 'dsh-ct-card-title' }, t('cache.title')),
      h('span', { className: 'dsh-ct-badge' }, summary?.headline ?? '—'),
    ),
    resultMeta(checkedAt, sourceRoute, currentRoute, t),
    result === null || result === undefined
      ? h('p', { className: 'dsh-ct-empty' }, t('cache.empty'))
      : result.requestError !== undefined
        ? h('p', { className: 'dsh-ct-error' }, result.requestError)
        : h(React.Fragment, null,
            h('p', { className: 'dsh-ct-verdict' }, summary?.verdict ?? ''),
            cacheTable(result, t),
            realTrafficTable(result, t),
            reportDetails(result.report, t),
          ),
  )
}

/**
 * Speed result card.
 * @param props - result payload and translator.
 * @returns the speed card.
 */
function SpeedCard({ result, checkedAt, sourceRoute, currentRoute, t }) {
  const summary = result?.summary
  return h('section', { className: 'dsh-ct-card', 'data-kind': 'speed' },
    h('div', { className: 'dsh-ct-card-head' },
      h('h2', { className: 'dsh-ct-card-title' }, t('speed.title')),
      h('span', { className: 'dsh-ct-badge' }, summary?.headline ?? '—'),
    ),
    resultMeta(checkedAt, sourceRoute, currentRoute, t),
    result === null || result === undefined
      ? h('p', { className: 'dsh-ct-empty' }, t('speed.empty'))
      : result.requestError !== undefined
        ? h('p', { className: 'dsh-ct-error' }, result.requestError)
        : h(React.Fragment, null,
            h('p', { className: 'dsh-ct-verdict' }, summary?.verdict ?? ''),
            speedTable(result, t),
            reportDetails(result.report, t),
          ),
  )
}

/**
 * Format a result timestamp for the card meta row.
 * @param timestamp - epoch milliseconds.
 * @returns local `HH:mm:ss`, or `MM-DD HH:mm` when not today.
 */
function formatCheckedAt(timestamp) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Card meta row: last check time followed by the provider/model that produced
 * the result, then the originating-channel note when it differs from the
 * current selection.
 * @param checkedAt - epoch milliseconds or null.
 * @param sourceRoute - route that produced the result.
 * @param currentRoute - currently selected route.
 * @param t - translator.
 * @returns the meta row, or null when the card has no result.
 */
function resultMeta(checkedAt, sourceRoute, currentRoute, t) {
  if (checkedAt === null || checkedAt === undefined) return null
  const time = formatCheckedAt(checkedAt)
  if (time === '') return null
  const source = sourceRoute?.providerName ?? sourceRoute?.provider
  const model = sourceRoute?.model
  const routeLabel = [source, model].filter((part) => typeof part === 'string' && part.length > 0).join(' / ')
  const differs = sourceRoute !== null
    && sourceRoute !== undefined
    && (currentRoute === null
      || currentRoute === undefined
      || currentRoute.provider !== sourceRoute.provider
      || currentRoute.model !== sourceRoute.model)
  return h('p', { className: 'dsh-ct-card-meta' },
    h('span', null, t('label.lastChecked').replace('{time}', time)),
    routeLabel.length > 0
      ? h('span', { className: 'dsh-ct-route-tag' }, routeLabel)
      : null,
    differs && routeLabel.length > 0
      ? h('span', { className: 'dsh-ct-muted' }, t('label.fromRoute').replace('{route}', routeLabel))
      : null,
  )
}

/**
 * Cache attempt table.
 * @param result - cache payload.
 * @param t - translator.
 * @returns the table, or null when there are no attempts.
 */
function cacheHeaders() {
  return ['table.round', 'table.prompt', 'table.uncached', 'table.cacheRead', 'table.cacheWrite', 'table.hit', 'table.duration']
}

/**
 * Build one cache attempt row.
 * @param attempt - attempt record.
 * @param t - translator.
 * @param columns - total column count for an error row.
 * @returns the table row.
 */
function cacheRow(attempt, t, columns) {
  const label = attemptLabel(attempt.index, t)
  if (attempt.error !== undefined) {
    return h('tr', { key: attempt.index }, h('td', { colSpan: columns, className: 'dsh-ct-error-cell' }, `${label}：${attempt.error.message}（${attempt.error.code}）`))
  }
  const summary = attempt.summary
  return h('tr', { key: attempt.index },
    h('td', null, label),
    h('td', null, summary === undefined ? '—' : formatTokens(summary.prompt)),
    h('td', null, summary === undefined ? '—' : formatTokens(summary.uncached)),
    h('td', null, summary === undefined ? '—' : formatTokens(summary.cacheRead)),
    h('td', null, summary === undefined ? '—' : formatTokens(summary.cacheWrite)),
    h('td', null, summary === undefined ? '—' : formatRate(summary.hitRate)),
    h('td', null, formatDuration(attempt.durationMs)),
  )
}

/**
 * Average row for the cache table.
 * @param attempts - all cache attempts.
 * @param t - translator.
 * @returns the average row.
 */
function cacheAverageRow(attempts, t) {
  const avg = averageCacheAttempts(attempts)
  const label = avg === null
    ? t('table.average')
    : t('table.averageRetest').replace('{n}', String(avg.count))
  return h('tr', { key: 'average', className: 'dsh-ct-avg-row', title: t('table.averageHint') },
    h('td', null, label),
    h('td', null, avg === null ? '—' : formatTokens(avg.prompt)),
    h('td', null, avg === null ? '—' : formatTokens(avg.uncached)),
    h('td', null, avg === null ? '—' : formatTokens(avg.cacheRead)),
    h('td', null, avg === null ? '—' : formatTokens(avg.cacheWrite)),
    h('td', null, avg === null ? '—' : formatRate(avg.hitRate)),
    h('td', null, avg === null ? '—' : formatDuration(avg.durationMs)),
  )
}

function cacheTable(result, t) {
  const attempts = Array.isArray(result.attempts) ? result.attempts : []
  if (attempts.length === 0) return null
  const headers = cacheHeaders()
  return h('div', { className: 'dsh-ct-table-wrap' },
    h('table', { className: 'dsh-ct-table' },
      h('thead', null, h('tr', null, headers.map((key) => h('th', { key }, t(key))))),
      h('tbody', null, [
        ...attempts.map((attempt) => cacheRow(attempt, t, headers.length)),
        cacheAverageRow(attempts, t),
      ]),
    ),
  )
}

/**
 * Speed attempt table.
 * @param result - speed payload.
 * @param t - translator.
 * @returns the table, or null when there are no attempts.
 */
function speedHeaders() {
  return ['table.round', 'table.output', 'table.ttft', 'table.tps', 'table.total']
}

/**
 * Build one speed attempt row.
 * @param attempt - attempt record.
 * @param t - translator.
 * @param columns - total column count for an error row.
 * @returns the table row.
 */
function speedRow(attempt, t, columns) {
  const label = `${attempt.index + 1}`
  if (attempt.error !== undefined) {
    return h('tr', { key: attempt.index }, h('td', { colSpan: columns, className: 'dsh-ct-error-cell' }, `${label}：${attempt.error.message}（${attempt.error.code}）`))
  }
  const output = formatOutputSplit(attempt.summary)
  const note = attempt.summary !== undefined && attempt.summary.output > 0 && attempt.textChars === 0
    ? h('span', { className: 'dsh-ct-muted' }, `（${t('label.noVisible')}）`)
    : null
  return h('tr', { key: attempt.index },
    h('td', null, label),
    h('td', { title: t('table.outputHint') }, output, note),
    h('td', null, formatLatency(attempt.ttftMs)),
    h('td', null, attempt.ttftMs === undefined ? '—' : formatThroughput(attempt.tps)),
    h('td', null, formatDuration(attempt.durationMs)),
  )
}

/**
 * Average row for the speed table.
 * @param attempts - all speed attempts.
 * @param t - translator.
 * @returns the average row.
 */
function speedAverageRow(attempts, t) {
  const avg = averageSpeedAttempts(attempts)
  const output = avg === null || avg.output === null
    ? '—'
    : avg.reasoning === null
      ? formatTokens(avg.output)
      : `${formatTokens(avg.reasoning)}/${formatTokens(avg.content ?? 0)}`
  return h('tr', { key: 'average', className: 'dsh-ct-avg-row', title: t('table.averageHint') },
    h('td', null, t('table.average')),
    h('td', null, output),
    h('td', null, avg === null ? '—' : formatLatency(avg.ttftMs)),
    h('td', null, avg === null ? '—' : formatThroughput(avg.tps)),
    h('td', null, avg === null ? '—' : formatDuration(avg.durationMs)),
  )
}

function speedTable(result, t) {
  const attempts = Array.isArray(result.attempts) ? result.attempts : []
  if (attempts.length === 0) return null
  const headers = speedHeaders()
  return h('div', { className: 'dsh-ct-table-wrap' },
    h('table', { className: 'dsh-ct-table' },
      h('thead', null, h('tr', null, headers.map((key) => h('th', { key }, t(key))))),
      h('tbody', null, [
        ...attempts.map((attempt) => speedRow(attempt, t, headers.length)),
        speedAverageRow(attempts, t),
      ]),
    ),
  )
}

/**
 * Real per-channel traffic captured from the originating session.
 * @param result - cache payload.
 * @param t - translator.
 * @returns the subsection, or null.
 */
function realTrafficTable(result, t) {
  const rows = Array.isArray(result.sessionChannels) ? result.sessionChannels : []
  if (rows.length === 0) return null
  return h('div', { className: 'dsh-ct-subsection' },
    h('h3', { className: 'dsh-ct-subtitle' }, t('label.realTraffic')),
    h('div', { className: 'dsh-ct-table-wrap' },
      h('table', { className: 'dsh-ct-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('table.channel')),
          h('th', null, t('table.requests')),
          h('th', null, t('table.billed')),
          h('th', null, t('table.hit')),
        )),
        h('tbody', null, rows.map((row) => h('tr', { key: row.provider },
          h('td', null, row.provider),
          h('td', null, String(row.requests)),
          h('td', null, formatTokens(row.prompt)),
          h('td', null, formatRate(row.hitRate)),
        ))),
      ),
    ),
  )
}

/**
 * Collapsible raw report and copy button.
 * @param report - report text.
 * @param t - translator.
 * @returns the details element, or null.
 */
function reportDetails(report, t) {
  if (typeof report !== 'string' || report.length === 0) return null
  return h('details', { className: 'dsh-ct-report' },
    h('summary', null, t('label.textReport')),
    h('pre', { className: 'dsh-ct-pre' }, report),
    h(CopyButton, { text: report, t }),
  )
}

/**
 * Copy-to-clipboard button.
 * @param props - report text and translator.
 * @returns the button.
 */
function CopyButton({ text, t }) {
  const [copied, setCopied] = React.useState(false)
  return h('button', {
    className: 'dsh-ct-button dsh-ct-copy',
    type: 'button',
    onClick: () => {
      try {
        const copiedPromise = typeof navigator === 'undefined' ? undefined : navigator.clipboard?.writeText?.(text)
        if (copiedPromise !== undefined) void copiedPromise.catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 1_500)
      } catch {
        // Clipboard is optional.
      }
    },
  }, copied ? t('action.copied') : t('action.copy'))
}

/**
 * Attempt label for the cache table.
 * @param index - attempt index.
 * @param t - translator.
 * @returns `预热` or `复测 N`.
 */
function attemptLabel(index, t) {
  if (index === 0) return t('table.warmup')
  return t('table.retest').replace('{n}', String(index))
}

/**
 * Composer dock button that opens the page.
 * @param controller - page controller.
 * @param t - translator.
 * @returns the React component.
 */
function createOpenButton(controller, t) {
  return function OpenButton() {
    const ref = React.useRef(null)
    return h('span', { className: 'dsh-ct-pill', 'data-composer-stat': PANEL_ID },
      h('button', {
        ref,
        className: 'dsh-ct-pill-button',
        type: 'button',
        title: t('panel.openTitle'),
        'aria-label': t('panel.label'),
        onClick: () => {
          const root = ref.current?.closest?.(`[${SESSION_ATTRIBUTE}]`)
          const sessionId = root?.getAttribute?.(SESSION_ATTRIBUTE) ?? undefined
          controller.open(sessionId)
        },
      },
      gaugeIcon(14),
      h('span', { className: 'dsh-ct-pill-label' }, t('panel.label')),
      ),
    )
  }
}

/**
 * Sidebar panel glyph.
 * @param props - the shell's icon share.
 * @returns the gauge SVG.
 */
function PanelIcon({ size = 16 }) {
  return gaugeIcon(size, PANEL_ID)
}

/**
 * Draw the gauge glyph.
 * @param size - square edge in pixels.
 * @param entry - optional panel id for the semantic hook.
 * @returns the SVG element.
 */
function gaugeIcon(size, entry) {
  return h('svg', {
    'data-dsh-panel-entry': entry,
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
  h('path', { d: 'M2.5 12.5a5.5 5.5 0 0 1 11 0' }),
  h('path', { d: 'M8 12.5 10.8 7.8' }),
  h('circle', { cx: 8, cy: 12.5, r: 1.2, fill: 'currentColor', stroke: 'none' }),
  )
}

/** Install the page stylesheet once per document. */
function installStyles() {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[${STYLE_ATTRIBUTE}]`)
  if (existing !== null) return () => {}
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, '')
  element.textContent = STYLES
  document.head.appendChild(element)
  return () => element.remove()
}

/** Page and pill styles. */
const STYLES = `
.dsh-ct-page {
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  padding: calc(var(--dsh-frame-top-clearance, 0px) + 28px) 28px 56px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}
.dsh-ct-shell { max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
.dsh-ct-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.dsh-ct-heading { min-width: 0; }
.dsh-ct-title { margin: 0; font-size: 24px; line-height: 1.25; font-weight: 650; }
.dsh-ct-subtitle { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsh-ct-header-actions { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.dsh-ct-pickers { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.dsh-ct-picker { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
.dsh-ct-route-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-ct-select {
  height: 32px; min-width: 180px; max-width: 280px;
  padding: 0 10px; border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px;
}
.dsh-ct-note { margin: -6px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-ct-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ct-status { margin-left: 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-ct-button {
  height: 32px; padding: 0 14px; border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; cursor: pointer;
}
.dsh-ct-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-ct-button:disabled { opacity: 0.5; cursor: default; }
.dsh-ct-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
}
.dsh-ct-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-ct-advanced {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1);
  padding: 10px 14px;
}
.dsh-ct-advanced summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsh-ct-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.dsh-ct-fields {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px 14px; margin-top: 12px;
}
.dsh-ct-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-ct-hint { margin: 10px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
.dsh-ct-field input,
.dsh-ct-field select {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: none;
  height: 30px; padding: 0 8px; border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background-color: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: inherit; font-size: 13px;
}
/* Native select chrome varies per platform and drops its background once the
   control takes focus, which left one dropdown looking invisible after use.
   Draw the control ourselves so every state keeps the same opaque box. */
.dsh-ct-field select {
  -webkit-appearance: none; appearance: none;
  padding-right: 26px; cursor: pointer;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23808a99' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px 6px;
}
.dsh-ct-field select:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.32)); }
.dsh-ct-field select:focus,
.dsh-ct-field select:focus-visible,
.dsh-ct-field input:focus,
.dsh-ct-field input:focus-visible {
  background-color: var(--dsw-alias-bg-base, #fff);
  border-color: var(--dsw-alias-state-business-primary, #4c8dff);
  outline: none;
  box-shadow: 0 0 0 3px rgba(76, 141, 255, 0.22);
}
.dsh-ct-field select:disabled { cursor: default; opacity: 0.6; }
.dsh-ct-field select option { background-color: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-ct-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.dsh-ct-pelican-preview {
  max-width: 760px; margin: 4px auto 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 8px);
  background: #fff; padding: 8px;
}
.dsh-ct-pelican-preview svg { display: block; width: 100%; height: auto; }
.dsh-ct-pelican-stats { display: flex; gap: 10px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dsh-ct-progress {
  display: flex; flex-direction: column; gap: 14px;
  padding: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-ct-progress-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsh-ct-progress-title { margin: 0; font-size: 16px; font-weight: 600; }
.dsh-ct-progress-route { margin: 5px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-ct-progress-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-ct-progress-badge {
  padding: 2px 8px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dsh-ct-progress-bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsh-ct-progress-fill { height: 100%; border-radius: inherit; background: var(--dsw-alias-state-business-primary, #4c8dff); transition: width 0.25s ease; }
.dsh-ct-steps { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ct-step {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dsh-ct-step.is-active { border-color: var(--dsw-alias-state-business-primary, #4c8dff); color: var(--dsw-alias-state-business-primary, #4c8dff); }
.dsh-ct-step.is-active .dsh-ct-step-mark { background: transparent; }
.dsh-ct-step.is-done { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-secondary); }
.dsh-ct-step.is-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsh-ct-step-mark {
  width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; background: var(--dsw-alias-bg-layer-2);
  font-size: 10px; line-height: 1;
}
.dsh-ct-progress-status { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsh-ct-spinner {
  width: 14px; height: 14px; display: block; flex: none;
  transform-origin: 50% 50%;
  animation: dsh-ct-spin 0.8s linear infinite;
}
.dsh-ct-spinner.is-small { width: 12px; height: 12px; }
.dsh-ct-inline-spinner { display: inline-flex; margin-left: 6px; vertical-align: -2px; }
.dsh-ct-row-active td { background: var(--dsw-alias-bg-layer-2); }
.dsh-ct-row-pending td { color: var(--dsw-alias-label-tertiary); }
.dsh-ct-stop { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-ct-stop:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
@keyframes dsh-ct-spin { to { transform: rotate(360deg); } }
.dsh-ct-card {
  min-width: 0; padding: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-ct-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsh-ct-card-title { margin: 0; font-size: 15px; font-weight: 600; }
.dsh-ct-badge {
  display: inline-block; padding: 3px 9px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.dsh-ct-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dsh-ct-route-tag { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.dsh-ct-verdict { margin: 10px 0 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsh-ct-empty { margin: 14px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dsh-ct-error { margin: 14px 0 0; color: var(--dsw-alias-state-error-primary); font-size: 13px; }
.dsh-ct-table-wrap { overflow-x: auto; }
.dsh-ct-table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-ct-table th, .dsh-ct-table td { padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); text-align: right; white-space: nowrap; }
.dsh-ct-table th:first-child, .dsh-ct-table td:first-child { text-align: left; }
.dsh-ct-table th { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.dsh-ct-table tbody tr:last-child td { border-bottom: 0; }
.dsh-ct-error-cell { color: var(--dsw-alias-state-error-primary); text-align: left !important; white-space: normal !important; }
.dsh-ct-avg-row td { font-weight: 600; border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dsh-ct-muted { color: var(--dsw-alias-label-tertiary); }
.dsh-ct-subsection { margin-top: 16px; }
.dsh-ct-subtitle { margin: 0 0 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; }
.dsh-ct-report { margin-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; }
.dsh-ct-report summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-ct-pre {
  margin: 10px 0; padding: 12px; max-height: 260px; overflow: auto;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary);
  font-family: var(--dsh-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
}
.dsh-ct-copy { height: 28px; font-size: 12px; }
.dsh-ct-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 10px 12px; border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
.dsh-ct-pill { display: inline-flex; align-items: center; }
.dsh-ct-pill-button {
  display: inline-flex; align-items: center; gap: 5px;
  height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  padding: 1px 8px; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  cursor: pointer;
}
.dsh-ct-pill-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dsh-ct-pill-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4c8dff); outline-offset: 1px; }
.dsh-ct-pill-label { white-space: nowrap; }
@media (max-width: 480px) {
  .dsh-ct-page { padding-left: 16px; padding-right: 16px; }
  .dsh-ct-pill-label { display: none; }
  .dsh-ct-pickers { width: 100%; }
  .dsh-ct-picker, .dsh-ct-picker .dsh-ct-select { min-width: 0; max-width: none; width: 100%; }
}
`