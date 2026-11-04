/**
 * Host route family for the channel-test page.
 *
 * Two exact routes replace the former slash commands:
 * - GET  /api/dsh-cache-probe/models  — active providers, their models, and a default route;
 * - POST /api/dsh-cache-probe/run     — one cache or speed test, returning structured attempts.
 *
 * The routes call `ctx.llm` directly, so no command lifecycle or model-visible
 * message is written. Every route is fenced by `http.mjs` before any work.
 *
 * @module dsh-cache-probe/routes
 */

import { describeFailure } from './errors.mjs'
import { HttpError, guard, readJson, writeJson } from './http.mjs'
import {
  OptionError,
  normalizeCacheOptions,
  normalizePelicanOptions,
  normalizeSpeedOptions,
} from './options.mjs'
import {
  extractSvg,
  normalizePelicanError,
  runPelicanTest,
  summarizePelicanResult,
} from './pelican.mjs'
import {
  ProbeError,
  defaultSleep,
  formatProbeReport,
  runProbe,
  summarizeProbeResult,
} from './probe.mjs'
import { formatSpeedReport, runSpeedTest, summarizeSpeedResult } from './speed.mjs'
import { aggregateSessionChannels } from './stats.mjs'

/** Exact route paths. The client mirrors them without a leading slash. */
export const ROUTES = Object.freeze({
  models: '/api/dsh-cache-probe/models',
  run: '/api/dsh-cache-probe/run',
})

/**
 * Build the route list.
 * @param ctx - host context carrying `llm`, optional `sessions`/`sessionProjections`.
 * @returns route objects for `ctx.webServer.register`.
 */
export function createRoutes(ctx) {
  let active = false

  return [
    {
      kind: 'exact',
      path: ROUTES.models,
      handler: (req, res) => handleModels(ctx, req, res),
    },
    {
      kind: 'exact',
      path: ROUTES.run,
      handler: (req, res) => handleRun(ctx, req, res, {
        begin: () => {
          if (active) return false
          active = true
          return true
        },
        end: () => {
          active = false
        },
      }),
    },
  ]
}

/**
 * Handle one catalog request.
 * @param ctx - host context.
 * @param req - incoming request.
 * @param res - outgoing response.
 */
async function handleModels(ctx, req, res) {
  if (!guard(ctx, req, res, 'GET')) return
  try {
    const providers = await buildCatalog(ctx)
    const sessionId = new URL(req.url ?? '/', 'http://x').searchParams.get('sessionId') ?? undefined
    const defaultRoute = findDefaultRoute(ctx, sessionId, providers)
    writeJson(res, 200, { ok: true, providers, defaultRoute })
  } catch (error) {
    writeError(res, error)
  }
}

/**
 * Handle one cache/speed test request.
 * @param ctx - host context.
 * @param req - incoming request.
 * @param res - outgoing response.
 * @param gate - single-flight begin/end callbacks.
 */
async function handleRun(ctx, req, res, gate) {
  if (!guard(ctx, req, res, 'POST', { requireProbeHeader: true })) return
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    writeError(res, error)
    return
  }

  const kind = body.kind
  if (kind !== 'cache' && kind !== 'speed' && kind !== 'pelican') {
    writeJson(res, 400, { ok: false, error: { code: 'INVALID_KIND', message: 'kind 必须是 cache、speed 或 pelican' } })
    return
  }
  const provider = typeof body.provider === 'string' ? body.provider : ''
  const model = typeof body.model === 'string' ? body.model : ''
  if (provider.length === 0 || model.length === 0) {
    writeJson(res, 400, { ok: false, error: { code: 'INVALID_ROUTE', message: 'provider 与 model 不能为空' } })
    return
  }

  let cacheOptions
  let speedOptions
  let pelicanOptions
  try {
    cacheOptions = normalizeCacheOptions(body.cache)
    speedOptions = normalizeSpeedOptions(body.speed)
    pelicanOptions = normalizePelicanOptions(body.pelican)
  } catch (error) {
    writeError(res, error)
    return
  }

  if (!gate.begin()) {
    writeJson(res, 409, { ok: false, error: { code: 'BUSY', message: '已有渠道测试正在进行，请稍后再试' } })
    return
  }

  const input = {
    ctx,
    kind,
    provider,
    model,
    sessionId: body.sessionId,
    cacheOptions,
    speedOptions,
    pelicanOptions,
    startedAt: Date.now(),
  }
  if (req.headers['x-dsh-cache-probe-stream'] === '1') {
    await handleRunStream(input, req, res, gate)
    return
  }

  try {
    const payload = await executeRun(input)
    writeJson(res, 200, payload)
  } catch (error) {
    writeError(res, error)
  } finally {
    gate.end()
  }
}

/**
 * Execute one cache or speed test and build the final payload.
 * @param input - validated request input.
 * @param hooks - optional streaming callbacks and abort signal.
 * @returns the response payload.
 */
async function executeRun(input, hooks = {}) {
  const { ctx, kind, provider, model, sessionId, cacheOptions, speedOptions, pelicanOptions, startedAt } = input
  const route = { provider, model }
  const channelName = resolveChannelName(ctx.llm, provider)

  if (kind === 'cache') {
    const session = findSession(ctx, sessionId)
    let events = []
    try {
      if (typeof session?.snapshotEvents === 'function') events = session.snapshotEvents()
    } catch {
      // Real-traffic context is advisory; the probe itself can still run.
    }
    const sessionChannels = aggregateSessionChannels(events)
    const result = await runProbe({
      llm: ctx.llm,
      route,
      options: cacheOptions,
      signal: hooks.signal,
      sleep: hooks.sleep,
      onAttemptStart: hooks.onAttemptStart,
      onAttempt: hooks.onAttempt,
    })
    const summary = summarizeProbeResult(result.attempts)
    const report = formatProbeReport({
      route,
      channelName,
      options: cacheOptions,
      attempts: result.attempts,
      payloadChars: result.payloadChars,
      sessionChannels,
    })
    return {
      ok: true,
      kind,
      route,
      channelName,
      durationMs: Date.now() - startedAt,
      cache: {
        attempts: result.attempts,
        payloadChars: result.payloadChars,
        sessionChannels,
        report,
        summary,
      },
    }
  }

  if (kind === 'pelican') {
    hooks.onAttemptStart?.(0)
    let attempt
    try {
      attempt = { index: 0, ...await runPelicanTest({
        llm: ctx.llm,
        route,
        options: pelicanOptions,
        signal: hooks.signal,
      }) }
    } catch (error) {
      const failure = normalizePelicanFailure(error)
      attempt = { index: 0, error: failure }
    }
    hooks.onAttempt?.(attempt)
    const extracted = attempt.error === undefined
      ? extractSvg(attempt.text)
      : { svg: null, source: 'none', length: 0 }
    const { summary, report } = summarizePelicanResult({
      route,
      channelName,
      options: pelicanOptions,
      attempt,
      extracted,
    })
    return {
      ok: true,
      kind,
      route,
      channelName,
      durationMs: Date.now() - startedAt,
      pelican: {
        attempt,
        text: attempt.error === undefined ? attempt.text : '',
        svg: extracted.svg,
        svgSource: extracted.source,
        svgLength: extracted.length,
        report,
        summary,
      },
    }
  }

  const result = await runSpeedTest({
    llm: ctx.llm,
    route,
    options: speedOptions,
    signal: hooks.signal,
    sleep: hooks.sleep,
    onAttemptStart: hooks.onAttemptStart,
    onAttempt: hooks.onAttempt,
  })
  const summary = summarizeSpeedResult(result.attempts)
  const report = formatSpeedReport({
    route,
    channelName,
    options: speedOptions,
    attempts: result.attempts,
  })
  return {
    ok: true,
    kind,
    route,
    channelName,
    durationMs: Date.now() - startedAt,
    speed: {
      attempts: result.attempts,
      report,
      summary,
    },
  }
}

/**
 * Stream one run as newline-delimited JSON.
 * @param input - validated request input.
 * @param req - incoming request.
 * @param res - outgoing response.
 * @param gate - single-flight end callback.
 */
async function handleRunStream(input, _req, res, gate) {
  const { ctx, kind, provider, model, cacheOptions, speedOptions, pelicanOptions, startedAt } = input
  const controller = new AbortController()
  let ended = false
  let heartbeat
  let onClose

  /**
   * Write one event when the response is still writable.
   * @param event - JSON-safe event.
   */
  const send = (event) => {
    if (ended || res.writableEnded || res.destroyed) return
    try {
      res.write(`${JSON.stringify(event)}\n`)
      res.flush?.()
    } catch {
      // The client may have gone away between the checks and the write.
    }
  }

  try {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
    onClose = () => {
      if (!ended && !res.writableEnded) controller.abort()
    }
    res.on?.('close', onClose)

    heartbeat = setInterval(() => {
      send({ type: 'heartbeat', elapsedMs: Date.now() - startedAt })
    }, 10_000)

    const total = kind === 'cache' ? cacheOptions.rounds + 1 : kind === 'speed' ? speedOptions.rounds : 1
    send({
      type: 'start',
      kind,
      route: { provider, model },
      channelName: resolveChannelName(ctx.llm, provider),
      options: kind === 'cache' ? cacheOptions : kind === 'speed' ? speedOptions : pelicanOptions,
      total,
    })

    const streamSleep = async (milliseconds, signal) => {
      send({ type: 'wait', seconds: milliseconds / 1_000 })
      try {
        await defaultSleep(milliseconds, signal)
      } finally {
        send({ type: 'wait-done' })
      }
    }

    const payload = await executeRun(input, {
      signal: controller.signal,
      sleep: streamSleep,
      onAttemptStart: (index) => send({ type: 'attempt-start', index }),
      onAttempt: (attempt) => send({
        type: 'attempt',
        index: attempt.index,
        attempt,
        completed: attempt.index + 1,
        total,
      }),
    })

    if (controller.signal.aborted) {
      send({ type: 'error', error: { code: 'ABORTED', message: '测试已停止' } })
    } else {
      send({ type: 'done', ...payload })
    }
  } catch (error) {
    send({
      type: 'error',
      error: controller.signal.aborted
        ? { code: 'ABORTED', message: '测试已停止' }
        : errorPayload(error),
    })
  } finally {
    ended = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (onClose !== undefined) res.off?.('close', onClose)
    if (!res.writableEnded) {
      try {
        res.end()
      } catch {
        // The socket may already be closed.
      }
    }
    gate.end()
  }
}

/**
 * List active providers and their advertised models.
 * @param ctx - host context.
 * @returns provider directory entries; a failing provider keeps an `error` string.
 */
async function buildCatalog(ctx) {
  const providers = []
  for (const entry of ctx.llm.listProviders()) {
    try {
      const models = await ctx.llm.listModels(entry.id)
      providers.push({
        id: entry.id,
        name: entry.name,
        models: models.map((model) => ({ id: model.id, name: model.name })),
      })
    } catch (error) {
      providers.push({
        id: entry.id,
        name: entry.name,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return providers
}

/**
 * Pick the initial route for the page.
 *
 * Precedence: the session's next model selection, the session's last request
 * header, then the first advertised model. A saved client route is applied by
 * the page itself before this default is used.
 * @param ctx - host context.
 * @param sessionId - optional session id from the page.
 * @param providers - catalog entries.
 * @returns `{ provider, model }` or null.
 */
function findDefaultRoute(ctx, sessionId, providers) {
  const session = findSession(ctx, sessionId)
  if (session !== undefined) {
    try {
      const state = ctx.get('sessionProjections', false)?.stateOf?.(session, 'modelSelection')
      const selected = state?.pending ?? state?.next ?? state?.lastUsed
      if (isKnownRoute(providers, selected)) return { provider: selected.provider, model: selected.model }
    } catch {
      // A deployment without the projection falls through.
    }
    try {
      const config = session.requestHeader?.()?.config
      if (isKnownRoute(providers, config)) return { provider: config.provider, model: config.model }
    } catch {
      // No logged request yet.
    }
  }
  for (const provider of providers) {
    if (provider.models.length > 0) return { provider: provider.id, model: provider.models[0].id }
  }
  return null
}

/**
 * Resolve one live session by id.
 * @param ctx - host context.
 * @param sessionId - candidate id.
 * @returns the session, or undefined.
 */
function findSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  try {
    const sessions = ctx.get('sessions', false)
    if (typeof sessions?.list !== 'function') return undefined
    return sessions.list().find((session) => (session.id ?? session.header?.id) === sessionId)
  } catch {
    return undefined
  }
}

/**
 * Whether one candidate route appears in the catalog.
 * @param providers - catalog entries.
 * @param candidate - `{ provider, model }` candidate.
 * @returns true when both ids match.
 */
function isKnownRoute(providers, candidate) {
  if (candidate === null || typeof candidate !== 'object') return false
  return providers.some((provider) => provider.id === candidate.provider
    && provider.models.some((model) => model.id === candidate.model))
}

/**
 * Resolve a provider's configured display name.
 * @param llm - LLM service.
 * @param provider - provider id.
 * @returns display name, or the id.
 */
function resolveChannelName(llm, provider) {
  try {
    const found = llm.listProviders().find((entry) => entry.id === provider)
    if (found !== undefined && typeof found.name === 'string' && found.name.length > 0) return found.name
  } catch {
    // Fall through to the id.
  }
  return provider
}

/**
 * Write one route failure.
 * @param res - outgoing response.
 * @param error - thrown value.
 */
function writeError(res, error) {
  const status = error instanceof HttpError
    ? error.status
    : error instanceof OptionError
      ? 400
      : error instanceof ProbeError
        ? error.code === 'TIMEOUT' ? 504 : 502
        : 500
  writeJson(res, status, { ok: false, error: errorPayload(error) })
}

/**
 * Normalize a thrown value into a route error payload.
 * @param error - thrown value.
 * @returns `{ code, message }`.
 */
/** Normalize a pelican failure for the attempt record. */
const normalizePelicanFailure = normalizePelicanError

function errorPayload(error) {
  if (error instanceof HttpError) return { code: error.code, message: error.message }
  if (error instanceof OptionError) return { code: error.code, message: error.message }
  if (error instanceof ProbeError) {
    return { code: error.code, message: describeFailure(error.code, error.message) }
  }
  const code = typeof error?.code === 'string' ? error.code : 'PROBE_FAILED'
  const message = error instanceof Error ? error.message : String(error)
  return { code, message: describeFailure(code, message) }
}