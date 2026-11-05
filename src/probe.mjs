/**
 * Active prompt-cache probe.
 *
 * The probe is intentionally independent of the agent loop: it calls the LLM
 * service directly with a synthetic request-only message, captures the provider
 * usage chunk, and never appends a user/assistant message to the Session. The
 * only durable trace is the page's HTTP request.
 *
 * `runProbe` accepts its clock and sleep function so the complete request
 * sequence is testable without a provider or real waiting.
 *
 * @module dsh-cache-probe/probe
 */

import { describeFailure } from './errors.mjs'
import { buildProbePayload } from './payload.mjs'
import { formatDuration, formatRate, formatTokens, summarizeUsage } from './stats.mjs'

/** Output cap for every probe request; cache accounting is prompt-side only. */
export const MAX_OUTPUT_TOKENS = 32

/** Circled markers used for the per-attempt report lines. */
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥']

/** Human-facing failure with a stable provider-neutral code. */
export class ProbeError extends Error {
  /**
   * @param code - stable diagnostic code (provider code or `PROBE_FAILED`).
   * @param message - human-facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ProbeError'
    this.code = code
  }
}

/**
 * Resolve the route a probe should use.
 *
 * Order: explicit command argument, the Session's next model selection, the
 * last logged request header, then the most recent settled assistant message.
 * The projection is optional because a deployment may omit
 * `dsh-session-projection`; every source is read defensively.
 * @param input - session, optional projection registry, explicit route, and log snapshot.
 * @returns `{ provider, model }`, or undefined when nothing identifies a route.
 */
export function resolveRoute({ session, projections, explicit, events }) {
  if (explicit !== undefined && explicit !== null) return explicit

  try {
    const state = projections?.stateOf?.(session, 'modelSelection')
    const selected = state?.pending ?? state?.next ?? state?.lastUsed
    if (isRoute(selected)) return { provider: selected.provider, model: selected.model }
  } catch {
    // A deployment without the projection simply falls through.
  }

  try {
    const config = session?.requestHeader?.()?.config
    if (isRoute(config)) return { provider: config.provider, model: config.model }
  } catch {
    // A Session that has not logged a request yet has no header.
  }

  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'assistant/message') continue
      const source = event.data?.message?.source
      if (isRoute(source)) return { provider: source.provider, model: source.model }
    }
  }
  return undefined
}

/**
 * Whether one value carries a usable provider/model pair.
 * @param value - candidate.
 * @returns true when both fields are non-empty strings.
 */
function isRoute(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.provider === 'string'
    && value.provider.length > 0
    && typeof value.model === 'string'
    && value.model.length > 0
}

/**
 * Run one warm-up request followed by `options.rounds` identical measurements.
 * @param input - LLM service, route, execution controls, cancellation, and test seams.
 * @returns the attempt records and the payload length actually sent.
 * @throws {ProbeError} when the caller aborts or the first request cannot be prepared.
 */
export async function runProbe(input) {
  const {
    llm,
    route,
    options,
    reasoning,
    signal,
    sleep = defaultSleep,
    now = Date.now,
    onAttemptStart,
    onAttempt,
  } = input
  const payload = buildProbePayload(options.size)
  const attempts = []

  for (let index = 0; index <= options.rounds; index += 1) {
    if (signal?.aborted) throw new ProbeError('ABORTED', '探测已取消')
    if (index > 0 && options.wait > 0) {
      await sleep(options.wait * 1_000, signal)
      if (signal?.aborted) throw new ProbeError('ABORTED', '探测已取消')
    }
    onAttemptStart?.(index)
    try {
      const attempt = await callOnce({
        llm,
        route,
        prompt: payload,
        maxTokens: MAX_OUTPUT_TOKENS,
        reasoningEffort: reasoning,
        signal,
        timeoutMs: options.timeout * 1_000,
        now,
      })
      const record = {
        index,
        ...attempt,
        summary: summarizeUsage(attempt.usage),
      }
      attempts.push(record)
      onAttempt?.(record)
    } catch (error) {
      const record = { index, error: normalizeProbeError(error) }
      attempts.push(record)
      onAttempt?.(record)
      break
    }
  }

  return { attempts, payloadChars: payload.length }
}

/**
 * Dispatch exactly one prepared request.
 *
 * `prepareCall` is one-shot per invocation, so every attempt prepares its own
 * call. That also re-resolves the current adapter generation for each request,
 * which is what a live probe should observe.
 * @param input - LLM service, route, payload, cancellation, timeout, and clock.
 * @returns usage, finish reason, and timings for one attempt.
 */
export async function callOnce({ llm, route, prompt, maxTokens, reasoningEffort, signal, timeoutMs, now }) {
  const controller = new AbortController()
  let timedOut = false
  const onOuterAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const config = { provider: route.provider, model: route.model }
    if (Number.isSafeInteger(maxTokens) && maxTokens > 0) config.maxTokens = maxTokens
    const configure = typeof reasoningEffort === 'string' && reasoningEffort.length > 0
      ? (controls) => ({ ...controls, reasoningEffort })
      : lowestReasoning
    const prepared = await llm.prepareCall(
      config,
      controller.signal,
      configure,
    )
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    }]
    const options = {
      ...prepared.config,
      messages,
      signal: controller.signal,
    }

    const startedAt = now()
    let firstTokenAt
    let text = ''
    let usage
    let finish
    for await (const chunk of prepared.stream(options)) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'usage') {
        usage = chunk.usage
        continue
      }
      if (chunk.type === 'finish') {
        finish = chunk.reason
        continue
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (firstTokenAt === undefined && isTokenChunk(chunk)) firstTokenAt = now()
    }
    const endedAt = now()

    if (signal?.aborted) throw new ProbeError('ABORTED', '探测已取消')
    if (timedOut) throw new ProbeError('TIMEOUT', `单次请求超时（${Math.round(timeoutMs / 1_000)}s）`)
    if (finish?.kind === 'aborted') throw new ProbeError('ABORTED', '探测已取消')
    if (finish?.kind === 'error' && usage === undefined) {
      throw new ProbeError(
        finish.failure?.code ?? 'LLM_ERROR',
        finish.failure?.message ?? '渠道请求失败',
      )
    }

    return {
      usage,
      finish: finish ?? { kind: 'unknown' },
      maxTokens: prepared.config.maxTokens,
      ttftMs: firstTokenAt === undefined ? undefined : Math.max(0, firstTokenAt - startedAt),
      decodeMs: firstTokenAt === undefined ? undefined : Math.max(0, endedAt - firstTokenAt),
      durationMs: Math.max(0, endedAt - startedAt),
      text,
      textChars: text.length,
    }
  } catch (error) {
    if (timedOut) throw new ProbeError('TIMEOUT', `单次请求超时（${Math.round(timeoutMs / 1_000)}s）`)
    if (signal?.aborted) throw new ProbeError('ABORTED', '探测已取消')
    if (error instanceof ProbeError) throw error
    throw new ProbeError(
      typeof error?.code === 'string' ? error.code : 'PROBE_FAILED',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * Whether one chunk carries the first output token for latency measurement.
 *
 * Mirrors `isTokenDelta` from `@deepseek-ai/dsh-llm`: text, reasoning, and
 * tool-call argument fragments count, while block/usage/finish chunks do not.
 * @param chunk - stream chunk.
 * @returns true for a non-empty token-bearing fragment.
 */
function isTokenChunk(chunk) {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text.length > 0
    case 'tool-call-delta':
      return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0)
        || chunk.name !== undefined
    default:
      return false
  }
}

/**
 * Pick the lowest thinking level the model advertises, skipping `off`.
 *
 * An unspecified request keeps thinking on (the page's default `low`); only an
 * explicit `off` disables it. A model without reasoning metadata keeps the
 * adapter defaults untouched.
 * @param controls - detached call controls.
 * @param model - resolved model metadata.
 * @returns controls with the first non-off effort, when one exists.
 */
function lowestReasoning(controls, model) {
  const efforts = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []
  const effort = efforts.find((entry) => entry?.id !== 'off')?.id ?? efforts[0]?.id
  return typeof effort === 'string' && effort.length > 0
    ? { ...controls, reasoningEffort: effort }
    : controls
}

/**
 * Normalize one thrown attempt failure for the report.
 * @param error - thrown value.
 * @returns stable code and message.
 */
export function normalizeProbeError(error) {
  if (error instanceof ProbeError) return { code: error.code, message: error.message }
  return {
    code: typeof error?.code === 'string' ? error.code : 'PROBE_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Wait without losing cancellation.
 * @param milliseconds - delay.
 * @param signal - caller cancellation.
 * @returns a promise that resolves after the delay.
 */
export function defaultSleep(milliseconds, signal) {
  if (!(milliseconds > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProbeError('ABORTED', '探测已取消'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    const onAbort = () => {
      cleanup()
      reject(new ProbeError('ABORTED', '探测已取消'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Summarize cache-probe attempts for the page cards and the text report.
 * @param attempts - probe attempt records.
 * @returns headline, verdict, and the best/last hit rates.
 */
export function summarizeProbeResult(attempts) {
  const measured = attempts.filter((attempt) => attempt.index > 0 && attempt.summary !== undefined)
  const last = measured.at(-1)
  const best = measured.reduce(
    (candidate, attempt) => candidate === undefined || attempt.summary.hitRate > candidate.summary.hitRate ? attempt : candidate,
    undefined,
  )
  const headline = measured.length === 0
    ? '无可用 usage'
    : best.summary.cacheRead > 0
      ? `复测命中 ${formatRate(last.summary.hitRate)}`
      : '未观测到命中'
  let verdict
  if (measured.length === 0) {
    verdict = '无法统计（没有拿到可用的 usage）'
  } else if (best.summary.cacheRead > 0) {
    verdict = `缓存生效（最近 ${formatRate(last.summary.hitRate)}，最好 ${formatRate(best.summary.hitRate)}）`
  } else {
    verdict = '未观测到缓存命中（可能渠道未启用缓存、上游换 key、等待不足或未上报非零缓存字段）'
  }
  return {
    headline,
    verdict,
    bestHitRate: best?.summary.hitRate ?? null,
    lastHitRate: last?.summary.hitRate ?? null,
    measuredCount: measured.length,
  }
}

/**
 * Render the complete human-facing report.
 * @param input - route, channel name, controls, attempts, payload size, and session channels.
 * @returns a compact multiline report whose first line is a standalone summary.
 */
export function formatProbeReport(input) {
  const {
    route,
    channelName,
    options,
    attempts,
    payloadChars,
    sessionChannels = [],
    reasoning,
  } = input
  const resultSummary = summarizeProbeResult(attempts)
  const lines = [`缓存探测 ${channelName} / ${route.model}：${resultSummary.headline}`]
  lines.push(`思考等级：${reasoning ?? '默认'}`)

  const rows = sessionChannels.slice(0, 5)
  if (rows.length === 0) {
    lines.push('真实流量：暂无已结算请求')
  } else {
    for (const row of rows) {
      lines.push(
        `真实流量 ${row.provider}：命中 ${formatRate(row.hitRate)} · ${row.requests} 次 · 缓存读 ${formatTokens(row.cacheRead)} / 计费输入 ${formatTokens(row.prompt)}（不含本次探测）`,
      )
    }
    if (sessionChannels.length > rows.length) {
      lines.push(`真实流量：另有 ${sessionChannels.length - rows.length} 个渠道未显示`)
    }
  }

  lines.push(`载荷 ${formatTokens(payloadChars)} 字符 · 复测 ${options.rounds} 次 · 间隔 ${options.wait}s`)

  for (const attempt of attempts) {
    const mark = CIRCLED[attempt.index] ?? `${attempt.index + 1}.`
    const label = attempt.index === 0 ? '预热' : `复测${attempt.index}`
    if (attempt.error !== undefined) {
      lines.push(`${mark} ${label} 失败：${describeFailure(attempt.error.code, attempt.error.message)}`)
      continue
    }
    const summary = attempt.summary
    if (summary === undefined) {
      lines.push(`${mark} ${label} 无 usage（结束：${attempt.finish?.kind ?? 'unknown'}）`)
      continue
    }
    const hit = summary.cacheRead > 0 ? `（${formatRate(summary.hitRate)}）` : ''
    const write = summary.cacheWrite > 0 ? ` · 写 ${formatTokens(summary.cacheWrite)}` : ''
    lines.push(
      `${mark} ${label} prompt ${formatTokens(summary.prompt)} · 读 ${formatTokens(summary.cacheRead)}${hit} · 未缓存 ${formatTokens(summary.uncached)}${write} · ${formatDuration(attempt.durationMs)}`,
    )
  }

  lines.push(`结论：${resultSummary.verdict}`)

  return lines.join('\n')
}