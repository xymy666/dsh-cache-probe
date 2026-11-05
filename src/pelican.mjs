/**
 * Pelican drawing test.
 *
 * One short request asks the model for a single SVG of a pelican riding a
 * bicycle. The reply is a normal text stream, so the SVG is extracted from the
 * text (fenced block first, then an inline `<svg>`), cleaned of active content,
 * and handed to the page for a `dangerouslySetInnerHTML` preview. Nothing here
 * judges whether the drawing looks right.
 *
 * @module dsh-cache-probe/pelican
 */

import { callOnce, normalizeProbeError } from './probe.mjs'
import { formatDuration, formatLatency, formatThroughput, formatTokens, summarizeUsage } from './stats.mjs'

/**
 * SVG event-handler attribute scanner. A plain `/on[a-z]+=/` would also eat
 * `only="..."`, so only known DOM/SMIL handler names count.
 */
const EVENT_ATTRIBUTE = /[\s"']on(?:click|dblclick|load|error|mouseover|mouseout|mousedown|mouseup|mousemove|focus|blur|keydown|keyup|keypress|touchstart|touchend|touchmove|pointerdown|pointerup|pointerover|pointerout|animationstart|animationend|begin|end|repeat|activate|resize|scroll|wheel|input|change|submit)\s*=/iu


/** Shared instruction; the nonce keeps provider prompt caches from hiding TTFT. */
export const PELICAN_PROMPT = [
  'Draw a pelican riding a bicycle.',
  'Return exactly one complete SVG document and nothing else.',
  'Use viewBox="0 0 640 420", a plain background, and simple flat shapes.',
  'The pelican must sit on the bicycle with its wings on the handlebars and its feet on the pedals.',
].join(' ')

/**
 * Build the prompt for one run.
 * @param nonce - unique suffix for this request.
 * @returns the full prompt text.
 */
export function buildPelicanPrompt(nonce) {
  return `${PELICAN_PROMPT}\n\nSketch id: ${nonce}`
}

/**
 * Run one pelican request.
 * @param input - LLM service, route, options, cancellation, and clock.
 * @returns the raw text plus timings and usage.
 * @throws {Error} when the request fails or is aborted.
 */
export async function runPelicanTest(input) {
  const { llm, route, options, reasoning, signal, now = Date.now } = input
  const prompt = buildPelicanPrompt(globalThis.crypto?.randomUUID?.() ?? String(now()))
  const attempt = await callOnce({
    llm,
    route,
    prompt,
    reasoningEffort: reasoning,
    signal,
    timeoutMs: options.timeout * 1_000,
    now,
  })
  const summary = summarizeUsage(attempt.usage)
  return {
    ...attempt,
    summary,
    tps: attempt.decodeMs > 0 && summary !== undefined
      ? summary.output / (attempt.decodeMs / 1_000)
      : undefined,
  }
}

/**
 * Normalize one thrown pelican failure.
 * @param error - thrown value.
 * @returns `{ code, message }`.
 */
export function normalizePelicanError(error) {
  return normalizeProbeError(error)
}

/**
 * Extract the first SVG document from a model reply.
 *
 * Fenced ```svg / ```xml / ```html blocks win over a bare inline `<svg>`.
 * Only extraction and basic hardening happen here; malformed markup is still
 * returned so the page can show whatever the model produced.
 * @param text - raw model text.
 * @returns `{ svg, source, length }`; `svg` is null when nothing was found.
 */
export function extractSvg(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { svg: null, source: 'none', length: 0 }
  }

  const fence = /```(?:svg|xml|html)?[ \t]*\r?\n([\s\S]*?)(?:```|$)/iu.exec(text)
  const fenced = fence?.[1]?.trim()
  if (fenced !== undefined && /<svg[\s>]/iu.test(fenced)) {
    return finalizeSvg(closeSvg(fenced), 'fence')
  }

  const inline = /<svg[\s>][\s\S]*?<\/svg\s*>/iu.exec(text)
  if (inline !== null) return finalizeSvg(inline[0], 'inline')

  // A timed-out or still-streaming reply may stop before </svg>. Keep the
  // opening element to the end of the text and close it for the preview.
  const open = /<svg[\s>][\s\S]*$/iu.exec(text)
  if (open !== null) return finalizeSvg(closeSvg(open[0].trim()), 'inline')

  return { svg: null, source: 'none', length: 0 }
}

/**
 * Close a truncated SVG so it can at least be parsed.
 * @param source - candidate SVG text.
 * @returns text with a closing tag when the opening tag exists without one.
 */
function closeSvg(source) {
  if (/<\/svg\s*>/iu.test(source)) return source
  if (!/<svg[\s>]/iu.test(source)) return source
  return `${source}</svg>`
}

/**
 * Strip active content and external references from an SVG string.
 * @param source - candidate SVG.
 * @param sourceKind - `fence` or `inline`.
 * @returns `{ svg, source, length }`.
 */
function finalizeSvg(source, sourceKind) {
  let svg = source
  svg = svg.replace(/<\?xml[\s\S]*?\?>/giu, '')
  svg = svg.replace(/<!DOCTYPE[\s\S]*?>/giu, '')
  svg = svg.replace(/<script[\s\S]*?<\/script\s*>/giu, '')
  svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/giu, '')
  svg = svg.replace(/<(?:iframe|object|embed)[\s\S]*?<\/(?:iframe|object|embed)\s*>/giu, '')
  svg = svg.replace(/@import[^;]*;?/giu, '')
  svg = svg.replace(/url\(\s*['"]?\s*(?:https?:|\/\/)[^)]*\)/giu, 'none')
  while (EVENT_ATTRIBUTE.test(svg)) {
    svg = svg.replace(/\son[a-z]+\s*=\s*"[^"]*"/iu, '')
    svg = svg.replace(/\son[a-z]+\s*=\s*'[^']*'/iu, '')
    svg = svg.replace(/\son[a-z]+\s*=\s*[^\s>]+/iu, '')
  }
  svg = svg.replace(/\s(?:href|xlink:href)\s*=\s*"(?:\s*(?:https?:|\/\/|javascript:)[^"]*)"/giu, '')
  svg = svg.replace(/\s(?:href|xlink:href)\s*=\s*'(?:\s*(?:https?:|\/\/|javascript:)[^']*)'/giu, '')
  svg = svg.replace(/<svg\b([^>]*)>/iu, (_match, attributes) => `<svg${stripRootSize(attributes)}>`)
  svg = svg.trim()
  return {
    svg: svg.length === 0 ? null : svg,
    source: svg.length === 0 ? 'none' : sourceKind,
    length: svg.length,
  }
}

/**
 * Remove fixed width/height declarations from the root `<svg>` so the preview
 * scales to its container. `viewBox` is kept for aspect ratio.
 * @param attributes - raw attribute text of the opening tag.
 * @returns the rewritten attribute text.
 */
function stripRootSize(attributes) {
  let rewritten = attributes
  rewritten = rewritten.replace(/\s(?:width|height)\s*=\s*"[^"]*"/giu, '')
  rewritten = rewritten.replace(/\s(?:width|height)\s*=\s*'[^']*'/giu, '')
  rewritten = rewritten.replace(/\s(?:width|height)\s*=\s*[^\s>]+/giu, '')
  rewritten = rewritten.replace(/\sstyle\s*=\s*"([^"]*)"/iu, (_match, style) => {
    const kept = style.split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !/^(?:width|height)\s*:/iu.test(part))
      .join('; ')
    return kept.length > 0 ? ` style="${kept}"` : ''
  })
  return rewritten
}

/**
 * Build the card summary and text report for one pelican run.
 * @param input - route, channel name, options, attempt, and extracted SVG.
 * @returns `{ summary, report }`.
 */
export function summarizePelicanResult(input) {
  const { route, channelName, options, attempt, extracted, reasoning } = input
  const failed = attempt?.error !== undefined
  const output = attempt?.summary?.output
  const reasoningTokens = attempt?.summary?.reasoning
  const contentTokens = output !== undefined && reasoningTokens !== undefined
    ? Math.max(0, output - reasoningTokens)
    : undefined
  const truncatedWhileThinking = !failed
    && extracted.svg === null
    && attempt.textChars === 0
    && attempt.finish?.kind === 'max-tokens'
  const noVisibleText = !failed && extracted.svg === null && attempt.textChars === 0

  const headline = failed
    ? '无可用响应'
    : extracted.svg !== null
      ? `已生成 SVG · ${formatLatency(attempt.ttftMs)}`
      : truncatedWhileThinking
        ? '思考未结束（被上限截断）'
        : noVisibleText
          ? '没有输出正文'
          : '未提取到 SVG'

  const verdict = failed
    ? `请求失败：${attempt.error.message}（${attempt.error.code}）`
    : extracted.svg !== null
      ? `首 token ${formatLatency(attempt.ttftMs)}，输出 ${formatThroughput(attempt.tps)}，SVG ${extracted.length} 字符。`
      : truncatedWhileThinking
        ? '模型在思考阶段用完了输出上限，没有产生正文；不是 SVG 提取失败。'
        : noVisibleText
          ? '模型结束了但没有输出正文，无法提取 SVG。'
          : '模型有正文，但没有找到可用的 SVG。'

  const maxLabel = Number.isSafeInteger(attempt?.maxTokens) && attempt.maxTokens > 0
    ? `${formatTokens(attempt.maxTokens)} tok（模型配置上限）`
    : '未设置'
  const lines = [
    `鹈鹕测试 ${channelName} / ${route.model}：${headline}`,
    `轮次：1，思考等级：${reasoning ?? '默认'}，输出上限：${maxLabel}，超时 ${options.timeout}s`,
  ]
  if (failed) {
    lines.push(`① 失败：${attempt.error.message}（${attempt.error.code}）`)
  } else {
    const outputLabel = output === undefined
      ? '— tok'
      : `${formatTokens(output)} tok${reasoningTokens === undefined ? '' : `（推理 ${formatTokens(reasoningTokens)} / 正文 ${formatTokens(contentTokens)}）`}`
    lines.push(`① TTFT ${formatLatency(attempt.ttftMs)} · 输出 ${outputLabel} · ${formatThroughput(attempt.tps)} · 总 ${formatDuration(attempt.durationMs)}`)
    lines.push(`SVG：${extracted.svg === null ? '未提取到' : `${extracted.length} 字符（${extracted.source}）`}`)
    lines.push(`结论：${verdict}`)
  }
  return { summary: { headline, verdict }, report: lines.join('\n') }
}
