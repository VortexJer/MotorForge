import { simulateOperatingPoint } from './cycle'
import type {
  FuelSpec,
  OperatingPointResult,
  ResolvedEngine,
  SimEvent,
  Tune
} from './types'

/**
 * Banco de resistencia (fase 4): desgaste y fatiga acumulados en el tiempo.
 *
 * A diferencia del dyno (¿rompe AHORA?), aquí la pregunta es ¿CUÁNTO DURA?
 * Cada mecanismo acumula daño 0→1 con su propia física simplificada:
 *  - Fatiga de biela: regla de Miner sobre una curva S-N (la fatiga no avisa:
 *    no degrada nada hasta que rompe).
 *  - Fatiga de cigüeñal: tiempo sostenido cerca de su régimen límite.
 *  - Ringland: el picado sostenido martillea el puente entre segmentos.
 *  - Corona: fluencia térmica cuando trabaja cerca de su temperatura límite.
 *  - Cojinetes: presión de combustión × régimen (película de aceite).
 *  - Segmentos/camisa: desgaste NO catastrófico que roba compresión y par
 *    progresivamente (fallo progresivo, no evento).
 *
 * v0 asume plena carga a cada régimen del perfil (banco de resistencia).
 */

export type EnduranceStyle = 'suave' | 'deportivo' | 'limite'

export interface WearState {
  rodFatigue: number
  crankFatigue: number
  ringlandKnock: number
  pistonThermal: number
  bearings: number
  /** Desgaste de segmentos/camisa: progresivo, no catastrófico. */
  ringsWear: number
}

export const WEAR_LABELS: Record<keyof WearState, string> = {
  rodFatigue: 'Fatiga de biela (Miner)',
  crankFatigue: 'Fatiga de cigüeñal',
  ringlandKnock: 'Ringland (picado)',
  pistonThermal: 'Corona (fluencia térmica)',
  bearings: 'Cojinetes de biela',
  ringsWear: 'Segmentos y camisa'
}

export interface EnduranceSample {
  /** Minutos simulados. */
  tMin: number
  wear: WearState
  /** Par de referencia (al régimen de par máximo del perfil) con el desgaste actual. */
  torqueRef: number
}

export interface EnduranceResult {
  samples: EnduranceSample[]
  events: SimEvent[]
  /** Minuto del primer fallo, si lo hubo. */
  failedAtMinute: number | null
  finalWear: WearState
  /** Pérdida de par por desgaste al final (0..1). */
  torqueLossFraction: number
}

export interface EnduranceOptions {
  minutes?: number
  style?: EnduranceStyle
}

/** Perfil de uso: fracciones del corte y peso temporal de cada tramo. */
const PROFILES: Record<EnduranceStyle, Array<{ rpmFrac: number; dwell: number }>> = {
  suave: [
    { rpmFrac: 0.3, dwell: 0.5 },
    { rpmFrac: 0.45, dwell: 0.35 },
    { rpmFrac: 0.65, dwell: 0.15 }
  ],
  deportivo: [
    { rpmFrac: 0.5, dwell: 0.3 },
    { rpmFrac: 0.7, dwell: 0.4 },
    { rpmFrac: 0.9, dwell: 0.25 },
    { rpmFrac: 1.0, dwell: 0.05 }
  ],
  limite: [
    { rpmFrac: 0.8, dwell: 0.2 },
    { rpmFrac: 0.95, dwell: 0.4 },
    { rpmFrac: 1.0, dwell: 0.4 }
  ]
}

function limitOf(engine: ResolvedEngine, partKey: 'rod' | 'crank' | 'piston', variable: string): number | null {
  const part = engine.assembly[partKey]
  return part.limits.find((l) => l.variable === variable)?.value ?? null
}

/** Tasas de daño por segundo de cada mecanismo en un punto de funcionamiento. */
function damageRates(engine: ResolvedEngine, p: OperatingPointResult): WearState {
  const rates: WearState = {
    rodFatigue: 0,
    crankFatigue: 0,
    ringlandKnock: 0,
    pistonThermal: 0,
    bearings: 0,
    ringsWear: 0
  }

  // Fatiga de biela: Miner sobre S-N con pendiente fuerte (k=20).
  // N(ratio) = 3100·ratio^-20 ciclos hasta rotura; sin daño por debajo de 0.55.
  const tensionLimit = limitOf(engine, 'rod', 'rodTension')
  if (tensionLimit !== null) {
    const ratio = p.rodTension / tensionLimit
    if (ratio > 0.55) {
      const cyclesToFail = 3100 * Math.pow(Math.min(ratio, 1), -20)
      rates.rodFatigue = p.rpm / 120 / cyclesToFail
    }
  }

  // Fatiga de cigüeñal: solo cuenta el tiempo sostenido cerca del límite
  const rpmLimit = limitOf(engine, 'crank', 'rpm')
  if (rpmLimit !== null) {
    const x = (p.rpm / rpmLimit - 0.85) / 0.15
    if (x > 0) rates.crankFatigue = Math.pow(Math.min(x, 1), 3) / 600
  }

  // Ringland: picado sostenido; el daño crece rápido con el exceso
  const knockTol = limitOf(engine, 'piston', 'knockIndex')
  if (knockTol !== null) {
    const excess = p.knockIndex - 0.95 * knockTol
    if (excess > 0) rates.ringlandKnock = 8 * Math.pow(excess, 1.5)
  }

  // Corona: fluencia cuando trabaja a menos de 60 K de su límite
  const crownLimit = limitOf(engine, 'piston', 'crownTemp')
  if (crownLimit !== null) {
    const over = p.crownTemp - (crownLimit - 60)
    if (over > 0) rates.pistonThermal = Math.pow(over / 60, 2) / 120
  }

  // Cojinetes: presión de combustión × régimen (adelgaza la película)
  rates.bearings = (Math.pow(p.peakPressure / 1.6e7, 2) * (p.rpm / 8000)) / 3600

  // Segmentos/camisa: velocidad media de pistón (2 h de vida a 20 m/s)
  const meanPistonSpeed = (2 * engine.geometry.stroke * p.rpm) / 60
  rates.ringsWear = meanPistonSpeed / 20 / 7200

  return rates
}

const MECHANISM_FAILURE: Record<
  Exclude<keyof WearState, 'ringsWear'>,
  { partKey: 'rod' | 'crank' | 'piston'; mode: string; detail: string }
> = {
  rodFatigue: {
    partKey: 'rod',
    mode: 'Rotura de biela por fatiga acumulada (Miner)',
    detail: 'miles de ciclos de tracción por encima del 55% de su límite: la grieta crece sin avisar'
  },
  crankFatigue: {
    partKey: 'crank',
    mode: 'Rotura de muñequilla por fatiga acumulada',
    detail: 'tiempo sostenido cerca del régimen límite del cigüeñal'
  },
  ringlandKnock: {
    partKey: 'piston',
    mode: 'Rotura de ringland por picado sostenido',
    detail: 'la detonación martillea el puente entre segmentos ciclo tras ciclo'
  },
  pistonThermal: {
    partKey: 'piston',
    mode: 'Colapso de corona por fluencia térmica',
    detail: 'la corona trabaja demasiado cerca de su temperatura límite y el material fluye'
  },
  bearings: {
    partKey: 'crank',
    mode: 'Fundido de cojinete de biela',
    detail: 'presión de combustión y régimen sostenidos adelgazan la película de aceite hasta el contacto'
  }
}

export function runEndurance(
  engine: ResolvedEngine,
  tune: Tune,
  fuel: FuelSpec,
  options: EnduranceOptions = {}
): EnduranceResult {
  const blocking = engine.issues.filter((i) => i.severity === 'error')
  if (blocking.length > 0) {
    throw new Error(`El motor no es montable: ${blocking.map((i) => i.message).join('; ')}`)
  }

  const { minutes = 30, style = 'deportivo' } = options
  const profile = PROFILES[style]

  // Puntos únicos del perfil (el desgaste no altera las cargas en v0)
  const segments = profile.map(({ rpmFrac, dwell }) => {
    const rpm = Math.max(1200, Math.round((rpmFrac * tune.revLimit) / 100) * 100)
    return { point: simulateOperatingPoint(engine, tune, fuel, rpm), dwell }
  })
  const refPoint = segments.reduce((a, b) => (b.point.torque > a.point.torque ? b : a)).point

  const wear: WearState = {
    rodFatigue: 0,
    crankFatigue: 0,
    ringlandKnock: 0,
    pistonThermal: 0,
    bearings: 0,
    ringsWear: 0
  }
  const rates = segments.map(({ point, dwell }) => ({ rates: damageRates(engine, point), dwell, point }))

  const samples: EnduranceSample[] = []
  const events: SimEvent[] = []
  let failedAtMinute: number | null = null

  const keys = Object.keys(wear) as Array<keyof WearState>
  const failed = new Set<keyof WearState>()

  for (let m = 0; m <= minutes && failedAtMinute === null; m++) {
    // El desgaste de segmentos roba par y calienta la corona (fallo progresivo)
    const torqueRef = refPoint.torque * (1 - 0.1 * Math.min(wear.ringsWear, 1))
    samples.push({ tMin: m, wear: { ...wear }, torqueRef })
    if (m === minutes) break

    // Avanza un minuto de perfil
    for (const { rates: r, dwell, point } of rates) {
      const seconds = 60 * dwell
      const blowbyHeat = 25 * Math.min(wear.ringsWear, 1)
      for (const k of keys) {
        let rate = r[k]
        // La corona caliente por blowby acelera el daño térmico
        if (k === 'pistonThermal' && rate === 0 && blowbyHeat > 0) {
          const crownLimit = limitOf(engine, 'piston', 'crownTemp')
          if (crownLimit !== null) {
            const over = point.crownTemp + blowbyHeat - (crownLimit - 60)
            if (over > 0) rate = Math.pow(over / 60, 2) / 120
          }
        }
        wear[k] = Math.min(wear[k] + rate * seconds, k === 'ringsWear' ? 1 : 1.001)
      }
    }

    for (const k of keys) {
      if (k === 'ringsWear' || wear[k] < 1 || failed.has(k)) continue
      failed.add(k)
      failedAtMinute = m + 1
      const info = MECHANISM_FAILURE[k]
      const part = engine.assembly[info.partKey]
      const worst = rates.reduce((a, b) => (b.rates[k] > a.rates[k] ? b : a))
      events.push({
        severity: 'failure',
        rpm: worst.point.rpm,
        time: (m + 1) * 60,
        partId: part.id,
        partName: part.name,
        failureMode: info.mode,
        variable: k === 'ringlandKnock' ? 'knockIndex' : k === 'pistonThermal' ? 'crownTemp' : k === 'crankFatigue' || k === 'bearings' ? 'rpm' : 'rodTension',
        value: 1,
        limit: 1,
        causeChain: [
          `banco de resistencia, perfil "${style}", minuto ${m + 1}`,
          info.detail,
          `daño acumulado 100% (regla de Miner) — el tramo que más castiga: ${worst.point.rpm} rpm`
        ],
        state: { torque: worst.point.torque, power: worst.point.power, rpm: worst.point.rpm }
      })
    }
  }

  // El minuto del fallo también cuenta: así las barras marcan 100% en el
  // mecanismo que rompió y el gráfico llega hasta la rotura.
  if (failedAtMinute !== null) {
    const torqueRef = refPoint.torque * (1 - 0.1 * Math.min(wear.ringsWear, 1))
    samples.push({ tMin: failedAtMinute, wear: { ...wear }, torqueRef })
  }

  const last = samples[samples.length - 1]!
  return {
    samples,
    events,
    failedAtMinute,
    finalWear: last.wear,
    torqueLossFraction: 1 - last.torqueRef / refPoint.torque
  }
}
