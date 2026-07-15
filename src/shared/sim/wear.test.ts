import { describe, expect, it } from 'vitest'
import { FUELS, defaultTune, partById, resolveEngine, runEndurance, stockEngine } from './index'
import type { Tune } from './types'

const g95 = FUELS.gasolina95!
const e85 = FUELS.e85!

describe('banco de resistencia', () => {
  it('uso suave: el motor de serie aguanta 30 minutos casi sin daño', () => {
    const engine = resolveEngine(stockEngine())
    const r = runEndurance(engine, defaultTune(), g95, { minutes: 30, style: 'suave' })
    expect(r.failedAtMinute).toBeNull()
    expect(r.finalWear.rodFatigue).toBeLessThan(0.05)
    expect(r.finalWear.ringsWear).toBeLessThan(0.2)
    expect(r.torqueLossFraction).toBeLessThan(0.03)
  })

  it('al límite: aguanta el dyno pero la fatiga lo mata en menos de una hora', () => {
    const engine = resolveEngine(stockEngine())
    // El dyno a 8200 no rompe (fase 1), pero una hora clavado al corte sí
    const r = runEndurance(engine, defaultTune(), g95, { minutes: 60, style: 'limite' })
    expect(r.failedAtMinute).not.toBeNull()
    expect(r.failedAtMinute!).toBeGreaterThan(5)
    const failure = r.events.find((e) => e.severity === 'failure')!
    expect(failure.failureMode).toMatch(/fatiga/i)
    expect(failure.causeChain.join(' ')).toMatch(/Miner|régimen/)
  })

  it('picado sostenido: turbo con 95 revienta el ringland en minutos; con E85 sobrevive', () => {
    const engine = resolveEngine({
      ...stockEngine(),
      injector: partById('inj-1000'),
      fuelPump: partById('pump-255'),
      aspiration: partById('asp-turbo-gt35')
    })
    const tune: Tune = { ...defaultTune(), boostTarget: 1.2e5, revLimit: 7000 }

    const r95 = runEndurance(engine, tune, g95, { minutes: 10, style: 'deportivo' })
    expect(r95.failedAtMinute).not.toBeNull()
    expect(r95.failedAtMinute!).toBeLessThan(8)
    expect(r95.events[0]!.failureMode).toMatch(/ringland/i)

    const rE85 = runEndurance(engine, tune, e85, { minutes: 10, style: 'deportivo' })
    const ringland = rE85.events.find((e) => e.failureMode.match(/ringland/i))
    expect(ringland).toBeUndefined()
  })

  it('el desgaste de segmentos roba par de forma progresiva y monótona', () => {
    const engine = resolveEngine(stockEngine())
    const r = runEndurance(engine, defaultTune(), g95, { minutes: 120, style: 'deportivo' })
    const torques = r.samples.map((s) => s.torqueRef)
    for (let i = 1; i < torques.length; i++) expect(torques[i]!).toBeLessThanOrEqual(torques[i - 1]!)
    const wears = r.samples.map((s) => s.wear.ringsWear)
    expect(wears[wears.length - 1]!).toBeGreaterThan(wears[0]!)
  })

  it('es determinista', () => {
    const engine = resolveEngine(stockEngine())
    const a = runEndurance(engine, defaultTune(), g95, { minutes: 20, style: 'deportivo' })
    const b = runEndurance(engine, defaultTune(), g95, { minutes: 20, style: 'deportivo' })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
