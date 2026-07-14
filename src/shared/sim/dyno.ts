import { simulateOperatingPoint } from './cycle'
import type {
  DerivedLimit,
  DynoResult,
  FuelSpec,
  LimitVariable,
  OperatingPointResult,
  Part,
  ResolvedEngine,
  SimEvent,
  Tune
} from './types'

/**
 * Banco de potencia: barrido de RPM a plena carga con chequeo de límites
 * de cada pieza en cada punto. El barrido se detiene en el primer fallo:
 * el motor ha roto, y el evento cuenta por qué y qué rendimiento tenía.
 */

const RPM_START = 1200
const RPM_STEP = 200
const WARNING_THRESHOLD = 0.92

const bar = (pa: number): string => (pa / 1e5).toFixed(1)
const kN = (n: number): string => (n / 1000).toFixed(1)
const degC = (k: number): string => (k - 273.15).toFixed(0)

/** Valor medido en el punto de funcionamiento para cada variable de límite. */
function measuredValue(v: LimitVariable, p: OperatingPointResult): number {
  switch (v) {
    case 'peakCylinderPressure':
      return p.peakPressure
    case 'rodCompression':
      return p.rodCompression
    case 'rodTension':
      return p.rodTension
    case 'crownTemp':
      return p.crownTemp
    case 'exhaustTemp':
      return p.exhaustTemp
    case 'rpm':
      return p.rpm
    case 'boost':
      return p.boost
    case 'injectorDuty':
      return p.injectorDuty
  }
}

function causeChain(
  v: LimitVariable,
  p: OperatingPointResult,
  limit: DerivedLimit,
  tune: Tune
): string[] {
  const chain: string[] = [`${p.rpm} rpm a plena carga`]
  if (p.boost > 1000) chain.push(`boost real ${bar(p.boost)} bar (objetivo ${bar(tune.boostTarget)} bar)`)
  if (p.lambdaActual > tune.lambda + 0.03)
    chain.push(`inyectores saturados: λ real ${p.lambdaActual.toFixed(2)} en vez de ${tune.lambda.toFixed(2)} (mezcla pobre)`)

  switch (v) {
    case 'peakCylinderPressure':
      chain.push(`presión pico en cámara ${bar(p.peakPressure)} bar > límite ${bar(limit.value)} bar`)
      break
    case 'rodCompression':
      chain.push(`presión pico ${bar(p.peakPressure)} bar empujando el pistón`)
      chain.push(`carga de compresión en biela ${kN(p.rodCompression)} kN > límite ${kN(limit.value)} kN`)
      break
    case 'rodTension':
      chain.push(`inercia de la masa alternativa en el cruce de PMS a ${p.rpm} rpm`)
      chain.push(`tracción en biela ${kN(p.rodTension)} kN > límite ${kN(limit.value)} kN`)
      break
    case 'crownTemp':
      chain.push(`corona de pistón a ${degC(p.crownTemp)} °C > límite ${degC(limit.value)} °C`)
      break
    case 'exhaustTemp':
      chain.push(`gases de escape a ${degC(p.exhaustTemp)} °C > límite ${degC(limit.value)} °C`)
      break
    case 'rpm':
      chain.push(`corte de inyección configurado a ${tune.revLimit} rpm`)
      chain.push(`${p.rpm} rpm > límite del cigüeñal ${limit.value} rpm`)
      break
    case 'boost':
      chain.push(`boost objetivo ${bar(tune.boostTarget)} bar por encima de la capacidad del turbo`)
      chain.push(`boost real ${bar(p.boost)} bar > límite ${bar(limit.value)} bar`)
      break
    case 'injectorDuty':
      chain.push(
        `duty de inyector pedido ${(p.injectorDuty * 100).toFixed(0)}% > máximo ${(limit.value * 100).toFixed(0)}%: combustible capado, λ real ${p.lambdaActual.toFixed(2)}`
      )
      break
  }
  return chain
}

function checkLimits(
  engine: ResolvedEngine,
  point: OperatingPointResult,
  tune: Tune
): SimEvent[] {
  const events: SimEvent[] = []
  const parts: Part[] = Object.values(engine.assembly)

  for (const part of parts) {
    for (const limit of part.limits) {
      const value = measuredValue(limit.variable, point)
      if (value < WARNING_THRESHOLD * limit.value) continue

      const exceeded = value >= limit.value
      // Saturar inyectores no rompe el inyector: degrada la mezcla (y eso sí
      // puede romper otras piezas vía temperatura). Nunca es 'failure' directo.
      const severity: SimEvent['severity'] =
        exceeded && limit.variable !== 'injectorDuty' ? 'failure' : 'warning'

      events.push({
        severity,
        rpm: point.rpm,
        partId: part.id,
        partName: part.name,
        failureMode: limit.failureMode,
        variable: limit.variable,
        value,
        limit: limit.value,
        causeChain: causeChain(limit.variable, point, limit, tune),
        state: { torque: point.torque, power: point.power, rpm: point.rpm }
      })
    }
  }
  return events
}

export function runDyno(engine: ResolvedEngine, tune: Tune, fuel: FuelSpec): DynoResult {
  const blocking = engine.issues.filter((i) => i.severity === 'error')
  if (blocking.length > 0) {
    throw new Error(`El motor no es montable: ${blocking.map((i) => i.message).join('; ')}`)
  }

  const points: OperatingPointResult[] = []
  const events: SimEvent[] = []
  const seen = new Set<string>()
  let failedAtRpm: number | null = null

  for (let rpm = RPM_START; rpm <= tune.revLimit; rpm += RPM_STEP) {
    const point = simulateOperatingPoint(engine, tune, fuel, rpm)
    points.push(point)

    let failed = false
    for (const ev of checkLimits(engine, point, tune)) {
      // Un aviso por pieza+variable es suficiente; los fallos siempre se registran
      const key = `${ev.partId}:${ev.variable}:${ev.severity}`
      if (ev.severity === 'warning' && seen.has(key)) continue
      seen.add(key)
      events.push(ev)
      if (ev.severity === 'failure') failed = true
    }
    if (failed) {
      failedAtRpm = rpm
      break
    }
  }

  let peakPower = { power: 0, rpm: 0 }
  let peakTorque = { torque: 0, rpm: 0 }
  for (const p of points) {
    if (p.power > peakPower.power) peakPower = { power: p.power, rpm: p.rpm }
    if (p.torque > peakTorque.torque) peakTorque = { torque: p.torque, rpm: p.rpm }
  }

  events.sort((a, b) => (a.severity === 'failure' ? -1 : 1) - (b.severity === 'failure' ? -1 : 1))

  return { points, events, failedAtRpm, peakPower, peakTorque }
}
