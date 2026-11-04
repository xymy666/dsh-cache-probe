import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HttpError,
  MAX_BODY_BYTES,
  guard,
  isAllowedRequest,
  isLoopbackRequest,
  readJson,
  writeJson,
} from '../src/http.mjs'

/**
 * Build one fake request.
 * @param options - method, url, headers, body, remote address.
 * @returns an async-iterable request.
 */
function makeRequest({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:56338', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

/**
 * Build one fake response.
 * @returns a response capturing status, headers, and body.
 */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      this.body += chunk ?? ''
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

test('accepts loopback sockets with a loopback Host header', () => {
  assert.equal(isLoopbackRequest(makeRequest()), true)
  assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '::1', headers: { host: 'localhost:56338' } })), true)
  assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '::ffff:127.0.0.1', headers: { host: '[::1]:56338' } })), true)
})

test('rejects LAN, proxy, cross-site, and mismatched-origin requests', () => {
  assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '192.168.1.5' })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { 'x-forwarded-for': '10.0.0.1' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { origin: 'https://evil.example' } })), false)
  assert.equal(isLoopbackRequest(makeRequest({ headers: { origin: 'http://127.0.0.1:56338' } })), true)
})

test('allows a paired device as the second trust path', () => {
  const ctx = {
    get(name) {
      if (name !== 'remoteWebUiPairing') return undefined
      return { isPairedDevice: (request) => request.headers.cookie === 'paired=1' }
    },
  }
  assert.equal(isAllowedRequest(ctx, makeRequest({ remoteAddress: '192.168.1.5', headers: { cookie: 'paired=1' } })), true)
  assert.equal(isAllowedRequest(ctx, makeRequest({ remoteAddress: '192.168.1.5' })), false)
})

test('guard enforces method, trust fence, and the probe header', () => {
  const ctx = { get: () => undefined }
  const wrongMethod = makeResponse()
  assert.equal(guard(ctx, makeRequest({ method: 'POST' }), wrongMethod, 'GET'), false)
  assert.equal(wrongMethod.statusCode, 405)

  const forbidden = makeResponse()
  assert.equal(guard(ctx, makeRequest({ remoteAddress: '10.0.0.2' }), forbidden, 'GET'), false)
  assert.equal(forbidden.statusCode, 403)

  const missingHeader = makeResponse()
  assert.equal(guard(ctx, makeRequest({ method: 'POST' }), missingHeader, 'POST', { requireProbeHeader: true }), false)
  assert.equal(missingHeader.statusCode, 403)

  const allowed = makeResponse()
  assert.equal(guard(ctx, makeRequest({ method: 'POST', headers: { 'x-dsh-cache-probe': '1' } }), allowed, 'POST', { requireProbeHeader: true }), true)
})

test('reads bounded JSON objects', async () => {
  const parsed = await readJson(makeRequest({ body: '{"kind":"cache"}' }))
  assert.deepEqual(parsed, { kind: 'cache' })

  await assert.rejects(() => readJson(makeRequest({ body: '' })), (error) => error instanceof HttpError && error.status === 400)
  await assert.rejects(() => readJson(makeRequest({ body: 'not json' })), (error) => error.status === 400)
  await assert.rejects(() => readJson(makeRequest({ body: '[]' })), (error) => error.status === 400)
  await assert.rejects(() => readJson(makeRequest({ body: 'x'.repeat(MAX_BODY_BYTES + 1) })), (error) => error.status === 413)
})

test('writes JSON with no-store caching', () => {
  const response = makeResponse()
  writeJson(response, 200, { ok: true })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(response.json(), { ok: true })
})