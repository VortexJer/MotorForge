import { describe, expect, it } from 'vitest'
import {
  FUELS,
  defaultTune,
  partById,
  resolveEngine,
  runEndurance,
  simulateOperatingPoint,
  stockEngine
} from './index'

const g95 = FUELS.gasolina95!

describe('fase 5: refrigeración y desgaste persistente', () => {
  it('la refrigeración de competición baja corona y escape', () => {
    const stock = resolveEngine(stockEngine())
    const race = resolveEngine({ ...stockEngine(), cooling: partById('cool-race') })
    const tune = defaultTune()

    const pStock = simulateOperatingPoint(stock, tune, g95, 6000)
    const pRace = simulateOperatingPoint(race, tune, g95, 6000)

    expect(pRace.crownTemp).toBeLessThan(pStock.crownTemp - 20)
    expect(pRace.exhaustTemp).toBeLessThan(pStock.exhaustTemp - 10)
    // el par apenas cambia: refrigerar no da potencia, da margen
    expect(Math.abs(pRace.torque - pStock.torque) / pStock.torque).toBeLessThan(0.02)
  })

  it('el enfriador de aceite frena el daño de cojinetes', () => {
    const stock = resolveEngine(stockEngine())
    const race = resolveEngine({ ...stockEngine(), cooling: partById('cool-race') })
    const tune = defaultTune()

    const a = runEndurance(stock, tune, g95, { minutes: 60, style: 'deportivo' })
    const b = runEndurance(race, tune, g95, { minutes: 60, style: 'deportivo' })
    expect(b.finalWear.bearings).toBeLessThan(a.finalWear.bearings * 0.6)
  })

  it('el desgaste se acumula entre tandas: dos de 30 ≈ una de 60', () => {
    const engine = resolveEngine(stockEngine())
    const tune = defaultTune()

    const long = runEndurance(engine, tune, g95, { minutes: 60, style: 'limite' })
    expect(long.failedAtMinute).not.toBeNull()

    const first = runEndurance(engine, tune, g95, { minutes: 30, style: 'limite' })
    if (first.failedAtMinute !== null) {
      expect(first.failedAtMinute).toBe(long.failedAtMinute)
      return
    }
    const second = runEndurance(engine, tune, g95, {
      minutes: 30,
      style: 'limite',
      initialWear: first.finalWear
    })
    expect(second.failedAtMinute).not.toBeNull()
    expect(30 + second.failedAtMinute!).toBe(long.failedAtMinute)
  })

  it('un motor usado rinde menos: la tanda arranca con pérdida de par', () => {
    const engine = resolveEngine(stockEngine())
    const tune = defaultTune()
    const first = runEndurance(engine, tune, g95, { minutes: 120, style: 'deportivo' })
    const second = runEndurance(engine, tune, g95, {
      minutes: 15,
      style: 'deportivo',
      initialWear: first.finalWear
    })
    expect(second.samples[0]!.torqueRef).toBeLessThan(first.samples[0]!.torqueRef)
    expect(second.torqueLossFraction).toBeGreaterThan(0)
  })
})
