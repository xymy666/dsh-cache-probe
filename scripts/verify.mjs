#!/usr/bin/env node
/**
 * Pre-install verification of this package against the rules the Web client's
 * module loader actually enforces (`@deepseek-ai/dsh-client-modules`):
 *
 * 1. the manifest parses and declares `dsh.bundle.patch`;
 * 2. `dsh.client.platform` is `web`, `dsh.client.immediately` is true, and
 *    `dsh.client.inject` is a string array that names the chat UI module;
 * 3. the `./client` export resolves to an existing file;
 * 4. the patch layer is a top-level array whose `insert` row names this package;
 * 5. the built bundle really registers one `window.__ModuleLoader__.load` entry,
 *    under the package name, whose factory returns `apply` and `inject` and
 *    requires only React.
 *
 * It also reports whether the target profile already has the plugin installed.
 * Run with `npm run verify` (which builds first).
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleClient } from './bundle.mjs'

/** Package root (this script lives in `<root>/scripts`). */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
/** Profile whose manifest is reported on; `DSH_PROFILE` first, then `desktop`. */
const profileName = process.argv[2] ?? process.env.DSH_PROFILE ?? 'desktop'
/** Harness home. */
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** That profile's directory. */
const profileDir = join(dshHome, 'profiles', profileName)

const failures = []
const notes = []

/**
 * Record one failed requirement.
 * @param message - what is wrong.
 */
function fail(message) {
  failures.push(message)
}

/**
 * Record one passing requirement or observation.
 * @param message - what was checked.
 */
function note(message) {
  notes.push(message)
}

/**
 * Whether a package-relative path exists as a file.
 * @param relative - path relative to the package root.
 * @returns true when it is a readable file.
 */
async function exists(relative) {
  try {
    const info = await stat(join(root, relative))
    return info.isFile()
  } catch {
    return false
  }
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const name = manifest.name
note(`package name: ${name}@${manifest.version}`)

if (await exists(manifest.main ?? '')) note(`host entry: ${manifest.main}`)
else fail(`host entry ${manifest.main} is missing`)

const patchPath = manifest.dsh?.bundle?.patch
if (typeof patchPath !== 'string' || !(await exists(patchPath))) {
  fail('dsh.bundle.patch is missing; the plugin manager refuses a package with no bundle patch')
} else {
  const patch = await readFile(join(root, patchPath), 'utf8')
  const hasInsert = /^-[ \t]*insert:[ \t]*$/mu.test(patch)
  const namesPackage = new RegExp(`^[ \\t]*name:[ \\t]*["']?${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["']?[ \\t]*$`, 'mu')
  if (hasInsert && namesPackage.test(patch)) note(`bundle patch: ${patchPath} inserts one row for ${name}`)
  else fail(`${patchPath} must be a top-level array whose insert row names ${name}`)
}

const client = manifest.dsh?.client
if (client === undefined || client === null || typeof client !== 'object') {
  fail('dsh.client is absent; the Web client will not load a browser half')
} else {
  if (client.platform === 'web') note('dsh.client.platform: web')
  else fail(`dsh.client.platform must be "web" (got ${JSON.stringify(client.platform)})`)
  if (client.immediately === true) note('dsh.client.immediately: true')
  else fail('dsh.client.immediately must be true, or the plugin never activates on its own')
  if (Array.isArray(client.inject) && client.inject.every((item) => typeof item === 'string')) {
    note(`dsh.client.inject: ${client.inject.length} package(s)`)
    for (const required of [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-chat',
    ]) {
      if (!client.inject.includes(required)) fail(`dsh.client.inject must include ${required}`)
    }
  } else {
    fail('dsh.client.inject must be a string array')
  }
  const clientExport = manifest.exports?.['./client']
  const clientFile = typeof clientExport === 'string' ? clientExport : clientExport?.default
  if (typeof clientFile !== 'string') fail('exports["./client"] must be a string or an object with a string default')
  else if (await exists(clientFile)) note(`client half: ${clientFile}`)
  else fail(`exports["./client"] points at a missing file: ${clientFile}`)
}

const bundleSource = await readFile(join(root, 'lib', 'client.js'), 'utf8')
const { text: expectedBundle, version } = await bundleClient(root)
if (expectedBundle === bundleSource) note(`lib/client.js is current with src/ (v${version})`)
else fail('lib/client.js is stale against src/ — run `npm run build`')

for (const marker of ['channel-test', 'sidebar.panellist', 'conversation.composer.dock', 'api/dsh-cache-probe']) {
  if (bundleSource.includes(marker)) note(`client bundle contains ${marker}`)
  else fail(`client bundle is missing ${marker}`)
}
for (const oldCommand of ['/cache-probe', '/speed-test']) {
  if (bundleSource.includes(oldCommand)) fail(`client bundle still contains the removed command ${oldCommand}`)
}

const loaded = []
try {
  new Function('window', bundleSource)({ __ModuleLoader__: { load: (entry) => loaded.push(entry) } })
} catch (error) {
  fail(`lib/client.js does not parse: ${error.message}`)
}
if (loaded.length === 1 && loaded[0].id === name) {
  let exports
  try {
    exports = loaded[0].factory((specifier) => {
      if (specifier === 'react') return { createElement: () => null }
      throw new Error(`unexpected module require: ${specifier}`)
    })
  } catch (error) {
    fail(`bundle factory failed without the app shell: ${error.message}`)
  }
  if (exports !== undefined && typeof exports.apply === 'function' && Array.isArray(exports.inject)) {
    note(`lib/client.js registers ${name} with apply() and inject ${JSON.stringify(exports.inject)}`)
  } else if (exports !== undefined) {
    fail('the bundle factory must return { apply, inject }')
  }
} else {
  fail(`lib/client.js must register exactly one module under id "${name}"`)
}

// Report-only: has the target profile installed this package yet?
let installed = `not installed (no ${profileName} profile manifest found)`
try {
  const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  const bundles = profile.dsh?.profile?.bundles ?? []
  const dependencies = profile.dependencies ?? {}
  const parts = []
  if (bundles.includes(name)) parts.push('listed in dsh.profile.bundles')
  if (Object.hasOwn(dependencies, name)) parts.push(`dependency ${dependencies[name]}`)
  installed = parts.length > 0 ? `installed — ${parts.join(', ')}` : 'not installed'
} catch {
  // The profile may not exist on this machine; that is not a package defect.
}

console.log(notes.map((line) => `  ok   ${line}`).join('\n'))
if (failures.length > 0) {
  console.error(failures.map((line) => `  FAIL ${line}`).join('\n'))
  console.error(`\n${failures.length} requirement(s) failed.`)
  process.exit(1)
}
console.log(`  info ${profileName} profile: ${installed}`)
console.log(`  info install path: ${root}`)
console.log(`\nall ${notes.length} requirements passed.`)