/**
 * Host half of dsh-cache-probe.
 *
 * Serves the channel-test page's two exact HTTP routes. The page selects any
 * active provider/model, then posts one cache or speed run; the routes call
 * `ctx.llm` directly and return structured attempts plus a text report. No
 * slash command, command lifecycle event, or model-visible message is created.
 *
 * @module dsh-cache-probe
 */

import { createRoutes } from '../src/routes.mjs'

/** Stable Cordis plugin name; must match the package name. */
export const name = 'dsh-cache-probe'

/**
 * Web transport and model calls. Live sessions are read through `ctx.get`
 * when present, so a profile without the session service still loads the page.
 */
export const inject = ['webServer', 'llm']

/**
 * Mount the route family.
 * @param ctx - Host profile context carrying `webServer` and `llm`.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = createRoutes(ctx).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-cache-probe: host routes')

  ctx.logger?.info?.('cache-probe: /api/dsh-cache-probe routes mounted')
}