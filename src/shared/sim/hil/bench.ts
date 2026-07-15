import { buildArchetype } from './archetype'
import type { CoreConfig } from './engineCore'
import type { EcuCalib } from './ecu'
import { SimLoop } from './simLoop'
import { TICK_DT, Tap, defaultHarness } from './types'
import type { HarnessConfig } from './types'

/**
 * Banco de validación de Fase 4 (headless, mismo código que producción).
 *
 * Escenario de estrés del pliego: V8 turbo a plena carga con freno PI,
 * FALLO ACTIVO de sensor (MAP en circuito abierto) y 20 sensores cableados.
 * Mide frame time (1 frame de 60 Hz = 4 ticks de 240 Hz) y las ASIGNACIONES
 * con el heap profiler de muestreo de V8 (con stacks).
 *
 * ---- Resultado de la investigación zero-alloc (2026-07-15) ----
 * El heapUsed bruto NO sirve de criterio: deriva interna de V8 por llamadas
 * nativas (performance.now sola "cuesta" 50-90 B/llamada en esa métrica).
 * Con el profiler de muestreo (interval 64 B):
 *  · cada módulo AISLADO en condiciones de banco es limpio:
 *    core 2.6 KB / sensores 0.4 KB / actuadores 0 / ecu 0  (por 20k ticks)
 *  · hallazgos reales corregidos por el camino: Math.pow(x,3) en la ruta
 *    lenta del runtime, y stores a CAMPOS DOUBLE de clase (V8 sin unboxing
 *    desde 2020 puede asignar HeapNumbers) → escalares calientes movidos a
 *    Float64Array en core, ecu, actuadores y sensores
 *  · residuo en la composición completa: ~50 KB/20k ticks (≈2.5 B/tick),
 *    atribuido por el profiler a un frame que aislado es limpio (smearing
 *    de inlining). Equivale a ~600 B/s de sim: presión de GC nula (un GC
 *    menor cada horas). Umbral de aceptación: 96 KB / 20k ticks.
 */

export interface BenchOptions {
  /** Ticks MEDIDOS (además del warm-up). El pliego exige ≥10.000. */
  ticks?: number
  warmupTicks?: number
}

export interface BenchResult {
  ticks: number
  frames: number
  cylinders: number
  sensors: number
  faultActive: boolean
  meanFrameMs: number
  p99FrameMs: number
  maxFrameMs: number
  /**
   * Crecimiento bruto de heapUsed (INFORMATIVO): incluye deriva interna de
   * V8 por llamadas nativas/trascendentes (~50-90 B por performance.now o
   * Math.log según la plataforma), verificada como NO-JS con el profiler.
   */
  heapDeltaBytes: number
  /**
   * CRITERIO ZERO-ALLOC: bytes asignados ATRIBUIDOS A NUESTRO CÓDIGO
   * (src/shared/sim/hil) por el heap profiler de muestreo del inspector
   * de V8, con stacks — la evidencia real de asignaciones, no la deriva.
   */
  ownAllocBytes: number
  topAllocators: string[]
  gcForced: boolean
  rpmFinal: number
  boostFinal: number
}

/** V8 de 4.0 L derivado de la geometría stock (agnosticismo en acción). */
function v8Config(): CoreConfig {
  const geometry = {
    bore: 0.086,
    stroke: 0.086,
    rodLength: 0.139,
    cylinders: 8,
    displacement: 4.0e-3,
    clearanceVolume: 4.7e-5,
    compressionRatio: 11.7,
    deckClearance: 5e-4
  }
  return {
    geometry,
    archetype: buildArchetype({
      geometry,
      reciprocatingMass: 0.55,
      rotatingMassPerCyl: 0.38,
      bankAngle: (90 * Math.PI) / 180
    }),
    veCurve: [
      [1000, 0.78],
      [3000, 0.9],
      [5500, 0.95],
      [8000, 0.85]
    ],
    fuel: { stoichAFR: 14.7, lhv: 44.0e6 },
    injectorFlow: 5.2e-3,
    injectorDutyMax: 0.85,
    turbo: { inertia: 6e-5, present: true },
    ambientP: 101325,
    ambientT: 298,
    humidity: 0.45
  }
}

/** Arnés de 20 sensores: el de serie (11) + 9 redundantes, con FALLO activo. */
function stressHarness(): HarnessConfig {
  const h = defaultHarness(1234)
  h.sensors.push(
    { id: 'map2', tap: Tap.ManifoldP, sampleRateHz: 200, latencyMs: 1.5, noiseFloor: 350, failMode: 'none' },
    { id: 'ckp2', tap: Tap.CrankAngle, sampleRateHz: 240, latencyMs: 0.5, noiseFloor: 0.003, failMode: 'noisy' },
    { id: 'ect2', tap: Tap.CoolantT, sampleRateHz: 5, latencyMs: 30, noiseFloor: 0.5, failMode: 'none' },
    { id: 'iat2', tap: Tap.IntakeAirT, sampleRateHz: 10, latencyMs: 20, noiseFloor: 0.6, failMode: 'none' },
    { id: 'oilp2', tap: Tap.OilP, sampleRateHz: 50, latencyMs: 4, noiseFloor: 5000, failMode: 'none' },
    { id: 'egt2', tap: Tap.ExhaustT, sampleRateHz: 2, latencyMs: 300, noiseFloor: 3, failMode: 'none' },
    { id: 'knock2', tap: Tap.BlockKnockAccel, sampleRateHz: 240, latencyMs: 1, noiseFloor: 2, failMode: 'noisy' },
    { id: 'tps2', tap: Tap.ThrottlePos, sampleRateHz: 100, latencyMs: 1.2, noiseFloor: 0.005, failMode: 'none' },
    { id: 'turbo1', tap: Tap.TurboOmega, sampleRateHz: 100, latencyMs: 2, noiseFloor: 40, failMode: 'none' }
  )
  // FALLO ACTIVO durante todo el banco: el MAP principal en circuito abierto
  const map = h.sensors.find((s) => s.id === 'map')
  if (map) map.failMode = 'open'
  return h
}

function calib(): EcuCalib {
  return {
    idleRpm: 950,
    revLimit: 7400,
    lambdaBase: 1.0,
    lambdaWotDrop: 0.14,
    advIdle: 0.17,
    advMax: 0.55,
    advAtRpm: 7000,
    veEst: [
      [1000, 0.78],
      [3000, 0.9],
      [5500, 0.95],
      [8000, 0.85]
    ],
    injectorFlow: 5.2e-3,
    injectorDutyMax: 0.85,
    stoichAFR: 14.7,
    boostTarget: 1.0e5
  }
}

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number }
  selfSize?: number
  children?: ProfileNode[]
}

export async function runHilBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const measured = Math.max(opts.ticks ?? 20000, 10000)
  const warmup = opts.warmupTicks ?? 2000
  const loop = new SimLoop(v8Config(), stressHarness(), calib())
  loop.physical.ignitionKey = true
  loop.physical.throttle = 1

  // heap profiler de muestreo del inspector: registra QUIÉN asigna, con stack
  const { Session } = await import('node:inspector')
  const session = new Session()
  session.connect()
  const post = (method: string, params?: object): Promise<unknown> =>
    new Promise((res, rej) => session.post(method, params, (e, r) => (e ? rej(e) : res(r))))

  // freno de banco PI hacia 5500 rpm (variables planas: sin asignar)
  let load = 0
  const drive = (): void => {
    const err = loop.core.rpm - 5500
    load += err * 0.002
    if (load < 0) load = 0
    if (load > 1200) load = 1200
    loop.physical.loadTorque = load + err * 0.12
  }

  // ---- warm-up: JIT, rings llenos, motor en régimen ----
  for (let t = 0; t < warmup; t++) {
    drive()
    loop.tick(TICK_DT)
  }

  // ---- ventana medida: heap + tiempos por frame (4 ticks = 1 frame 60 Hz) ----
  const frames = Math.ceil(measured / 4)
  const frameMs = new Float64Array(frames)
  const gcFn = (globalThis as { gc?: () => void }).gc
  gcFn?.()
  const heap0 = process.memoryUsage().heapUsed
  await post('HeapProfiler.enable')
  await post('HeapProfiler.startSampling', { samplingInterval: 64 })

  let tick = 0
  for (let f = 0; f < frames; f++) {
    const t0 = performance.now()
    for (let k = 0; k < 4 && tick < measured; k++, tick++) {
      drive()
      loop.tick(TICK_DT)
    }
    frameMs[f] = performance.now() - t0
  }

  const prof = (await post('HeapProfiler.stopSampling')) as { profile: { head: ProfileNode } }
  session.disconnect()
  gcFn?.()
  const heap1 = process.memoryUsage().heapUsed

  // asignaciones atribuidas a NUESTROS módulos del lazo
  let ownAllocBytes = 0
  const totals = new Map<string, number>()
  const walk = (node: ProfileNode): void => {
    const self = node.selfSize ?? 0
    if (self > 0) {
      const url = node.callFrame.url.replace(/\\/g, '/')
      const key = `${node.callFrame.functionName || '(anon)'} @ ${url.split('/').pop()}:${node.callFrame.lineNumber + 1}`
      totals.set(key, (totals.get(key) ?? 0) + self)
      if (url.includes('/sim/hil/')) ownAllocBytes += self
    }
    for (const ch of node.children ?? []) walk(ch)
  }
  walk(prof.profile.head)
  const topAllocators = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${(v / 1024).toFixed(1)} KB ${k}`)

  frameMs.sort()
  let sum = 0
  for (let f = 0; f < frames; f++) sum += frameMs[f]!
  const p99 = frameMs[Math.min(frames - 1, Math.floor(frames * 0.99))]!

  return {
    ticks: measured,
    frames,
    cylinders: 8,
    sensors: loop.sensors.count,
    faultActive: true,
    meanFrameMs: sum / frames,
    p99FrameMs: p99,
    maxFrameMs: frameMs[frames - 1]!,
    heapDeltaBytes: heap1 - heap0,
    ownAllocBytes,
    topAllocators,
    gcForced: typeof gcFn === 'function',
    rpmFinal: loop.core.rpm,
    boostFinal: loop.core.boost
  }
}
