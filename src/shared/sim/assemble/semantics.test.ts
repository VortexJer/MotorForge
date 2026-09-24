import { describe, it, expect } from 'vitest'
import { readSemantics } from './semantics'
import { MARKER } from './scene'
import type { EngineScene, Vec3, PartRole } from './scene'

const CIL = { corona: [0, 0, 0] as Vec3, eje: [0, 0, 1] as Vec3, calibre: 0.086 }

function esc(piezas: Array<[PartRole, string, Vec3, Vec3?]>): EngineScene {
  return {
    name: 't',
    parts: piezas.map(([role, mk, pos, dir], i) => ({
      id: `${role}${i}`, name: role, role,
      markers: [{ id: mk, position: pos, direction: dir }]
    }))
  }
}

describe('Semántica — el inyector', () => {
  it('dentro del cilindro es inyección directa y densifica la carga', () => {
    const r = readSemantics(esc([['injector', MARKER.injectorTip, [0.01, 0, 0.02]]]), CIL)
    expect(r.inyeccionDirecta).toBe(true)
    expect(r.factorLlenado).toBeGreaterThan(1)
    expect(r.efectos.join(' ')).toMatch(/DIRECTA/)
  })

  it('lejos del cilindro es indirecta y no enfría nada', () => {
    // A 20 cm de la corona: eso es el colector, no la cámara.
    const r = readSemantics(esc([['injector', MARKER.injectorTip, [0, 0, 0.2]]]), CIL)
    expect(r.inyeccionDirecta).toBe(false)
    expect(r.factorLlenado).toBe(1)
    expect(r.efectos.join(' ')).toMatch(/INDIRECTA/)
  })

  it('avisa si el chorro apunta al revés', () => {
    const r = readSemantics(
      esc([['injector', MARKER.injectorTip, [0.01, 0, 0.02], [0, 0, 1]]]), CIL)
    expect(r.avisos.join(' ')).toMatch(/apunta hacia la culata/)
  })
})

describe('Semántica — la bujía', () => {
  it('centrada no penaliza el avance', () => {
    const r = readSemantics(esc([['sparkPlug', MARKER.sparkGap, [0.002, 0, 0.01]]]), CIL)
    expect(r.factorAvance).toBe(1)
    expect(r.efectos.join(' ')).toMatch(/CENTRADA/)
  })

  it('descentrada recorta el avance admisible', () => {
    // A 25 mm del eje en un calibre de 86: casi un 30% fuera del centro.
    const r = readSemantics(esc([['sparkPlug', MARKER.sparkGap, [0.025, 0, 0.01]]]), CIL)
    expect(r.factorAvance).toBeLessThan(1)
    expect(r.recorridoLlama).toBeGreaterThan(0.5)
    expect(r.efectos.join(' ')).toMatch(/DESCENTRADA/)
  })

  it('en la pared avisa de que igual la marcaste mal', () => {
    const r = readSemantics(esc([['sparkPlug', MARKER.sparkGap, [0.043, 0, 0.01]]]), CIL)
    expect(r.avisos.join(' ')).toMatch(/pared del cilindro/)
  })

  it('cuanto más descentrada, menos avance: es monótono', () => {
    const f = (x: number): number =>
      readSemantics(esc([['sparkPlug', MARKER.sparkGap, [x, 0, 0.01]]]), CIL).factorAvance
    expect(f(0.005)).toBeGreaterThanOrEqual(f(0.02))
    expect(f(0.02)).toBeGreaterThan(f(0.035))
  })
})

describe('Semántica — el arranque', () => {
  const conCrank = (engrane: Vec3): EngineScene => ({
    name: 't',
    parts: [
      { id: 'c', name: 'crank', role: 'crank', markers: [
        { id: MARKER.crankAxisA, position: [-0.2, 0, 0] },
        { id: MARKER.crankAxisB, position: [0.2, 0, 0] }
      ] },
      { id: 's', name: 'st', role: 'starter', markers: [
        { id: MARKER.starterDrive, position: engrane }
      ] }
    ]
  })

  it('mide el radio de palanca desde el eje del cigüeñal', () => {
    const r = readSemantics(conCrank([0, 0.15, 0]), CIL)
    expect(r.radioArranque).toBeCloseTo(0.15, 4)
    expect(r.efectos.join(' ')).toMatch(/hace palanca/)
  })

  it('engranar pegado al eje se avisa', () => {
    const r = readSemantics(conCrank([0, 0.005, 0]), CIL)
    expect(r.avisos.join(' ')).toMatch(/demasiado cerca/)
  })
})

describe('Semántica — sin marcadores no inventa efectos', () => {
  it('escena vacía deja todo neutro', () => {
    const r = readSemantics({ name: 'v', parts: [] }, CIL)
    expect(r.factorLlenado).toBe(1)
    expect(r.factorAvance).toBe(1)
    expect(r.efectos).toEqual([])
  })
})
