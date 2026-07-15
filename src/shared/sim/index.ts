export * from './types'
export * from './catalog'
export { resolveEngine } from './assembly'
export { simulateOperatingPoint, manifoldConditions, interpolateCurve } from './cycle'
export { runDyno, checkLimits } from './dyno'
export { runTransient } from './transient'
export { mapLookup, defaultFuelMap, defaultSparkMap, cloneMap, withCell } from './ecu'
export { resolveFuelSupply, RAIL_BASE_DP } from './fuel'

import { partById } from './catalog'
import { defaultFuelMap, defaultSparkMap } from './ecu'
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
    fuelPump: partById('pump-stock-110'),
    aspiration: partById('asp-na')
  }
}

export function defaultTune(): Tune {
  return {
    fuelMap: defaultFuelMap(),
    sparkMap: defaultSparkMap(),
    lambdaTrim: 0,
    sparkTrim: 0,
    revLimit: 8200,
    boostTarget: 0
  }
}
