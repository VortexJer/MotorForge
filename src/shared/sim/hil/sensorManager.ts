import { TICK_RATE, Tap } from './types'
import type { HarnessConfig, SensorInstance, SensorSpec } from './types'

/**
 * SensorManager: la única frontera entre la física y la ECU.
 *
 * La física escribe su "verdad" en `truth` (Float64Array, un slot por Tap)
 * una vez por tick. Cada sensor cableado muestrea ESA verdad a su propia
 * frecuencia, con retraso de transporte (ring buffer preasignado), ruido
 * gaussiano determinista (mulberry32 por sensor), cuantización ADC y modo
 * de fallo. La ECU solo ve `read()`.
 *
 * Zero-allocation: TODA la memoria se asigna en el constructor. tick() y
 * read() no crean objetos, arrays ni closures (ver ADR-001 en types.ts).
 */

class Sensor implements SensorInstance {
  readonly spec: SensorSpec
  /** Ring de verdad por tick: f32 (ADR-001 §3), longitud latencyTicks+1. */
  private readonly ring: Float32Array
  private cursor = 0
  /** Periodo de muestreo (s). */
  private readonly period: number
  /** [acc, held, spare, rng]: escalares mutables en Float64Array — los
   *  stores a campos double de clase asignan HeapNumbers en V8. */
  private readonly st = new Float64Array(4)
  private stuckArmed = false
  private hasSpare = false

  constructor(spec: SensorSpec, seed: number, private readonly truth: Float64Array) {
    this.spec = spec
    const latencyTicks = Math.max(0, Math.ceil((spec.latencyMs / 1000) * TICK_RATE))
    this.ring = new Float32Array(latencyTicks + 1)
    const rate = Math.min(Math.max(spec.sampleRateHz, 0.01), TICK_RATE)
    this.period = 1 / rate
    // desfase inicial aleatorio-determinista del muestreo (sensores no sincronizados)
    this.st[3] = (seed ^ 0x9e3779b9) >>> 0
    this.st[0] = this.uniform() * this.period
    // el ring arranca con la verdad inicial para no leer ceros espurios
    this.ring.fill(truth[spec.tap] ?? 0)
    this.st[1] = this.process(this.ring[0]!)
  }

  /** mulberry32: PRNG entero sin asignaciones. */
  private uniform(): number {
    this.st[3] = ((this.st[3]! + 0x6d2b79f5) >>> 0)
    let t = this.st[3]!
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Gaussiana N(0,1) por Box-Muller con reserva (cero asignaciones). */
  private gaussian(): number {
    if (this.hasSpare) {
      this.hasSpare = false
      return this.st[2]!
    }
    let u = 0
    let v = 0
    do {
      u = this.uniform()
    } while (u <= 1e-12)
    v = this.uniform()
    const mag = Math.sqrt(-2 * Math.log(u))
    this.st[2] = mag * Math.sin(2 * Math.PI * v)
    this.hasSpare = true
    return mag * Math.cos(2 * Math.PI * v)
  }

  /** Ruido + ADC + modo de fallo sobre un valor crudo retrasado. */
  private process(raw: number): number {
    const spec = this.spec
    if (spec.failMode === 'open') return spec.adc ? spec.adc.min : 0
    let v = raw
    const sigma = spec.failMode === 'noisy' ? spec.noiseFloor * 8 : spec.noiseFloor
    if (sigma > 0) v += this.gaussian() * sigma
    const adc = spec.adc
    if (adc) {
      if (v < adc.min) v = adc.min
      else if (v > adc.max) v = adc.max
      const steps = (1 << adc.bits) - 1
      const q = (adc.max - adc.min) / steps
      v = adc.min + Math.round((v - adc.min) / q) * q
    }
    return v
  }

  /** Avanza un tick de física: transporta la verdad y muestrea si toca. */
  step(dt: number): void {
    const ring = this.ring
    const len = ring.length
    ring[this.cursor] = this.truth[this.spec.tap] ?? 0
    // con len = latencyTicks+1, el slot siguiente es el escrito hace latencyTicks
    const delayed = ring[(this.cursor + 1) % len]!
    this.cursor = (this.cursor + 1) % len

    this.st[0] = this.st[0]! + dt
    if (this.st[0]! < this.period) return
    // consume UN periodo por tick como máximo (rate ya saturado a TICK_RATE)
    this.st[0] = this.st[0]! - this.period
    if (this.st[0]! > this.period) this.st[0] = this.period

    if (this.spec.failMode === 'stuck') {
      if (!this.stuckArmed) {
        this.st[1] = this.process(delayed)
        this.stuckArmed = true
      }
      return
    }
    this.st[1] = this.process(delayed)
  }

  read(): number {
    return this.st[1]!
  }
}

export class SensorManager {
  /** Verdad física del tick actual: la física escribe truth[Tap.X] = valor. */
  readonly truth: Float64Array
  private readonly sensors: Sensor[]
  private readonly byId: Map<string, Sensor>

  constructor(harness: HarnessConfig) {
    this.truth = new Float64Array(Tap.COUNT)
    this.sensors = []
    this.byId = new Map()
    const seen = new Set<string>()
    for (let i = 0; i < harness.sensors.length; i++) {
      const spec = harness.sensors[i]!
      if (seen.has(spec.id)) throw new Error(`Arnés inválido: sensor duplicado '${spec.id}'`)
      if (spec.latencyMs < 0 || spec.sampleRateHz <= 0) {
        throw new Error(`Arnés inválido: sensor '${spec.id}' con latencia o frecuencia fuera de rango`)
      }
      if (spec.adc && (spec.adc.bits < 1 || spec.adc.bits > 16 || spec.adc.max <= spec.adc.min)) {
        throw new Error(`Arnés inválido: ADC del sensor '${spec.id}' mal definido`)
      }
      seen.add(spec.id)
      const s = new Sensor(spec, (harness.seed + i * 0x85ebca6b) >>> 0, this.truth)
      this.sensors.push(s)
      this.byId.set(spec.id, s)
    }
  }

  /** Avanza todos los sensores un tick de física. Cero asignaciones. */
  tick(dt: number): void {
    const list = this.sensors
    for (let i = 0; i < list.length; i++) list[i]!.step(dt)
  }

  /** Resolución de cableado (para que la ECU cachee en su arranque). */
  sensor(id: string): SensorInstance | null {
    return this.byId.get(id) ?? null
  }

  get count(): number {
    return this.sensors.length
  }
}
