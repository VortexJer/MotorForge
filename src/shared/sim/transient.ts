import { manifoldConditions, simulateOperatingPoint } from './cycle'
import { checkLimits } from './dyno'
import type {
  FuelSpec,
  ResolvedEngine,
  SimEvent,
  TransientResult,
  TransientSample,
  Tune
} from './types'

/**
 * Simulación transitoria: pull a plena carga contra una inercia (banco
 * inercial). Sobre el ciclo cuasi-estático se añaden las tres dinámicas
 * que faltan en el barrido estacionario:
 *  - régimen: dω/dt = (par motor − par de arrastre) / J
 *  - turbo: el boost persigue al estacionario con una constante de tiempo
 *    (el "lag"): rápido por encima del spool, lento por debajo
 *  - térmica: corona y EGT tienen masa térmica; en un pull corto el motor
 *    puede pasar por zonas que en estacionario lo romperían
 */

export interface TransientOptions {
  /** RPM de inicio del pull. */
  startRpm?: number
  /** Inercia equivalente motor+banco (kg·m²). */
  inertia?: number
  /** Paso de integración (s). */
  dt?: number
  /** Tiempo máximo simulado (s). */
  maxTime?: number
}

/** Constante de tiempo del turbo (s): perezoso bajo el spool, vivo por encima. */
function spoolTau(rpm: number, spoolRpm: number): number {
  if (spoolRpm <= 0) return 0.2
  const x = Math.min(rpm / spoolRpm, 1.4)
  return 1.1 - 0.75 * Math.min(x, 1) // 1.1 s parado → 0.35 s en zona de trabajo
}

const TAU_CROWN = 3.5 // s — masa térmica de la corona
const TAU_EGT = 1.2 // s — colector + sonda

export function runTransient(
  engine: ResolvedEngine,
  tune: Tune,
  fuel: FuelSpec,
  options: TransientOptions = {}
): TransientResult {
  const blocking = engine.issues.filter((i) => i.severity === 'error')
  if (blocking.length > 0) {
    throw new Error(`El motor no es montable: ${blocking.map((i) => i.message).join('; ')}`)
  }

  const { startRpm = 1800, inertia = 1.5, dt = 0.02, maxTime = 30 } = options
  const asp = engine.assembly.aspiration.spec

  const samples: TransientSample[] = []
  const events: SimEvent[] = []
  const seen = new Set<string>()
  let failedAtTime: number | null = null
  let timeToRevLimit: number | null = null

  let rpm = startRpm
  let boost = 0
  // Arranque térmico: motor caliente pero sin llevar rato a plena carga
  let crownTemp = 460
  let exhaustTemp = 900

  const sampleEvery = Math.max(1, Math.round(0.05 / dt)) // guardamos a 20 Hz
  let step = 0

  for (let t = 0; t <= maxTime; t += dt, step++) {
    const point = simulateOperatingPoint(engine, tune, fuel, rpm, {
      boostOverride: asp.type === 'turbo' ? boost : undefined
    })
    const boostSteady =
      asp.type === 'turbo' ? manifoldConditions(engine, tune, rpm).boost : 0

    // Térmica de primer orden hacia el estacionario del punto
    crownTemp += ((point.crownTemp - crownTemp) / TAU_CROWN) * dt
    exhaustTemp += ((point.exhaustTemp - exhaustTemp) / TAU_EGT) * dt

    // El chequeo de límites ve las temperaturas CON inercia térmica
    const lagged = { ...point, crownTemp, exhaustTemp }

    if (step % sampleEvery === 0) {
      samples.push({
        t,
        rpm: Math.round(rpm),
        torque: point.torque,
        power: point.power,
        boost,
        boostSteady,
        crownTemp,
        exhaustTemp,
        railPressure: point.railPressure,
        knockIndex: point.knockIndex,
        lambdaActual: point.lambdaActual
      })
    }

    let failed = false
    for (const ev of checkLimits(engine, lagged, tune, fuel)) {
      const key = `${ev.partId}:${ev.variable}:${ev.severity}`
      if (ev.severity === 'warning' && seen.has(key)) continue
      seen.add(key)
      ev.time = t
      ev.causeChain[0] = `pull: ${t.toFixed(1)} s, ${Math.round(rpm)} rpm a plena carga`
      events.push(ev)
      if (ev.severity === 'failure') failed = true
    }
    if (failed) {
      failedAtTime = t
      break
    }

    if (rpm >= tune.revLimit) {
      timeToRevLimit = t
      break
    }

    // Dinámica de régimen: par motor menos un arrastre pequeño del banco
    const omega = (rpm * 2 * Math.PI) / 60
    const dragTorque = 4 + 2e-4 * omega * omega
    const domega = ((point.torque - dragTorque) / inertia) * dt
    rpm = Math.max(startRpm * 0.8, rpm + (domega * 60) / (2 * Math.PI))

    // Lag de turbo: primer orden hacia el boost estacionario a estas rpm
    if (asp.type === 'turbo') {
      boost += ((boostSteady - boost) / spoolTau(rpm, asp.spoolRpm)) * dt
    }
  }

  events.sort((a, b) => (a.severity === 'failure' ? -1 : 1) - (b.severity === 'failure' ? -1 : 1))
  return { samples, events, failedAtTime, timeToRevLimit }
}
