/**
 * Active channel speed test.
 *
 * Three short, independent requests (each with its own nonce) measure the
 * channel's first-token latency and generation throughput. The prompt is
 * deliberately short so TTFT reflects network + queue + a small prefill rather
 * than the long-context work the cache test already covers.
 *
 * Timing follows the shipped session statistics:
 * - TTFT: stream start -> first token-bearing chunk;
 * - decode: first token -> finish;
 * - throughput: usage.outputTokens / decode seconds.
 *
 * @module dsh-cache-probe/speed
 */

import { randomUUID } from 'node:crypto'

import { describeFailure } from './errors.mjs'
import {
  ProbeError,
  callOnce,
  defaultSleep,
  normalizeProbeError,
} from './probe.mjs'
import {
  formatDuration,
  formatLatency,
  formatOutputSplit,
  formatThroughput,
  formatTokens,
  median,
  range,
  splitOutputTokens,
  summarizeUsage,
} from './stats.mjs'

/** Short deterministic task that keeps generating until the output cap stops it. */
export const SPEED_PROMPT = [
  'Count upward from 1, one integer per line.',
  'Do not explain, summarize, or stop early; keep counting until you are forced to stop.',
].join(' ')

/** Circled markers for up to five rounds. */
const CIRCLED = ['①', '②', '③', '④', '⑤']

/**
 * Build one round's prompt.
 *
 * The nonce makes every round a distinct request prefix, so a provider-side
 * prompt cache cannot lower TTFT and flatter the channel.
 * @param nonce - per-round unique marker.
 * @returns the complete user message text.
 */
export function buildSpeedPrompt(nonce) {
  return `Run ${nonce}\n${SPEED_PROMPT}`
}

/**
 * Compute output throughput for one measured attempt.
 * @param summary - normalized usage buckets, or undefined when usage was absent.
 * @param decodeMs - first-token-to-finish duration.
 * @returns tokens per second, or null when either side is unusable.
 */
export function tokensPerSecond(summary, decodeMs) {
  if (summary === undefined || summary.output <= 0) return null
  if (!(decodeMs > 0)) return null
  return summary.output / (decodeMs / 1_000)
}

/**
 * Run the configured number of speed rounds.
 * @param input - LLM service, route, controls, cancellation, and test seams.
 * @returns attempt records in round order.
 * @throws {ProbeError} when the caller aborts before the first round.
 */
export async function runSpeedTest(input) {
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
  const attempts = []

  for (let index = 0; index < options.rounds; index += 1) {
    if (signal?.aborted) throw new ProbeError('ABORTED', '测速已取消')
    if (index > 0 && options.gap > 0) {
      await sleep(options.gap * 1_000, signal)
      if (signal?.aborted) throw new ProbeError('ABORTED', '测速已取消')
    }
    onAttemptStart?.(index)
    try {
      const prompt = buildSpeedPrompt(randomUUID())
      const attempt = await callOnce({
        llm,
        route,
        prompt,
        maxTokens: options.tokens,
        reasoningEffort: reasoning,
        signal,
        timeoutMs: options.timeout * 1_000,
        now,
      })
      const summary = summarizeUsage(attempt.usage)
      const record = {
        index,
        ...attempt,
        summary,
        tps: tokensPerSecond(summary, attempt.decodeMs),
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

  return { attempts }
}

/**
 * Render one complete speed report.
 * @param input - route, channel name, controls, and attempt records.
 * @returns a compact multiline report whose first line is the summary.
 */
export function summarizeSpeedResult(attempts) {
  const timed = attempts.filter((attempt) => attempt.error === undefined && attempt.ttftMs !== undefined)
  const rated = attempts.filter((attempt) => attempt.error === undefined && typeof attempt.tps === 'number' && attempt.tps > 0)
  const medianTtft = median(timed.map((attempt) => attempt.ttftMs))
  const medianTps = median(rated.map((attempt) => attempt.tps))
  const headlineParts = []
  if (medianTtft !== null) headlineParts.push(`TTFT ${formatLatency(medianTtft)}`)
  if (medianTps !== null) headlineParts.push(formatThroughput(medianTps))
  const headline = headlineParts.length > 0 ? headlineParts.join(' · ') : '无可用响应'

  let verdict
  if (medianTtft === null) {
    verdict = '无法测速（没有拿到可用的响应）'
  } else if (medianTps === null) {
    verdict = `首 token ${formatLatency(medianTtft)}，输出速度无法计算（无 usage）`
  } else {
    verdict = `首 token ${formatLatency(medianTtft)}，生成 ${formatThroughput(medianTps)}`
  }

  return {
    headline,
    verdict,
    medianTtft,
    medianTps,
    ttftRange: range(timed.map((attempt) => attempt.ttftMs)),
    tpsRange: range(rated.map((attempt) => attempt.tps)),
  }
}

/**
 * Render one complete speed report.
 * @param input - route, channel name, controls, and attempt records.
 * @returns a compact multiline report whose first line is the summary.
 */
export function formatSpeedReport(input) {
  const { route, channelName, options, attempts, reasoning } = input
  const summary = summarizeSpeedResult(attempts)
  const { medianTtft, medianTps, ttftRange, tpsRange } = summary

  const lines = [`测速 ${channelName} / ${route.model}：${summary.headline}`]
  lines.push(`思考等级：${reasoning ?? '默认'}`)
  const firstUsage = attempts.find((attempt) => attempt.summary !== undefined)?.summary
  lines.push(
    `prompt ${firstUsage === undefined ? '—' : formatTokens(firstUsage.prompt)} tok · 目标 ${options.tokens} tok · ${options.rounds} 轮`,
  )

  for (const attempt of attempts) {
    const mark = CIRCLED[attempt.index] ?? `${attempt.index + 1}.`
    if (attempt.error !== undefined) {
      lines.push(`${mark} 失败：${describeFailure(attempt.error.code, attempt.error.message)}`)
      continue
    }
    if (attempt.ttftMs === undefined) {
      lines.push(`${mark} 无 token（结束：${attempt.finish?.kind ?? 'unknown'}）`)
      continue
    }
    const split = attempt.summary === undefined ? null : splitOutputTokens(attempt.summary)
    const pieces = [
      attempt.summary === undefined
        ? '— tok'
        : `${formatOutputSplit(attempt.summary)} tok${split === null ? '' : '（思考/正文）'}`,
      `TTFT ${formatLatency(attempt.ttftMs)}`,
      formatThroughput(attempt.tps),
      `总 ${formatDuration(attempt.durationMs)}`,
    ]
    if (attempt.summary !== undefined && attempt.summary.output > 0 && attempt.textChars === 0) {
      pieces.push('无可见文本')
    }
    if (attempt.finish?.kind === 'error') {
      pieces.push(`结束 ${attempt.finish.failure?.code ?? 'error'}`)
    }
    lines.push(`${mark} ${pieces.join(' · ')}`)
  }

  if (attempts.length > 1) {
    const totalRange = range(attempts.filter((attempt) => attempt.error === undefined).map((attempt) => attempt.durationMs))
    const parts = []
    if (ttftRange !== null) {
      parts.push(ttftRange.min === ttftRange.max
        ? `TTFT ${formatLatency(ttftRange.min)}`
        : `TTFT ${formatLatency(ttftRange.min)}–${formatLatency(ttftRange.max)}（中位 ${formatLatency(medianTtft)}）`)
    }
    if (tpsRange !== null) {
      parts.push(tpsRange.min === tpsRange.max
        ? `速度 ${formatThroughput(tpsRange.min)}`
        : `速度 ${tpsRange.min.toFixed(1)}–${tpsRange.max.toFixed(1)} tok/s（中位 ${formatThroughput(medianTps)}）`)
    }
    if (totalRange !== null) {
      parts.push(totalRange.min === totalRange.max
        ? `总 ${formatDuration(totalRange.min)}`
        : `总 ${formatDuration(totalRange.min)}–${formatDuration(totalRange.max)}`)
    }
    const failed = attempts.filter((attempt) => attempt.error !== undefined).length
    if (failed > 0) parts.push(`${failed} 轮失败`)
    if (parts.length > 0) lines.push(`汇总：${parts.join(' · ')}`)
  }

  lines.push(`结论：${summary.verdict}`)

  return lines.join('\n')
}