/**
 * dsh-pet-one host half — mounts the pet service, its same-origin JSON API
 * and the optional `pet_say` model tool. The browser half lives in
 * `./lib/client.js` and talks to `/api/pet-one/*`; nothing else is required.
 *
 * Install (web profile): `dsh plugin --profile web add link:<abs path>`,
 * then restart `dsh web`.
 * @module dsh-pet-one
 */

import { PetOneService } from './lib/host/service.js'
import { makeRoutes } from './lib/host/routes.js'

export { PetOneService } from './lib/host/service.js'
export { Store, defaultState, dayKey } from './lib/host/store.js'
export { ActivityTracker, projectEvent, emptyRuntime, PHASE_WEIGHT } from './lib/host/activity.js'
export { interact, rewardTurn, rankOf, economyView, RANKS } from './lib/host/economy.js'
export { createSkinRegistry, BUILTIN_SKINS } from './lib/host/skins.js'

/** Cordis plugin name. */
export const name = 'pet-one'

/** The web server service is the only hard requirement. */
export const inject = ['webServer']

/**
 * Mount the pet.
 * @param {object} ctx - cordis context.
 * @param {object} [config] - optional plugin config from the patch layer.
 */
export function apply(ctx, config = {}) {
  const service = new PetOneService({ ctx, config })

  ctx.effect(() => {
    const routeDisposers = makeRoutes(service).map((route) => ctx.webServer.register(route))
    const detach = service.attach(ctx)
    return () => {
      try { detach() } catch { /* ignore */ }
      for (const dispose of routeDisposers) {
        try { dispose() } catch { /* ignore */ }
      }
      service.close()
    }
  }, 'pet-one: api')
}
