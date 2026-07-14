export * from './types'
export * from './catalog'
export { resolveEngine } from './assembly'
export { simulateOperatingPoint, manifoldConditions, interpolateCurve } from './cycle'
export { runDyno } from './dyno'

import { partById } from './catalog'
import type { EngineAssembly, Tune } from './types'

/** Ensamblajes de ejemplo para demos y tests. */
export function stockEngine(): EngineAssembly {
  return {
    block: partById('block-alu-2.0'),
    crank: partById('crank-cast-86'),
    rod: partById('rod-stock-139'),
    piston: partById('piston-cast-86'),
    head: partById('head-sport-42'),
    injector: partById('inj-310'),
    aspiration: partById('asp-na')
  }
}

export function defaultTune(): Tune {
  return { lambda: 0.88, revLimit: 8200, boostTarget: 0, sparkTrim: 0 }
}
