/**
 * Shared execution controls for the channel-test page's host routes.
 *
 * The page posts structured JSON, so there is no command-line grammar any more.
 * These helpers still validate every number at the trust boundary: defaults are
 * filled in, unknown keys are ignored, and out-of-range values become a 400
 * instead of a provider call.
 *
 * @module dsh-cache-probe/options
 */

/** Cache-test defaults. */
export const CACHE_DEFAULTS = Object.freeze({
  size: 12_000,
  rounds: 2,
  wait: 10,
  timeout: 120,
})

/** Cache-test inclusive ranges. `rounds` has no upper bound. */
export const CACHE_LIMITS = Object.freeze({
  size: [2_000, 200_000],
  rounds: [1, Number.POSITIVE_INFINITY],
  wait: [0, 120],
  timeout: [10, 300],
})

/** Speed-test defaults. */
export const SPEED_DEFAULTS = Object.freeze({
  tokens: 256,
  rounds: 3,
  gap: 1,
  timeout: 120,
})

/** Speed-test inclusive ranges. `rounds` has no upper bound. */
export const SPEED_LIMITS = Object.freeze({
  tokens: [32, 2_048],
  rounds: [1, Number.POSITIVE_INFINITY],
  gap: [0, 30],
  timeout: [10, 300],
})

/** Default reasoning effort for every probe request. */
export const REASONING_DEFAULT = 'low'

/**
 * Extra output budget granted to the speed test when thinking is enabled.
 *
 * DSH reports `outputTokens` as one number that already includes the thinking
 * phase, so a cap sized for the answer alone is consumed entirely by thinking
 * and the round ends with no visible text. Measured on a6: `low` produced zero
 * answer characters at 256/512/1024 and only finished at 2048.
 */
export const REASONING_HEADROOM_TOKENS = 2_048

/**
 * Resolve the output cap one speed round actually needs.
 *
 * Thinking-off requests keep the requested budget exactly, so a `off` run is
 * still measured against the size the user asked for.
 * @param target - the configured answer budget in tokens.
 * @param effort - the selected reasoning effort, or null/undefined when none.
 * @returns the cap to send, in tokens.
 */
export function effectiveMaxTokens(target, effort) {
  const base = Number.isSafeInteger(target) && target > 0 ? target : SPEED_DEFAULTS.tokens
  if (typeof effort !== 'string' || effort.length === 0 || effort === 'off') return base
  return base + REASONING_HEADROOM_TOKENS
}

/** The three tests, each with its own reasoning selection. */
export const REASONING_KINDS = Object.freeze(['cache', 'speed', 'pelican'])

/** Pelican-test defaults. It has no output cap: the model ends on its own. */
export const PELICAN_DEFAULTS = Object.freeze({
  timeout: 120,
})

/** Pelican-test inclusive ranges. */
export const PELICAN_LIMITS = Object.freeze({
  timeout: [10, 300],
})

/** Rejected option payload. */
export class OptionError extends Error {
  /**
   * @param message - human-facing diagnostic.
   */
  constructor(message) {
    super(message)
    this.name = 'OptionError'
    this.code = 'INVALID_OPTION'
  }
}

/**
 * Normalize one cache-test option object.
 * @param input - untrusted object from the page, or undefined.
 * @returns a complete frozen option object.
 * @throws {OptionError} for a non-integer or out-of-range value.
 */
export function normalizeCacheOptions(input) {
  return normalize(input, CACHE_DEFAULTS, CACHE_LIMITS, 'cache')
}

/**
 * Normalize one speed-test option object.
 * @param input - untrusted object from the page, or undefined.
 * @returns a complete frozen option object.
 * @throws {OptionError} for a non-integer or out-of-range value.
 */
export function normalizeSpeedOptions(input) {
  return normalize(input, SPEED_DEFAULTS, SPEED_LIMITS, 'speed')
}

/**
 * Normalize one pelican-test option object.
 * @param input - untrusted object from the page, or undefined.
 * @returns a complete frozen option object.
 * @throws {OptionError} for a non-integer or out-of-range value.
 */
export function normalizePelicanOptions(input) {
  return normalize(input, PELICAN_DEFAULTS, PELICAN_LIMITS, 'pelican')
}

/**
 * Normalize one reasoning-effort value.
 *
 * The value is a model-declared effort id (`off`, `low`, `high`, `max`, ...).
 * `null` means the model offers no reasoning at all, and `undefined` means "no
 * explicit override" — the LLM layer then picks its own lowest advertised
 * effort. Whether the selected model actually offers an explicit id is checked
 * before any provider I/O, so this boundary only rejects non-strings.
 * @param input - untrusted value from the page.
 * @returns a trimmed effort id, null, or undefined.
 * @throws {OptionError} for a non-string, non-null non-empty value.
 */
export function normalizeReasoning(input) {
  if (input === undefined || input === null || input === '') return undefined
  if (typeof input !== 'string') throw new OptionError('reasoning 必须是字符串')
  if (input.trim().length === 0) throw new OptionError('reasoning 不能为空')
  return input.trim()
}

/**
 * Normalize the per-test reasoning selection.
 *
 * Accepts the current `{ cache, speed, pelican }` object or the 0.5.0 single
 * string form, and always answers with all three keys so a caller can read any
 * of them without checking. Missing or unusable entries fall back to the
 * default effort.
 * @param input - untrusted value from the page.
 * @returns a frozen `{ cache, speed, pelican }` object.
 * @throws {OptionError} for a malformed value.
 */
export function normalizeReasoningSelection(input) {
  let source = input
  if (typeof source === 'string') {
    const shared = normalizeReasoning(source)
    source = shared === undefined ? {} : { cache: shared, speed: shared, pelican: shared }
  }
  if (source !== undefined && source !== null && (typeof source !== 'object' || Array.isArray(source))) {
    throw new OptionError('reasoning 必须是对象或字符串')
  }
  const values = source ?? {}
  const output = {}
  for (const kind of REASONING_KINDS) {
    output[kind] = normalizeReasoning(values[kind]) ?? REASONING_DEFAULT
  }
  return Object.freeze(output)
}

/**
 * Normalize any supported option family.
 * @param input - untrusted value.
 * @param defaults - complete defaults.
 * @param limits - per-key inclusive ranges.
 * @param label - family name used in diagnostics.
 * @returns a complete frozen option object.
 */
function normalize(input, defaults, limits, label) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new OptionError(`${label} 选项必须是对象`)
  }
  const source = input ?? {}
  const output = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = source[key]
    if (value === undefined) {
      output[key] = fallback
      continue
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new OptionError(`${label}.${key} 必须是安全整数`)
    }
    const [minimum, maximum] = limits[key]
    if (value < minimum || (Number.isFinite(maximum) && value > maximum)) {
      throw new OptionError(Number.isFinite(maximum)
        ? `${label}.${key} 必须在 ${minimum}–${maximum} 之间`
        : `${label}.${key} 必须不小于 ${minimum}`)
    }
    output[key] = value
  }
  return Object.freeze(output)
}

/**
 * Clamp one numeric UI value to a range, falling back when unusable.
 * @param value - candidate number.
 * @param limits - inclusive `[min, max]`.
 * @param fallback - value used when the candidate is not finite.
 * @returns an integer inside the range.
 */
export function clampOption(value, limits, fallback) {
  const [minimum, maximum] = limits
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  const lower = Math.max(minimum, rounded)
  return Number.isFinite(maximum) ? Math.min(maximum, lower) : Math.min(Number.MAX_SAFE_INTEGER, lower)
}