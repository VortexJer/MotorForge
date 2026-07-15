import { describe, expect, it } from 'vitest'
import {
  FUELS,
  defaultTune,
  mapLookup,
  partById,
  resolveEngine,
  runDyno,
  runTransient,
  simulateOperatingPoint,
  stockEngine,
  withCell
} from './index'
import type { EngineAssembly, Tune } from './types'

const g95 = FUELS.gasolina95!
const g98 = FUELS.gasolina98!
const e85 = FUELS.e85!

function turboBuild(): EngineAssembly {
  return {
    ...stockEngine(),
    block: partById('block-iron-2.0'),
    crank: partById('crank-forged-86'),
    rod: partById('rod-forged-139'),
    piston: partById('piston-forged-86'),
    injector: partById('inj-1000'),
    fuelPump: partById('pump-255'),
    aspiration: partById('asp-turbo-gt35')
  }
}

describe('mapas ECU', () => {
  it('interpola bilinealmente y satura en los bordes', () => {
    const map = defaultTune().fuelMap
    // plena carga NA (100 kPa): λ 0.88; con 1 bar de boost (200 kPa): 0.82
    expect(mapLookup(map, 4000, 1.0e5)).toBeCloseTo(0.88, 2)
    expect(mapLookup(map, 4000, 2.0e5)).toBeCloseTo(0.82, 2)
    expect(mapLookup(map, 4000, 1.5e5)).toBeCloseTo(0.85, 2)
    // fuera de ejes: saturado, no extrapolado
    expect(mapLookup(map, 20000, 9e5)).toBeCloseTo(0.78, 2)
    expect(mapLookup(map, 100, 0)).toBeCloseTo(1.0, 2)
  })

  it('editar una celda del mapa cambia el punto que la usa', () => {
    const engine = resolveEngine(stockEngine())
    const tune = defaultTune()
    // celda 5000 rpm × 100 kPa (plena carga NA): índices [1][4]
    const richer: Tune = { ...tune, fuelMap: withCell(tune.fuelMap, 1, 4, 0.78) }
    const base = simulateOperatingPoint(engine, tune, g95, 5000)
    const rich = simulateOperatingPoint(engine, richer, g95, 5000)
    expect(rich.lambdaActual).toBeLessThan(base.lambdaActual - 0.05)
    expect(rich.exhaustTemp).toBeLessThan(base.exhaustTemp)
  })
})

describe('sistema de combustible', () => {
  it('con bomba adecuada el raíl aguanta la referencia de colector (3.5 bar + boost)', () => {
    const engine = resolveEngine(turboBuild())
    const tune: Tune = { ...defaultTune(), boostTarget: 1.0e5, revLimit: 7600 }
    const p = simulateOperatingPoint(engine, tune, g95, 6000)
    expect(p.fuelStarve).toBe('none')
    // referencia: 3.5 bar + ~1 bar de colector
    expect(p.railPressure).toBeGreaterThan(4.3e5)
    expect(p.railPressure).toBeLessThan(4.7e5)
    expect(p.lambdaActual).toBeCloseTo(p.lambdaTarget, 2)
  })

  it('la bomba de serie se queda corta con turbo: raíl caído, mezcla pobre y fallo con "bomba" en la cadena', () => {
    // Inyectores medianos: sin ΔP no pueden compensar subiendo duty
    const engine = resolveEngine({
      ...turboBuild(),
      injector: partById('inj-550'),
      fuelPump: partById('pump-stock-110')
    })
    const tune: Tune = { ...defaultTune(), boostTarget: 1.5e5, revLimit: 7600 }
    const p = simulateOperatingPoint(engine, tune, g95, 6500)
    expect(p.fuelStarve).toBe('pump')
    expect(p.railPressure).toBeLessThan(4.2e5)
    expect(p.lambdaActual).toBeGreaterThan(p.lambdaTarget + 0.05)

    const dyno = runDyno(engine, tune, g95)
    expect(dyno.failedAtRpm).not.toBeNull()
    const failure = dyno.events.find((e) => e.severity === 'failure')!
    expect(failure.causeChain.join(' ')).toMatch(/bomba/)
  })

  it('la misma configuración con doble bomba mantiene la mezcla', () => {
    const engine = resolveEngine({
      ...turboBuild(),
      injector: partById('inj-550'),
      fuelPump: partById('pump-dual-460')
    })
    const tune: Tune = { ...defaultTune(), boostTarget: 1.5e5, revLimit: 7600 }
    const p = simulateOperatingPoint(engine, tune, g95, 6500)
    expect(p.fuelStarve).not.toBe('pump')
    expect(p.railPressure).toBeGreaterThan(4.5e5)
  })
})

describe('detonación', () => {
  it('el motor de serie NA con 95 no pica', () => {
    const engine = resolveEngine(stockEngine())
    const dyno = runDyno(engine, defaultTune(), g95)
    expect(dyno.failedAtRpm).toBeNull()
    for (const p of dyno.points) expect(p.knockIndex).toBeLessThan(1)
  })

  it('adelantar mucho el encendido acerca el motor al picado; el 98 da margen', () => {
    const engine = resolveEngine(stockEngine())
    const advanced: Tune = { ...defaultTune(), sparkTrim: 6 }
    const p95 = simulateOperatingPoint(engine, advanced, g95, 2500)
    const p98 = simulateOperatingPoint(engine, advanced, g98, 2500)
    const base = simulateOperatingPoint(engine, defaultTune(), g95, 2500)
    expect(p95.knockIndex).toBeGreaterThan(base.knockIndex)
    expect(p98.knockIndex).toBeLessThan(p95.knockIndex)
  })

  it('turbo a 1.4 bar con RC de serie y 95 pica; con E85 no', () => {
    const engine = resolveEngine({
      ...stockEngine(),
      injector: partById('inj-1000'),
      fuelPump: partById('pump-255'),
      aspiration: partById('asp-turbo-gt35')
    })
    const tune: Tune = { ...defaultTune(), boostTarget: 1.4e5, revLimit: 7000 }
    const p95 = simulateOperatingPoint(engine, tune, g95, 5000)
    const pE85 = simulateOperatingPoint(engine, tune, e85, 5000)
    expect(p95.knockIndex).toBeGreaterThan(1)
    expect(pE85.knockIndex).toBeLessThan(0.97)

    const dyno = runDyno(engine, tune, g95)
    const knock = dyno.events.find((e) => e.variable === 'knockIndex')
    expect(knock).toBeDefined()
    expect(knock!.causeChain.join(' ')).toMatch(/RON/)
  })

  it('picar cuesta par y calienta la corona', () => {
    const engine = resolveEngine({
      ...stockEngine(),
      injector: partById('inj-1000'),
      fuelPump: partById('pump-255'),
      aspiration: partById('asp-turbo-gt35')
    })
    const tune: Tune = { ...defaultTune(), boostTarget: 1.4e5, revLimit: 7000 }
    const knocking = simulateOperatingPoint(engine, tune, g95, 5000)
    const clean = simulateOperatingPoint(engine, tune, e85, 5000)
    expect(knocking.knockIndex).toBeGreaterThan(1)
    expect(clean.crownTemp).toBeLessThan(knocking.crownTemp)
  })
})

describe('transitorios (pull)', () => {
  it('el boost llega con retraso: al principio del pull está lejos del estacionario', () => {
    const engine = resolveEngine(turboBuild())
    const tune: Tune = { ...defaultTune(), boostTarget: 1.0e5, revLimit: 7600 }
    const run = runTransient(engine, tune, g95, { startRpm: 3000 })
    expect(run.samples.length).toBeGreaterThan(10)
    // Lag: el boost real alcanza el 90% del objetivo claramente más tarde
    // que el estacionario de la curva de spool
    const tSteady = run.samples.find((s) => s.boostSteady >= 0.9e5)?.t
    const tReal = run.samples.find((s) => s.boost >= 0.9e5)?.t
    expect(tSteady).toBeDefined()
    expect(tReal).toBeDefined()
    expect(tReal!).toBeGreaterThan(tSteady! + 0.25)
    // Y al final del pull el boost ha alcanzado (casi) el objetivo
    const last = run.samples[run.samples.length - 1]!
    expect(last.boost).toBeGreaterThan(0.85e5)
  })

  it('un pull sano llega al corte y es determinista', () => {
    const engine = resolveEngine(turboBuild())
    const tune: Tune = { ...defaultTune(), boostTarget: 0.8e5, revLimit: 7600 }
    const a = runTransient(engine, tune, g95, { startRpm: 2500 })
    const b = runTransient(engine, tune, g95, { startRpm: 2500 })
    expect(a.timeToRevLimit).not.toBeNull()
    expect(a.failedAtTime).toBeNull()
    expect(a.timeToRevLimit).toBeGreaterThan(2)
    expect(a.timeToRevLimit).toBeLessThan(25)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('la inercia térmica retrasa el fallo: la corona tarda en llegar a su límite', () => {
    // Configuración que en estacionario rompe por corona: pistón fundido + boost
    const engine = resolveEngine({
      ...stockEngine(),
      block: partById('block-iron-2.0'),
      rod: partById('rod-forged-139'),
      injector: partById('inj-1000'),
      fuelPump: partById('pump-255'),
      aspiration: partById('asp-turbo-gt28')
    })
    const tune: Tune = { ...defaultTune(), boostTarget: 1.0e5, revLimit: 7600 }
    const run = runTransient(engine, tune, g95, { startRpm: 2000, inertia: 6 })
    if (run.failedAtTime !== null) {
      // Si rompe, no es instantáneo: la masa térmica compra segundos
      expect(run.failedAtTime).toBeGreaterThan(1)
      const failure = run.events.find((e) => e.severity === 'failure')!
      expect(failure.time).toBe(run.failedAtTime)
      expect(failure.causeChain[0]).toMatch(/pull/)
    } else {
      expect(run.timeToRevLimit).not.toBeNull()
    }
  })
})
