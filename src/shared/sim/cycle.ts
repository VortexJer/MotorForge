import { mapLookup } from './ecu'
import { resolveFuelSupply } from './fuel'
import type { FuelSpec, OperatingPointResult, ResolvedEngine, Tune } from './types'

/**
 * Ciclo termodinámico 0D monozona con resolución de ángulo de cigüeñal.
 *
 * Modelos (ver ARCHITECTURE.md):
 *  - Liberación de calor: ley de Wiebe (a=5, m=2), duración dependiente de rpm y lambda.
 *  - Gas ideal con gamma variable con la temperatura.
 *  - Transferencia de calor a paredes: correlación tipo Woschni simplificada.
 *  - Fricción: Chen-Flynn (constante + presión pico + velocidad media de pistón).
 *  - Bombeo: PMEP = p_escape − p_admisión (lazo de bombeo rectangular).
 *  - Cargas: fuerza de gas + inercia alternativa sobre la biela, cuasi-estáticas.
 *  - Fase 3: λ y avance salen de mapas ECU (rpm × carga), el combustible pasa
 *    por bomba + regulador + inyectores (√ΔP) y se evalúa un índice de
 *    detonación empírico (octanaje requerido / octanaje del combustible).
 *
 * Deliberadamente NO modela (v0): gasdinámica de colectores, desgaste. Fase 4.
 */

const R_GAS = 287 // J/(kg·K), aire
const P_AMBIENT = 101325 // Pa
const T_WALL = 440 // K, pared de cilindro a plena carga
const IVC = deg(-150) // cierre de admisión, rad respecto a PMS de compresión
const EVO = deg(150) // apertura de escape
const STEP = deg(0.25)
const WIEBE_A = 5
const WIEBE_M = 2
const RESIDUAL_FRACTION = 0.04
const COMBUSTION_EFF = 0.96
/**
 * Calibración: la monozona ideal sobreestima el rendimiento (~40% de eficiencia
 * de freno). Este derate agrupa disociación, combustión no ideal y blowby para
 * dejar el BSFC en la banda real de un motor de gasolina (~240-280 g/kWh).
 */
const REAL_BURN_DERATE = 0.9

function deg(d: number): number {
  return (d * Math.PI) / 180
}

export function interpolateCurve(curve: Array<[number, number]>, x: number): number {
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (!first || !last) throw new Error('Curva vacía')
  if (x <= first[0]) return first[1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!
    const b = curve[i]!
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0])
      return a[1] + t * (b[1] - a[1])
    }
  }
  return last[1]
}

/**
 * Condiciones en el colector de admisión y escape para un punto a plena carga.
 * `boostOverride` (transitorios) impone el boost real con lag en vez del
 * estacionario de la curva de spool.
 */
export function manifoldConditions(
  engine: ResolvedEngine,
  tune: Tune,
  rpm: number,
  boostOverride?: number
): { pMan: number; tMan: number; pExh: number; boost: number } {
  const asp = engine.assembly.aspiration.spec
  if (asp.type === 'na') {
    // Pérdidas de admisión crecientes con rpm (filtro, mariposa, runners)
    const pMan = P_AMBIENT - 1500 - 4500 * Math.pow(rpm / 9000, 2)
    const pExh = P_AMBIENT + 9000 * Math.pow(rpm / 9000, 2)
    return { pMan, tMan: 310, pExh, boost: 0 }
  }
  // Turbo: el boost objetivo se alcanza progresivamente hasta la rpm de spool
  const spoolStart = 0.45 * asp.spoolRpm
  const spoolFactor = clamp((rpm - spoolStart) / (asp.spoolRpm - spoolStart), 0, 1)
  const boostSteady = tune.boostTarget * spoolFactor * spoolFactor * (3 - 2 * spoolFactor) // smoothstep
  const boost = boostOverride ?? boostSteady
  const pMan = P_AMBIENT + boost - 2000
  // Temperatura post-intercooler: sube con el boost
  const tMan = 310 + 26 * (boost / 1e5)
  // La contrapresión de escape de un turbo supera al boost (típico ×1.3-1.5)
  const pExh = P_AMBIENT + 1.35 * boost + 6000 * Math.pow(rpm / 9000, 2)
  return { pMan, tMan, pExh, boost }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/**
 * Simula un ciclo completo en estacionario a plena carga y devuelve
 * rendimiento, presiones, temperaturas y cargas sobre las piezas.
 */
export function simulateOperatingPoint(
  engine: ResolvedEngine,
  tune: Tune,
  fuel: FuelSpec,
  rpm: number,
  opts: { boostOverride?: number } = {}
): OperatingPointResult {
  const g = engine.geometry
  const { piston, rod, head, injector, fuelPump } = engine.assembly

  const omega = (rpm * 2 * Math.PI) / 60
  const area = (Math.PI * g.bore * g.bore) / 4
  const r = g.stroke / 2
  const l = g.rodLength
  const lambdaR = r / l // relación biela-manivela
  const vDispCyl = area * g.stroke
  const meanPistonSpeed = (2 * g.stroke * rpm) / 60

  const { pMan, tMan, pExh, boost } = manifoldConditions(engine, tune, rpm, opts.boostOverride)

  // ---- Llenado del cilindro ----
  const ve = interpolateCurve(head.spec.veCurve, rpm)
  const rhoMan = pMan / (R_GAS * tMan)
  const mAir = ve * rhoMan * vDispCyl // kg de aire atrapado por cilindro y ciclo

  // ---- ECU: λ objetivo y avance desde los mapas (rpm × carga) + trims ----
  const lambdaTarget = clamp(mapLookup(tune.fuelMap, rpm, pMan) + tune.lambdaTrim, 0.7, 1.4)
  const sparkAdvance = mapLookup(tune.sparkMap, rpm, pMan) + tune.sparkTrim // ° APMS

  // ---- Sistema de combustible: bomba + regulador + inyectores ----
  const cycleTime = 120 / rpm // s por ciclo de 4 tiempos
  const dutyLimit =
    injector.limits.find((li) => li.variable === 'injectorDuty')?.value ?? 0.85
  const supply = resolveFuelSupply({
    pump: fuelPump,
    injector,
    stoichAFR: fuel.stoichAFR,
    mAir,
    lambdaTarget,
    cycleTime,
    cylinders: g.cylinders,
    manifoldGauge: pMan - P_AMBIENT,
    dutyLimit
  })
  const { mFuel, lambdaActual, injectorDuty } = supply

  // Solo arde el combustible que encuentra aire (mezcla rica: el exceso no libera calor)
  const burnableFuel = Math.min(mFuel, mAir / fuel.stoichAFR)
  let combEff = COMBUSTION_EFF * REAL_BURN_DERATE
  const richness = Math.max(0, 1 - lambdaActual)
  combEff *= 1 - 0.3 * richness // combustión rica incompleta: parte del carbono se queda en CO
  if (lambdaActual > 1.15) combEff *= Math.max(0.7, 1 - 0.6 * (lambdaActual - 1.15)) // fallos de encendido en mezcla muy pobre
  const qTotal = burnableFuel * fuel.lhv * combEff

  const burnStart = deg(-sparkAdvance + 4) // retardo de encendido ~4°
  const burnDuration =
    deg(38 + 16 * (rpm / 9000)) *
    (1 + 0.7 * Math.max(0, lambdaActual - 1)) * // pobre quema despacio
    (1 - 0.15 * richness) // rica quema algo más rápido

  // ---- Cinemática ----
  const pistonPos = (th: number): number =>
    r * (1 - Math.cos(th)) + l * (1 - Math.sqrt(1 - Math.pow((r * Math.sin(th)) / l, 2)))
  const volume = (th: number): number => g.clearanceVolume + area * pistonPos(th)
  const pistonAccel = (th: number): number =>
    omega * omega * r * (Math.cos(th) + lambdaR * Math.cos(2 * th))

  const wiebe = (th: number): number => {
    if (th <= burnStart) return 0
    const x = (th - burnStart) / burnDuration
    if (x >= 1) return 1
    return 1 - Math.exp(-WIEBE_A * Math.pow(x, WIEBE_M + 1))
  }

  // ---- Integración del ciclo cerrado (IVC → EVO) ----
  const mGas = (mAir + mFuel) * (1 + RESIDUAL_FRACTION)
  const mRecip = piston.spec.mass + 0.33 * rod.spec.mass

  let theta = IVC
  let V = volume(theta)
  let P = pMan
  let T = (P * V) / (mGas * R_GAS)
  let work = 0
  let qHeatTransfer = 0
  let peakPressure = P
  let peakPressureAngle = theta
  let peakGasTemp = T
  let rodCompressionMax = 0
  let rodTensionMax = 0
  const areaHt = 2.3 * area // corona + culata + pared media

  while (theta < EVO) {
    const gamma = clamp(1.392 - 5.5e-5 * T, 1.24, 1.4)
    const thetaNext = theta + STEP
    const dV = volume(thetaNext) - V
    const dQc = qTotal * (wiebe(thetaNext) - wiebe(theta))
    // Woschni simplificado: h ∝ P^0.8 · T^-0.55 · w^0.8
    const w = 2.28 * meanPistonSpeed
    const h =
      3.26 * Math.pow(g.bore, -0.2) * Math.pow(P / 1000, 0.8) * Math.pow(T, -0.55) * Math.pow(w, 0.8)
    const aWall = areaHt + Math.PI * g.bore * pistonPos(theta)
    const dQht = h * aWall * (T - T_WALL) * (STEP / omega)

    const dP = ((gamma - 1) / V) * (dQc - dQht) - gamma * (P / V) * dV
    work += P * dV
    qHeatTransfer += dQht

    P += dP
    V += dV
    theta = thetaNext
    T = (P * V) / (mGas * R_GAS)

    if (P > peakPressure) {
      peakPressure = P
      peakPressureAngle = theta
    }
    if (T > peakGasTemp) peakGasTemp = T

    // Carga axial en biela: fuerza de gas menos inercia alternativa
    const rodForce = (P - P_AMBIENT) * area - mRecip * pistonAccel(theta)
    if (rodForce > rodCompressionMax) rodCompressionMax = rodForce
    if (-rodForce > rodTensionMax) rodTensionMax = -rodForce
  }

  // Tracción en PMS de cruce (fin de escape): solo inercia, sin presión que la compense
  const tensionAtOverlap = mRecip * omega * omega * r * (1 + lambdaR) - (pMan - P_AMBIENT) * area
  if (tensionAtOverlap > rodTensionMax) rodTensionMax = tensionAtOverlap

  // ---- Presiones medias efectivas ----
  const imepGross = work / vDispCyl
  const pmep = pExh - pMan
  const imep = imepGross - pmep
  const fmep =
    25000 + 0.005 * peakPressure + 500 * meanPistonSpeed + 60 * meanPistonSpeed * meanPistonSpeed
  const bmep = imep - fmep

  let torque = (bmep * g.displacement) / (4 * Math.PI)

  // ---- Detonación: octanaje requerido por el punto vs octanaje del combustible ----
  // Empírico calibrado: +5 ON por punto de RC, +14 ON/bar de boost, +0.3 ON/K de
  // temperatura de admisión, ±1.3 ON/° de avance respecto al base, alivios por
  // rpm (menos tiempo de residencia) y por mezcla rica (enfría la carga).
  const advBase = 12 + 20 * clamp((rpm - 1000) / 7000, 0, 1)
  const octaneRequired =
    32 +
    5.0 * g.compressionRatio +
    14 * (boost / 1e5) +
    0.3 * (tMan - 310) +
    1.3 * (sparkAdvance - advBase) -
    3.0 * clamp((rpm - 1500) / 6000, 0, 1) -
    28 * richness
  const knockIndex = Math.max(0, octaneRequired) / fuel.octane
  const knockExcess = Math.max(0, knockIndex - 1)
  // Picar quema trabajo y mete calor en la corona
  torque *= 1 - Math.min(0.3, 1.5 * knockExcess)
  const power = torque * omega

  // ---- Temperaturas derivadas ----
  // EGT: expansión de blowdown desde condiciones en EVO hasta presión de escape,
  // menos el enfriamiento por mezcla rica (el motivo por el que se engorda con turbo)
  const gammaExh = 1.3
  const richCooling = fuel.richCooling * richness
  const exhaustTemp =
    T * Math.pow(pExh / Math.max(P, pExh), (gammaExh - 1) / gammaExh) - richCooling
  // Corona de pistón: flujo de calor medio × resistencia térmica corona→aceite/camisa
  const heatFlux = (qHeatTransfer * (rpm / 120)) / areaHt
  const crownTemp = 385 + 4.4e-4 * heatFlux - 0.3 * richCooling + Math.min(150, 1400 * knockExcess)

  const fuelFlow = (mFuel * g.cylinders * rpm) / 120
  const bsfc = power > 0 ? fuelFlow / power : Number.POSITIVE_INFINITY

  return {
    rpm,
    torque,
    power,
    imep,
    bmep,
    fmep,
    peakPressure,
    peakPressureAngle,
    peakGasTemp,
    exhaustTemp,
    crownTemp,
    manifoldPressure: pMan,
    boost,
    rodCompression: rodCompressionMax,
    rodTension: rodTensionMax,
    injectorDuty,
    lambdaTarget,
    lambdaActual,
    sparkAdvance,
    railPressure: supply.railPressure,
    fuelStarve: supply.starve,
    knockIndex,
    fuelFlow,
    bsfc
  }
}
