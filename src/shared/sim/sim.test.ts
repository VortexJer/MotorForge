import { describe, expect, it } from 'vitest'
import {
  FUELS,
  defaultTune,
  partById,
  resolveEngine,
  runDyno,
  simulateOperatingPoint,
  stockEngine
} from './index'
import type { EngineAssembly, RodPart, Tune } from './types'

const fuel = FUELS.gasolina95!

function turboForgedEngine(): EngineAssembly {
  return {
    ...stockEngine(),
    block: partById('block-iron-2.0'),
    crank: partById('crank-forged-86'),
    rod: partById('rod-forged-139'),
    piston: partById('piston-forged-86'),
    injector: partById('inj-1000'),
    aspiration: partById('asp-turbo-gt35')
  }
}

describe('ensamblaje', () => {
  it('resuelve la geometría de un 2.0 de serie con CR plausible', () => {
    const engine = resolveEngine(stockEngine())
    expect(engine.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    expect(engine.geometry.displacement).toBeGreaterThan(1.95e-3)
    expect(engine.geometry.displacement).toBeLessThan(2.05e-3)
    expect(engine.geometry.compressionRatio).toBeGreaterThan(10)
    expect(engine.geometry.compressionRatio).toBeLessThan(13)
  })

  it('detecta interferencia pistón-culata con una biela demasiado larga', () => {
    const longRod: RodPart = {
      ...partById<RodPart>('rod-stock-139'),
      spec: { length: 0.146, mass: 0.57 }
    }
    const engine = resolveEngine({ ...stockEngine(), rod: longRod })
    expect(engine.issues.some((i) => i.severity === 'error')).toBe(true)
    expect(() => runDyno(engine, defaultTune(), fuel)).toThrow(/no es montable/)
  })

  it('la relación de compresión emerge de las piezas: menos cámara ⇒ más CR', () => {
    const base = resolveEngine(stockEngine())
    const smallChamber = resolveEngine({ ...stockEngine(), head: partById('head-race-40') })
    expect(smallChamber.geometry.compressionRatio).toBeGreaterThan(base.geometry.compressionRatio)
  })
})

describe('motor atmosférico de serie', () => {
  const engine = resolveEngine(stockEngine())
  const result = runDyno(engine, defaultTune(), fuel)

  it('no rompe dentro de su corte de serie', () => {
    expect(result.failedAtRpm).toBeNull()
  })

  it('produce par y potencia en bandas plausibles para un 2.0 deportivo', () => {
    expect(result.peakTorque.torque).toBeGreaterThan(140)
    expect(result.peakTorque.torque).toBeLessThan(230)
    // 1 CV = 735.5 W
    const cv = result.peakPower.power / 735.5
    expect(cv).toBeGreaterThan(130)
    expect(cv).toBeLessThan(250)
    // La potencia pica más arriba que el par
    expect(result.peakPower.rpm).toBeGreaterThan(result.peakTorque.rpm)
  })

  it('presión pico y consumo específico plausibles', () => {
    const atPeakTorque = result.points.find((p) => p.rpm === result.peakTorque.rpm)!
    expect(atPeakTorque.peakPressure).toBeGreaterThan(50e5)
    expect(atPeakTorque.peakPressure).toBeLessThan(120e5)
    const bsfcGkWh = atPeakTorque.bsfc * 3.6e9 // kg/J → g/kWh
    expect(bsfcGkWh).toBeGreaterThan(220)
    expect(bsfcGkWh).toBeLessThan(400)
  })

  it('es determinista: misma entrada ⇒ mismo resultado', () => {
    const again = runDyno(resolveEngine(stockEngine()), defaultTune(), fuel)
    expect(JSON.stringify(again)).toBe(JSON.stringify(result))
  })
})

describe('relaciones causa-efecto', () => {
  const engine = resolveEngine(turboForgedEngine())
  const tune: Tune = { ...defaultTune(), boostTarget: 0.8e5, revLimit: 8000 }

  it('más boost ⇒ más par y más presión pico', () => {
    const low = simulateOperatingPoint(engine, { ...tune, boostTarget: 0.5e5 }, fuel, 5500)
    const high = simulateOperatingPoint(engine, { ...tune, boostTarget: 1.0e5 }, fuel, 5500)
    expect(high.torque).toBeGreaterThan(low.torque * 1.15)
    expect(high.peakPressure).toBeGreaterThan(low.peakPressure)
  })

  it('retrasar el encendido ⇒ menos par y escape más caliente', () => {
    const base = simulateOperatingPoint(engine, tune, fuel, 5500)
    const retarded = simulateOperatingPoint(engine, { ...tune, sparkTrim: -8 }, fuel, 5500)
    expect(retarded.torque).toBeLessThan(base.torque)
    expect(retarded.exhaustTemp).toBeGreaterThan(base.exhaustTemp)
  })

  it('inyectores pequeños con turbo ⇒ mezcla pobre y escape más caliente', () => {
    const small = resolveEngine({ ...turboForgedEngine(), injector: partById('inj-310') })
    const big = engine
    const pSmall = simulateOperatingPoint(small, tune, fuel, 6500)
    const pBig = simulateOperatingPoint(big, tune, fuel, 6500)
    expect(pSmall.lambdaActual).toBeGreaterThan(tune.lambda + 0.05)
    expect(pSmall.exhaustTemp).toBeGreaterThan(pBig.exhaustTemp)
  })
})

describe('fallos explicables', () => {
  it('turbo con internos de serie a mucho boost ⇒ rompe con causa encadenada', () => {
    const engine = resolveEngine({
      ...stockEngine(),
      aspiration: partById('asp-turbo-gt35'),
      injector: partById('inj-1000')
    })
    const result = runDyno(engine, { ...defaultTune(), boostTarget: 1.4e5, revLimit: 8000 }, fuel)

    expect(result.failedAtRpm).not.toBeNull()
    const failure = result.events.find((e) => e.severity === 'failure')!
    expect(failure).toBeDefined()
    // Cede un interno de serie por presión: biela, pistón o bloque
    expect(['rodCompression', 'peakCylinderPressure']).toContain(failure.variable)
    // La cadena causal menciona el boost como origen
    expect(failure.causeChain.join(' ')).toMatch(/boost/)
    // Y registra el rendimiento que tenía justo antes de romper
    expect(failure.state.power).toBeGreaterThan(0)
  })

  it('subir el corte por encima del límite del cigüeñal de serie ⇒ rotura por fatiga', () => {
    const engine = resolveEngine(stockEngine())
    const result = runDyno(engine, { ...defaultTune(), revLimit: 9000 }, fuel)
    expect(result.failedAtRpm).not.toBeNull()
    const failure = result.events.find((e) => e.severity === 'failure')!
    expect(failure.variable).toBe('rpm')
    expect(failure.partId).toBe('crank-cast-86')
  })

  it('el mismo motor con cigüeñal y bielas forjados aguanta ese régimen', () => {
    const engine = resolveEngine({
      ...stockEngine(),
      crank: partById('crank-forged-86'),
      rod: partById('rod-forged-139')
    })
    const result = runDyno(engine, { ...defaultTune(), revLimit: 9000 }, fuel)
    const structural = result.events.filter(
      (e) => e.severity === 'failure' && (e.variable === 'rpm' || e.variable === 'rodTension')
    )
    expect(structural).toHaveLength(0)
  })
})
