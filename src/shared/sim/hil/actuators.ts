import { TICK_RATE } from './types'
import type { ActuatorPort, ActuatorSpec, HarnessConfig } from './types'

/**
 * Banco de actuadores del HIL virtual: la ECU manda un valor de consigna
 * (duty, avance…) y el efecto llega con un DeadTime dependiente de la
 * TENSIÓN DE BATERÍA REAL:  dead(V) = baseMs + k / (V − vMin).
 *
 * El retardo se recalcula CADA TICK con la tensión del momento (arranque,
 * caídas, ruido eléctrico) sobre un ring preasignado — si la batería cae,
 * las consignas viejas tardan más en salir del tubo. Con V ≤ vMin el
 * actuador ni abre (effective = 0). Cero asignaciones fuera del constructor.
 */

/** Tamaño del ring: cubre el peor DeadTime razonable (~400 ms). */
const RING_TICKS = 96

class Actuator implements ActuatorPort {
  readonly spec: ActuatorSpec
  private readonly ring = new Float32Array(RING_TICKS)
  private cursor = 0
  private commanded = 0
  private out = 0

  constructor(spec: ActuatorSpec) {
    this.spec = spec
  }

  command(value: number): void {
    this.commanded = value
  }

  get effective(): number {
    return this.out
  }

  /** Avanza un tick con la tensión de alimentación REAL del momento. */
  step(volts: number): void {
    this.ring[this.cursor] = this.commanded
    const d = this.spec.deadTime
    if (volts <= d.vMin + 0.05) {
      // sin tensión útil el actuador no responde
      this.out = 0
      this.cursor = (this.cursor + 1) % RING_TICKS
      return
    }
    const deadMs = d.baseMs + d.k / (volts - d.vMin)
    let deadTicks = Math.round((deadMs / 1000) * TICK_RATE)
    if (deadTicks < 0) deadTicks = 0
    if (deadTicks > RING_TICKS - 1) deadTicks = RING_TICKS - 1
    const idx = (this.cursor - deadTicks + RING_TICKS) % RING_TICKS
    this.out = this.ring[idx]!
    this.cursor = (this.cursor + 1) % RING_TICKS
  }
}

export class ActuatorBank {
  private readonly list: Actuator[]
  private readonly byId: Map<string, Actuator>

  constructor(harness: HarnessConfig) {
    this.list = []
    this.byId = new Map()
    const seen = new Set<string>()
    for (const spec of harness.actuators) {
      if (seen.has(spec.id)) throw new Error(`Arnés inválido: actuador duplicado '${spec.id}'`)
      seen.add(spec.id)
      const a = new Actuator(spec)
      this.list.push(a)
      this.byId.set(spec.id, a)
    }
  }

  /** Avanza todos los actuadores con la tensión de batería real (verdad). */
  tick(batteryVolts: number): void {
    for (let i = 0; i < this.list.length; i++) this.list[i]!.step(batteryVolts)
  }

  actuator(id: string): ActuatorPort | null {
    return this.byId.get(id) ?? null
  }
}
