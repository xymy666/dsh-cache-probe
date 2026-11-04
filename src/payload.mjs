/**
 * Synthetic prompt used by an active cache probe.
 *
 * Cache behavior is a property of an exact request prefix, so the probe has to
 * send the *same* long prefix twice. A fresh nonce at the very start keeps each
 * run cold: without it, a second page run could inherit the previous run's
 * server-side cache and report a hit that says nothing about the channel.
 *
 * The payload is deliberately plain ASCII English: CJK or random Unicode would
 * make the tokenizer estimate less predictable, and the probe reports the
 * provider's own token counts anyway.
 *
 * @module dsh-cache-probe/payload
 */

import { randomUUID } from 'node:crypto'

/** One repeatable sentence; line numbers and a short hash make the body non-trivial. */
const SENTENCE = 'The quick brown fox jumps over the lazy dog while the cache probe records a stable request prefix.'

/** How many digits the body line counter keeps. */
const LINE_PAD = 5

/**
 * Create a fresh cold-start marker.
 * @returns a UUID used only inside the synthetic payload.
 */
export function buildProbeNonce() {
  return randomUUID()
}

/**
 * Build the complete probe prompt.
 *
 * `size` is a character budget, not a token budget: the report always uses the
 * provider's reported prompt tokens, and the command help explains the roughly
 * four-characters-per-token assumption.
 * @param size - target minimum character count.
 * @param nonce - stable marker placed before every repeated line.
 * @returns one immutable-by-convention string reused for every request in a run.
 */
export function buildProbePayload(size, nonce = buildProbeNonce()) {
  const header = [
    `Cache probe ${nonce}`,
    'This synthetic payload exists only to exercise prompt caching.',
    'Do not summarize or transform it; the only useful output is the single word OK.',
    '',
  ].join('\n')
  const footer = '\nEnd of payload. Reply with exactly: OK\n'
  const lines = []
  let total = header.length + footer.length
  for (let index = 0; total < size; index += 1) {
    const hash = ((index * 2_654_435_761) >>> 0).toString(16).padStart(8, '0')
    const line = `${String(index + 1).padStart(LINE_PAD, '0')} ${hash} ${SENTENCE}\n`
    lines.push(line)
    total += line.length
  }
  return `${header}${lines.join('')}${footer}`
}