import { describe, expect, it } from 'vitest'
import { FUELS, defaultTune, resolveEngine, simulateOperatingPoint, stockEngine } from '../index'
import { buildArchetype } from './archetype'
import { SimCore } from './engineCore'
import type { CoreConfig } from './engineCore'
import { TICK_DT } from './types'

const g95 = FUELS.gasolina95!

function stockConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  const engine = resolveEngine(stockEngine())
  const arch = buildArchetype({
    geometry: engine.geometry,
    reciprocatingMass: engine.assembly.piston.spec.mass + 0.16,
    rotatingMassPerCyl: 0.35
  })
  return {
    geometry: engine.geometry,
    archetype: arch,
    veCurve: engine.assembly.head.spec.veCurve,
    fuel: { stoichAFR: g95.stoichAFR, lhv: g95.lhv },
    injectorFlow: engine.assembly.injector.spec.staticFlow,
    injectorDutyMax: 0.85,
    turbo: { inertia: 3e-5, present: false },
    ambientP: 101325,
    ambientT: 298,
    humidity: 0.4,
    ...overrides
  }
}

/** Duty speed-density para un λ objetivo (lo que haría una ECU calibrada). */
function dutyFor(core: SimCore, lambda: number): number {
  const rpm = Math.max(core.rpm, 500)
  const cycleTime = 120 / rpm
  const mAir = 0.9 * (core.manifoldP / (287 * 300)) * 5.0e-4
  const mFuel = mAir / (14.7 * lambda)
  return Math.min(mFuel / (3.85e-3 * cycleTime), 0.85)
}

/** Arranca y estabiliza el núcleo en un punto (rpm objetivo vía par de carga PI). */
function settleAt(core: SimCore, targetRpm: number, throttle: number, seconds: number): void {
  core.inputs.ignition = true
  core.inputs.throttle = throttle
  core.inputs.sparkAdvance = 0.38
  let load = 0
  const ticks = Math.round(seconds / TICK_DT)
  for (let t = 0; t < ticks; t++) {
    core.inputs.starter = core.rpm < 350
    core.inputs.injDuty = dutyFor(core, 0.88)
    // freno de banco PI: mantiene el régimen objetivo absorbiendo el par
    const err = core.rpm - targetRpm
    load += err * 0.002
    if (load < 0) load = 0
    if (load > 900) load = 900
    core.inputs.loadTorque = load + err * 0.15
    core.tick(TICK_DT)
  }
}

describe('HIL fase 2: núcleo de primeros principios', () => {
  it('arranca con el motor de arranque y se sostiene solo, sin curva de par', () => {
    const core = new SimCore(stockConfig())
    core.inputs.ignition = true
    core.inputs.throttle = 0 // solo el bypass de ralentí de la mariposa
    core.inputs.sparkAdvance = 0.18
    for (let t = 0; t < Math.round(5 / TICK_DT); t++) {
      core.inputs.starter = core.rpm < 350 && t < Math.round(2 / TICK_DT)
      core.inputs.injDuty = dutyFor(core, 1.0)
      core.tick(TICK_DT)
    }
    // autosostenido tras soltar el arranque, en régimen de ralentí plausible
    // (sin gobernador ECU todavía: eso llega en Fase 3)
    expect(core.rpm).toBeGreaterThan(500)
    expect(core.rpm).toBeLessThan(4500)
    // el colector está en depresión (mariposa casi cerrada): bombeo real
    expect(core.manifoldP).toBeLessThan(0.75e5)
  })

  it('puente de calibración: par a 4000 rpm WOT del orden del dyno clásico', () => {
    const engine = resolveEngine(stockEngine())
    const reference = simulateOperatingPoint(engine, defaultTune(), g95, 4000)
    const core = new SimCore(stockConfig())
    settleAt(core, 4000, 1, 6)
    expect(core.rpm).toBeGreaterThan(3600)
    expect(core.rpm).toBeLessThan(4400)
    // modelos distintos (ciclo cuasi-estático vs EDO tick a tick):
    // exigimos mismo orden de magnitud, ±40%
    const torque = core.meanTorque + core.inputs.loadTorque * 0 + 0
    expect(torque + core.inputs.loadTorque).toBeGreaterThan(reference.torque * 0.6)
    expect(torque + core.inputs.loadTorque).toBeLessThan(reference.torque * 1.4)
    // presión pico de cámara físicamente razonable
    expect(core.peakPressure).toBeGreaterThan(25e5)
    expect(core.peakPressure).toBeLessThan(120e5)
  })

  it('freno motor: con mariposa cerrada el par medio es negativo (emergente)', () => {
    const core = new SimCore(stockConfig())
    settleAt(core, 4000, 1, 5)
    core.inputs.throttle = 0
    core.inputs.fuelCut = true
    core.inputs.loadTorque = 0
    let sum = 0
    let count = 0
    for (let t = 0; t < Math.round(1.5 / TICK_DT); t++) {
      core.tick(TICK_DT)
      if (t > 60) {
        sum += core.meanTorque
        count++
      }
    }
    expect(sum / count).toBeLessThan(0)
    // y el régimen cae solo
    expect(core.rpm).toBeLessThan(3600)
  })

  it('agnosticismo: un V8 construido de la misma geometría gira con 8 encendidos equiespaciados', () => {
    const engine = resolveEngine(stockEngine())
    const v8geo = { ...engine.geometry, cylinders: 8, displacement: engine.geometry.displacement * 2 }
    const arch = buildArchetype({
      geometry: v8geo,
      reciprocatingMass: 0.55,
      rotatingMassPerCyl: 0.35,
      bankAngle: (90 * Math.PI) / 180
    })
    // fases equiespaciadas sobre 4π
    const phases = Array.from(arch.cyclePhase).sort((a, b) => a - b)
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]! - phases[i - 1]!).toBeCloseTo((4 * Math.PI) / 8, 6)
    }
    const core = new SimCore(stockConfig({ geometry: v8geo, archetype: arch }))
    settleAt(core, 3000, 0.6, 4)
    expect(core.rpm).toBeGreaterThan(2400)
    expect(core.rpm).toBeLessThan(3600)
    expect(Number.isFinite(core.meanTorque)).toBe(true)
  })

  it('turbo rotor: el boost emerge de la integración y el spool crece monótono con I (>5%)', () => {
    const spoolTime = (inertia: number): number => {
      const core = new SimCore(stockConfig({ turbo: { inertia, present: true } }))
      // experimento limpio: asentar a 3500 WOT con la WASTEGATE ABIERTA
      // (el rotor queda abajo sea cual sea I), luego cerrarla y cronometrar
      core.inputs.wastegate = 1
      settleAt(core, 3500, 1, 5)
      core.inputs.wastegate = 0
      let t = 0
      while (core.boost < 0.25e5 && t < 12) {
        const err = core.rpm - 3500
        core.inputs.loadTorque = Math.max(0, core.inputs.loadTorque + err * 0.002)
        // la ECU seguiría alimentando según el aire real: sin más gasolina
        // no hay más energía de turbina
        core.inputs.injDuty = dutyFor(core, 0.88)
        core.tick(TICK_DT)
        t += TICK_DT
      }
      return t
    }
    const t1 = spoolTime(2e-5)
    const t2 = spoolTime(6e-5)
    const t3 = spoolTime(18e-5)
    expect(t1).toBeLessThan(12)
    expect(t2).toBeGreaterThan(t1 * 1.05)
    expect(t3).toBeGreaterThan(t2 * 1.05)
  })

  it('Vogel: el aceite frío multiplica la fricción (más par absorbido en frío)', () => {
    const drag = (blockTemp: number): number => {
      const core = new SimCore(stockConfig({ ambientT: blockTemp }))
      // motor arrastrado (sin encendido) a 3000 rpm por el freno: par de carga = fricción
      core.inputs.ignition = false
      core.inputs.fuelCut = true
      const omega = (3000 * 2 * Math.PI) / 60
      core.scalars[4 /* no usado */] = 0
      // fuerza el régimen con el starter apagado y carga negativa (motor eléctrico)
      let motoring = 0
      for (let t = 0; t < Math.round(3 / TICK_DT); t++) {
        const err = core.omega - omega
        motoring += err * 0.01
        core.inputs.loadTorque = motoring + err * 0.3
        core.tick(TICK_DT)
      }
      return -core.inputs.loadTorque // par que hay que APORTAR para arrastrarlo
    }
    const cold = drag(276) // 3 °C
    const hot = drag(363) // 90 °C
    expect(cold).toBeGreaterThan(hot * 1.15)
  })

  it('heat soak: al apagar en caliente, la IAT sube antes de enfriarse', () => {
    const core = new SimCore(stockConfig())
    settleAt(core, 5000, 1, 45) // el bloque calienta a ritmo real (~0.7 K/s)
    const blockHot = core.blockTemp
    expect(blockHot).toBeGreaterThan(310)
    const iatRunning = core.intakeAirT
    // apagado: sin encendido, sin flujo
    core.inputs.ignition = false
    core.inputs.fuelCut = true
    core.inputs.throttle = 0
    core.inputs.loadTorque = 0
    let iatMax = iatRunning
    for (let t = 0; t < Math.round(30 / TICK_DT); t++) {
      core.tick(TICK_DT)
      if (core.intakeAirT > iatMax) iatMax = core.intakeAirT
    }
    expect(iatMax).toBeGreaterThan(iatRunning + 2) // el bloque cuece la admisión
  })

  it('determinismo: dos ejecuciones idénticas producen el mismo estado', () => {
    const run = (): number => {
      const core = new SimCore(stockConfig())
      settleAt(core, 4500, 0.8, 3)
      return core.omega + core.manifoldP + core.blockTemp + core.peakPressure
    }
    expect(run()).toBe(run())
  })
})
