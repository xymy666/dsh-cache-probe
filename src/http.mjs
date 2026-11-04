/**
 * HTTP plumbing for the channel-test page's host routes.
 *
 * The routes can spend real money by calling a model provider, so they carry the
 * same trust fence as the shipped skill-center routes: a loopback socket and
 * loopback Host header, no forwarding hop, browser same-origin markers, or a
 * live paired-device cookie when remote pairing is composed.
 *
 * @module dsh-cache-probe/http
 */

/** Largest JSON body accepted by the run route. */
export const MAX_BODY_BYTES = 64 * 1024

/** HTTP failure carrying a status and a stable code. */
export class HttpError extends Error {
  /**
   * @param status - HTTP status code.
   * @param code - stable machine code.
   * @param message - human-facing diagnostic.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/**
 * Whether a dotted IPv4 string lies inside 127/8.
 * @param value - address text.
 * @returns true for 127.x.x.x.
 */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Whether one socket address names loopback.
 * @param address - `req.socket.remoteAddress`.
 * @returns true for 127/8, ::1, or an IPv4-mapped loopback.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/**
 * Whether a URL hostname names loopback.
 * @param hostname - URL hostname, possibly bracketed IPv6.
 * @returns true for localhost and loopback literals.
 */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
}

/**
 * Whether a reverse proxy stood between the browser and this host.
 * @param request - incoming request.
 * @returns true when a forwarding header is present.
 */
function isProxiedRequest(request) {
  return request.headers['cf-connecting-ip'] !== undefined
    || request.headers['x-forwarded-for'] !== undefined
}

/**
 * Request-level trust fence for direct loopback access.
 * @param request - incoming request.
 * @returns true only for a same-origin loopback request with no forwarding hop.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  if (isProxiedRequest(request)) return false
  const host = request.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Whether this request may enter the plugin's routes.
 * @param ctx - host context; may expose `remoteWebUiPairing`.
 * @param request - incoming request.
 * @returns true for loopback, or a live paired-device cookie.
 */
export function isAllowedRequest(ctx, request) {
  if (isLoopbackRequest(request)) return true
  try {
    return ctx.get?.('remoteWebUiPairing', false)?.isPairedDevice?.(request) === true
  } catch {
    return false
  }
}

/**
 * Enforce method, trust fence, and the optional probe header.
 * @param ctx - host context.
 * @param request - incoming request.
 * @param response - outgoing response.
 * @param method - required HTTP method.
 * @param options - `requireProbeHeader` adds the page's custom header check.
 * @returns true when the handler may continue.
 */
export function guard(ctx, request, response, method, options = {}) {
  if (request.method !== method) {
    writeJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `需要 ${method}` } })
    return false
  }
  if (!isAllowedRequest(ctx, request)) {
    writeJson(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: '只允许本机同源页面访问' } })
    return false
  }
  if (options.requireProbeHeader === true && request.headers['x-dsh-cache-probe'] !== '1') {
    writeJson(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: '缺少 x-dsh-cache-probe 请求头' } })
    return false
  }
  return true
}

/**
 * Read one bounded JSON object body.
 * @param request - incoming request with an async-iterable body.
 * @param limit - maximum bytes.
 * @returns the parsed object.
 * @throws {HttpError} for an oversized, empty, or malformed body.
 */
export async function readJson(request, limit = MAX_BODY_BYTES) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'BODY_TOO_LARGE', `请求体超过 ${limit} 字节`)
  }
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw new HttpError(413, 'BODY_TOO_LARGE', `请求体超过 ${limit} 字节`)
    chunks.push(buffer)
  }
  if (total === 0) throw new HttpError(400, 'EMPTY_BODY', '请求体为空')
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_BODY', '请求体必须是 JSON 对象')
  }
  return parsed
}

/**
 * Write one JSON response.
 * @param response - Node response.
 * @param status - HTTP status.
 * @param body - JSON-safe value.
 */
export function writeJson(response, status, body) {
  const text = JSON.stringify(body)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  }
  if (typeof response.writeHead === 'function') {
    response.writeHead(status, headers)
  } else {
    response.statusCode = status
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
  }
  response.end(text)
}