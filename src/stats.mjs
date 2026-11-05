/**
 * Token-usage arithmetic for the cache probe.
 *
 * Two independent views share one formula here:
 * - one attempt's provider-reported `usage`, and
 * - the session log's settled `assistant/message` events, grouped per provider.
 *
 * The denominator is the billed prompt, matching the shipped `token-meter`
 * projection: `uncached input + cache read + cache write`. Cache writes count as
 * billed input even when the provider reports them as a separate bucket.
 *
 * @module dsh-cache-probe/stats
 */

/**
 * Whether one value is a non-negative safe integer.
 * @param value - candidate count.
 * @returns true when it can be added to a token total.
 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Normalize one provider usage object.
 * @param usage - the harness usage chunk value, possibly absent.
 * @returns the five buckets plus prompt total and hit rate, or undefined when malformed.
 */
export function summarizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const uncached = usage.inputTokens
  const output = usage.outputTokens
  if (!isCount(uncached) || !isCount(output)) return undefined
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  if (!isCount(cacheRead) || !isCount(cacheWrite)) return undefined
  const prompt = uncached + cacheRead + cacheWrite
  if (!Number.isSafeInteger(prompt)) return undefined
  const reasoning = isCount(usage.reasoningTokens) && usage.reasoningTokens <= output
    ? usage.reasoningTokens
    : undefined
  return {
    uncached,
    cacheRead,
    cacheWrite,
    output,
    prompt,
    hitRate: prompt === 0 ? null : cacheRead / prompt,
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

/**
 * Split one usage summary into thinking tokens and answer tokens.
 *
 * Providers bill `outputTokens` as one number that already includes the
 * thinking phase, so the answer is the remainder. Returns null when the
 * provider reported no reasoning count, because then the split is unknown
 * rather than zero.
 * @param summary - normalized usage buckets.
 * @returns `{ reasoning, content }`, or null when the split is unknown.
 */
export function splitOutputTokens(summary) {
  if (summary === undefined || summary === null) return null
  if (!isCount(summary.reasoning) || !isCount(summary.output)) return null
  return {
    reasoning: summary.reasoning,
    content: Math.max(0, summary.output - summary.reasoning),
  }
}

/**
 * Format one usage summary's output as `thinking/answer`.
 *
 * Falls back to the plain output total when the provider reported no
 * reasoning count, so the column never claims a split it cannot know.
 * @param summary - normalized usage buckets.
 * @returns `1,024/256`, a plain total, or `—`.
 */
export function formatOutputSplit(summary) {
  if (summary === undefined || summary === null) return '—'
  if (!isCount(summary.output)) return '—'
  const split = splitOutputTokens(summary)
  if (split === null) return formatTokens(summary.output)
  return `${formatTokens(split.reasoning)}/${formatTokens(split.content)}`
}

/**
 * Aggregate settled assistant messages from a session log by provider.
 *
 * Only `assistant/message` carries both a resolved route (`message.source`) and
 * a provider usage sample, so failed attempts without a settled message are not
 * counted. That is the honest scope for a "real traffic" comparison: the report
 * labels the rows as settled requests.
 * @param events - `session.snapshotEvents()` result, or any array of session events.
 * @returns one row per provider, sorted by billed prompt tokens descending.
 */
export function aggregateSessionChannels(events) {
  if (!Array.isArray(events)) return []
  const rows = new Map()
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    const summary = summarizeUsage(event.data?.usage)
    if (summary === undefined) continue
    const source = event.data?.message?.source
    if (source === null || typeof source !== 'object') continue
    const provider = typeof source.provider === 'string' ? source.provider : ''
    if (provider.length === 0) continue
    const model = typeof source.model === 'string' ? source.model : ''
    let row = rows.get(provider)
    if (row === undefined) {
      row = {
        provider,
        models: new Set(),
        requests: 0,
        uncached: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        prompt: 0,
      }
      rows.set(provider, row)
    }
    if (model.length > 0) row.models.add(model)
    row.requests += 1
    row.uncached += summary.uncached
    row.cacheRead += summary.cacheRead
    row.cacheWrite += summary.cacheWrite
    row.output += summary.output
    row.prompt += summary.prompt
  }
  return [...rows.values()]
    .map((row) => ({
      provider: row.provider,
      models: [...row.models],
      requests: row.requests,
      uncached: row.uncached,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      output: row.output,
      prompt: row.prompt,
      hitRate: row.prompt === 0 ? null : row.cacheRead / row.prompt,
    }))
    .sort((left, right) => right.prompt - left.prompt || left.provider.localeCompare(right.provider))
}

/**
 * Format one integer token count with thousands separators.
 * @param value - count.
 * @returns the display string.
 */
export function formatTokens(value) {
  const rounded = Math.round(value)
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

/**
 * Format one 0..1 rate as a one-decimal percentage.
 * @param rate - rate, or null when the denominator was zero.
 * @returns the display string.
 */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * Format one elapsed duration for the per-attempt line.
 * @param milliseconds - elapsed time.
 * @returns the display string.
 */
export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  return `${(milliseconds / 1_000).toFixed(1)}s`
}

/**
 * Format one latency with millisecond precision below a second.
 * @param milliseconds - elapsed time.
 * @returns `402ms`, `1.24s`, or `—`.
 */
export function formatLatency(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  return `${(milliseconds / 1_000).toFixed(2)}s`
}

/**
 * Format one generation rate.
 * @param tokensPerSecond - output tokens divided by decode seconds.
 * @returns `85.3 tok/s`, or `—` when unavailable.
 */
export function formatThroughput(tokensPerSecond) {
  if (typeof tokensPerSecond !== 'number' || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return '—'
  return `${tokensPerSecond.toFixed(1)} tok/s`
}

/**
 * Arithmetic median of the finite values in one list.
 * @param values - sample values; non-finite entries are ignored.
 * @returns the median, or null when no usable value exists.
 */
export function median(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Smallest and largest finite values in one list.
 * @param values - sample values.
 * @returns `{ min, max }`, or null when no usable value exists.
 */
export function range(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (usable.length === 0) return null
  return {
    min: Math.min(...usable),
    max: Math.max(...usable),
  }
}

/**
 * Average of the finite numbers in one list.
 * @param values - sample values.
 * @returns the arithmetic mean, or null when no usable value exists.
 */
function average(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (usable.length === 0) return null
  return usable.reduce((sum, value) => sum + value, 0) / usable.length
}

/**
 * Average the successful cache attempts.
 *
 * Token buckets and duration are arithmetic means. The hit rate is weighted:
 * total cache reads divided by total billed prompt, so a short round cannot
 * dominate the percentage. Warm-up is excluded by default because it is
 * expected to be a cold write.
 * @param attempts - cache attempt records.
 * @param options - `includeWarmup` to include index 0.
 * @returns the average row, or null when no successful retest exists.
 */
export function averageCacheAttempts(attempts, options = {}) {
  const rows = Array.isArray(attempts)
    ? attempts.filter((attempt) => attempt !== null
      && typeof attempt === 'object'
      && attempt.error === undefined
      && attempt.summary !== undefined
      && (options.includeWarmup === true || attempt.index > 0))
    : []
  if (rows.length === 0) return null
  const sum = { prompt: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 }
  for (const row of rows) {
    sum.prompt += row.summary.prompt
    sum.uncached += row.summary.uncached
    sum.cacheRead += row.summary.cacheRead
    sum.cacheWrite += row.summary.cacheWrite
  }
  const count = rows.length
  return {
    count,
    prompt: sum.prompt / count,
    uncached: sum.uncached / count,
    cacheRead: sum.cacheRead / count,
    cacheWrite: sum.cacheWrite / count,
    hitRate: sum.prompt === 0 ? null : sum.cacheRead / sum.prompt,
    durationMs: average(rows.map((row) => row.durationMs)),
  }
}

/**
 * Average the successful speed attempts.
 * @param attempts - speed attempt records.
 * @returns the average row, or null when no successful round exists.
 */
export function averageSpeedAttempts(attempts) {
  const rows = Array.isArray(attempts)
    ? attempts.filter((attempt) => attempt !== null
      && typeof attempt === 'object'
      && attempt.error === undefined)
    : []
  if (rows.length === 0) return null
  const splits = rows.map((row) => splitOutputTokens(row.summary)).filter((split) => split !== null)
  return {
    count: rows.length,
    output: average(rows.map((row) => row.summary?.output)),
    reasoning: splits.length === 0 ? null : average(splits.map((split) => split.reasoning)),
    content: splits.length === 0 ? null : average(splits.map((split) => split.content)),
    ttftMs: average(rows.map((row) => row.ttftMs)),
    tps: average(rows.map((row) => row.tps)),
    durationMs: average(rows.map((row) => row.durationMs)),
  }
}