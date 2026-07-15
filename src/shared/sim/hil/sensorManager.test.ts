import { describe, expect, it } from 'vitest'
import { SensorManager } from './sensorManager'
import { TICK_DT, TICK_RATE, Tap, defaultHarness } from './types'
import type { HarnessConfig } from './types'

function harnessWith(sensor: Partial<HarnessConfig['sensors'][0]>, seed = 7): HarnessConfig {
  return {
    seed,
    actuators: [],
    sensors: [
      {
        id: 's',
        tap: Tap.ManifoldP,
        sampleRateHz: TICK_RATE,
        latencyMs: 0,
        noiseFloor: 0,
        failMode: 'none',
        ...sensor
      }
    ]
  }
}

describe('HIL fase 1: SensorManager', () => {
  it('latencia: la lectura es la verdad de hace latencyMs (rampa)', () => {
    const latencyMs = 50 // 12 ticks a 240 Hz
    const m = new SensorManager(harnessWith({ latencyMs }))
    const s = m.sensor('s')!
    // rampa determinista: verdad = nº de tick
    for (let t = 1; t <= 100; t++) {
      m.truth[Tap.ManifoldP] = t
      m.tick(TICK_DT)
    }
    const expectedDelayTicks = Math.ceil((latencyMs / 1000) * TICK_RATE)
    expect(s.read()).toBe(100 - expectedDelayTicks)
  })

  it('sampleRate: un sensor de 60 Hz solo actualiza cada 4 ticks', () => {
    const m = new SensorManager(harnessWith({ sampleRateHz: 60 }))
    const s = m.sensor('s')!
    let changes = 0
    let prev = s.read()
    for (let t = 1; t <= 240; t++) {
      m.truth[Tap.ManifoldP] = t
      m.tick(TICK_DT)
      if (s.read() !== prev) {
        changes++
        prev = s.read()
      }
    }
    // 1 segundo de sim a 60 Hz de muestreo → ~60 actualizaciones, no 240
    expect(changes).toBeGreaterThan(55)
    expect(changes).toBeLessThan(65)
  })

  it('ruido determinista: misma semilla ⇒ misma secuencia; otra semilla ⇒ distinta', () => {
    const run = (seed: number): number[] => {
      const m = new SensorManager(harnessWith({ noiseFloor: 100 }, seed))
      const s = m.sensor('s')!
      const out: number[] = []
      for (let t = 0; t < 50; t++) {
        m.truth[Tap.ManifoldP] = 1e5
        m.tick(TICK_DT)
        out.push(s.read())
      }
      return out
    }
    expect(run(42)).toEqual(run(42))
    expect(run(42)).not.toEqual(run(43))
  })

  it('el ruido respeta el NoiseFloor (σ medida ≈ σ pedida)', () => {
    const sigma = 500
    const m = new SensorManager(harnessWith({ noiseFloor: sigma }))
    const s = m.sensor('s')!
    const samples: number[] = []
    for (let t = 0; t < 8000; t++) {
      m.truth[Tap.ManifoldP] = 1e5
      m.tick(TICK_DT)
      samples.push(s.read())
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const varSum = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length
    const measured = Math.sqrt(varSum)
    expect(mean).toBeGreaterThan(1e5 - sigma * 0.1)
    expect(mean).toBeLessThan(1e5 + sigma * 0.1)
    expect(measured).toBeGreaterThan(sigma * 0.8)
    expect(measured).toBeLessThan(sigma * 1.2)
  })

  it('ADC: las lecturas caen en la rejilla de cuantización', () => {
    const adc = { min: 0, max: 5, bits: 8 }
    const m = new SensorManager(harnessWith({ adc, tap: Tap.BatteryV }))
    const s = m.sensor('s')!
    const q = (adc.max - adc.min) / ((1 << adc.bits) - 1)
    for (let t = 0; t < 40; t++) {
      m.truth[Tap.BatteryV] = 1.234 + t * 0.05
      m.tick(TICK_DT)
      const steps = (s.read() - adc.min) / q
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-4)
    }
    // y satura al rango físico del conversor
    m.truth[Tap.BatteryV] = 99
    m.tick(TICK_DT)
    expect(s.read()).toBe(adc.max)
  })

  it('modos de fallo: stuck congela la primera muestra, open cae al mínimo', () => {
    const stuck = new SensorManager(harnessWith({ failMode: 'stuck' }))
    const sS = stuck.sensor('s')!
    stuck.truth[Tap.ManifoldP] = 5000
    stuck.tick(TICK_DT)
    const frozen = sS.read()
    for (let t = 0; t < 50; t++) {
      stuck.truth[Tap.ManifoldP] = 90000 + t
      stuck.tick(TICK_DT)
    }
    expect(sS.read()).toBe(frozen)

    const open = new SensorManager(harnessWith({ failMode: 'open', adc: { min: 2e4, max: 4e5, bits: 10 } }))
    const sO = open.sensor('s')!
    open.truth[Tap.ManifoldP] = 2.5e5
    open.tick(TICK_DT)
    expect(sO.read()).toBe(2e4)
  })

  it('cableado: ids resueltos, desconocidos a null, duplicados rechazados', () => {
    const m = new SensorManager(defaultHarness(1))
    expect(m.sensor('map')).not.toBeNull()
    expect(m.sensor('ckp')).not.toBeNull()
    expect(m.sensor('inventado')).toBeNull()
    expect(m.count).toBe(11)

    const dup = defaultHarness(1)
    dup.sensors.push({ ...dup.sensors[0]! })
    expect(() => new SensorManager(dup)).toThrow(/duplicado/)
  })

  it('arnés de serie: 10.000 ticks estables con las 10 señales cableadas', () => {
    const m = new SensorManager(defaultHarness(3))
    for (let t = 0; t < 10000; t++) {
      m.truth[Tap.CrankAngle] = t * 0.5
      m.truth[Tap.CrankOmega] = 600 + Math.sin(t * 0.01) * 50
      m.truth[Tap.ManifoldP] = 1e5 + Math.sin(t * 0.02) * 3e4
      m.truth[Tap.CoolantT] = 360
      m.truth[Tap.BatteryV] = 13.8
      m.tick(TICK_DT)
    }
    expect(m.sensor('map')!.read()).toBeGreaterThan(6e4)
    expect(m.sensor('vbatt')!.read()).toBeGreaterThan(13)
    expect(m.sensor('vbatt')!.read()).toBeLessThan(14.6)
  })
})
