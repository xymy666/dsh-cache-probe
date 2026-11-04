#!/usr/bin/env node
/**
 * Build `lib/client.js` — the browser half in the Web client's module format.
 *
 * The bundle is compiled with `new Function` before it is written, so a syntax
 * mistake fails the build instead of failing silently in the browser.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleClient } from './bundle.mjs'

/** Package root (this script lives in `<root>/scripts`). */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
/** Build artifact path. */
const outfile = join(root, 'lib', 'client.js')

const { text, version } = await bundleClient(root)

// Compile-only check: `new Function` parses the body without running it.
new Function(text)

await mkdir(dirname(outfile), { recursive: true })
await writeFile(outfile, text, 'utf8')
console.log(`built ${outfile} (v${version}, ${Buffer.byteLength(text)} bytes)`)