import type { FuelPumpPart, InjectorPart } from './types'

/**
 * Sistema de combustible (fase 3): bomba con curva caudal-presión, regulador
 * referenciado a colector (ΔP constante de 3.5 bar sobre la admisión) e
 * inyectores cuyo caudal real escala con √(ΔP/3.5 bar).
 *
 * Si la bomba no da el caudal a la presión objetivo, el raíl cae hasta el
 * punto de equilibrio entre lo que la bomba entrega y lo que los inyectores
 * sacan: menos ΔP ⇒ menos caudal por inyector ⇒ más duty ⇒ si satura, la
 * mezcla empobrece. Esa es la cadena "bomba pequeña → motor roto por EGT".
 */

/** ΔP nominal del regulador sobre el colector (y ΔP de tarado del caudal estático). */
export const RAIL_BASE_DP = 3.5e5

export interface FuelSupplyInput {
  pump: FuelPumpPart
  injector: InjectorPart
  stoichAFR: number
  /** Aire atrapado por cilindro y ciclo (kg). */
  mAir: number
  lambdaTarget: number
  /** Segundos por ciclo de 4 tiempos (120/rpm). */
  cycleTime: number
  cylinders: number
  /** Presión de colector relativa al ambiente (Pa); negativa en NA con pérdidas. */
  manifoldGauge: number
  /** Duty máximo utilizable del inyector. */
  dutyLimit: number
}

export interface FuelSupplyResult {
  /** Presión de raíl real (Pa relativa al ambiente). */
  railPressure: number
  /** ΔP real a través del inyector (Pa). */
  deltaP: number
  /** Duty pedido por la ECU, saturado a 1 para presentación. */
  injectorDuty: number
  /** Combustible realmente inyectado por cilindro y ciclo (kg). */
  mFuel: number
  lambdaActual: number
  starve: 'none' | 'injector' | 'pump'
}

/** Curva de bomba: lineal desde maxFlow a 3.5 bar hasta 0 a la presión de corte. */
function pumpFlow(pump: FuelPumpPart, railGauge: number): number {
  const { maxFlow, maxPressure } = pump.spec
  const span = Math.max(maxPressure - RAIL_BASE_DP, 1e4)
  const q = (maxFlow * (maxPressure - railGauge)) / span
  return Math.min(Math.max(q, 0), 1.15 * maxFlow)
}

export function resolveFuelSupply(input: FuelSupplyInput): FuelSupplyResult {
  const { pump, injector, stoichAFR, mAir, lambdaTarget, cycleTime, cylinders, manifoldGauge, dutyLimit } =
    input

  const demandPerCycle = mAir / (stoichAFR * lambdaTarget) // kg/cil/ciclo
  const demandTotal = (demandPerCycle * cylinders) / cycleTime // kg/s

  const railTarget = RAIL_BASE_DP + Math.max(manifoldGauge, 0)
  const railMin = Math.max(manifoldGauge + 0.3e5, 0.3e5)

  const effFlow = (rail: number): number => {
    const dP = Math.max(rail - manifoldGauge, 0.3e5)
    return injector.spec.staticFlow * Math.sqrt(dP / RAIL_BASE_DP)
  }
  // Lo que los inyectores extraen del raíl a esa presión (kg/s, con duty saturado)
  const drawn = (rail: number): number => {
    const flow = effFlow(rail)
    const dutyDem = demandPerCycle / (flow * cycleTime)
    return flow * Math.min(dutyDem, dutyLimit) * cylinders
  }

  let rail = railTarget
  if (pumpFlow(pump, railTarget) < demandTotal) {
    // La bomba no llega: el raíl cae al equilibrio bomba = inyectores (bisección)
    let lo = railMin
    let hi = railTarget
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2
      if (pumpFlow(pump, mid) >= drawn(mid)) lo = mid
      else hi = mid
    }
    rail = lo
  }

  const deltaP = Math.max(rail - manifoldGauge, 0.3e5)
  const flow = effFlow(rail)
  const dutyDemanded = demandPerCycle / (flow * cycleTime)
  const mFuel = flow * Math.min(dutyDemanded, dutyLimit) * cycleTime
  const lambdaActual = mAir / (stoichAFR * mFuel)

  const pumpStarved = rail < railTarget - 0.05e5
  const starve: FuelSupplyResult['starve'] = pumpStarved
    ? 'pump'
    : dutyDemanded > dutyLimit
      ? 'injector'
      : 'none'

  return {
    railPressure: rail,
    deltaP,
    injectorDuty: Math.min(dutyDemanded, 1),
    mFuel,
    lambdaActual,
    starve
  }
}
