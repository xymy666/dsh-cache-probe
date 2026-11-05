import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleClient } from '../scripts/bundle.mjs'

/** Package root. */
const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('client bundle registers one module and parses', async () => {
  const { text, version } = await bundleClient(root)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(version, pkg.version)
  assert.match(text, /window\.__ModuleLoader__\.load\(\{/u)
  assert.match(text, /id: "dsh-cache-probe"/u)
  assert.match(text, /conversation\.composer\.dock/u)
  assert.match(text, /sidebar\.panellist/u)
  assert.match(text, /channel-test/u)
  assert.match(text, /api\/dsh-cache-probe/u)
  assert.match(text, /stroke-linecap/u)
  assert.match(text, /dsh-cache-probe\.page\.result\.v1/u)
  assert.match(text, /label\.lastChecked/u)
  assert.match(text, /pelican/u)
  assert.match(text, /averageCacheAttempts/u)
  assert.doesNotMatch(text, /repeat\(3,\s*minmax\(0,\s*1fr\)\)/u)
  assert.doesNotMatch(text, /\.dsh-ct-pelican-preview\s*\{[^}]*max-height/u)
  assert.doesNotMatch(text, /border-right-color: transparent/u)
  assert.doesNotMatch(text, /\/cache-probe/u)
  assert.doesNotMatch(text, /\/speed-test/u)
  assert.doesNotMatch(text, /^import\s/mu)
  new Function(text)
})

test('advanced-settings selects keep an opaque background in every state', async () => {
  const { text } = await bundleClient(root)
  // The field select must be styled alongside the inputs...
  assert.match(text, /\.dsh-ct-field input,\s*\.dsh-ct-field select \{/u)
  // ...and focus must not swap the background for a transparent one.
  assert.match(text, /\.dsh-ct-field select:focus[^{]*\{[^}]*background-color:/u)
  // Native chrome is replaced so a focused control cannot lose its box.
  assert.match(text, /\.dsh-ct-field select \{[^}]*appearance: none/u)
  assert.doesNotMatch(text, /\.dsh-ct-field select:focus[^{]*\{[^}]*background:\s*transparent/u)
})

test('the factory only requires React and exports apply/inject', async () => {
  const { text } = await bundleClient(root)
  const loaded = []
  new Function('window', text)({ __ModuleLoader__: { load: (entry) => loaded.push(entry) } })
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-cache-probe')
  const exported = loaded[0].factory((specifier) => {
    assert.equal(specifier, 'react')
    return { createElement: () => null }
  })
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots', 'locale', 'layout'])
})