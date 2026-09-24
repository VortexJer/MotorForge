import { describe, it, expect } from 'vitest'
import { buildDesign, defaultDesign, architectureLabel, bankAngleRad } from './designer'
import type { EngineDesign } from './designer'
import { resolveEngine } from './assembly'
import { buildArchetype } from './hil/archetype'
import { SimLoop } from './hil/simLoop'
import { TICK_DT, defaultHarness } from './hil/types'
import { FUELS } from './index'

const g95 = FUELS.gasolina95!

describe('Diseñador — calibración contra el catálogo', () => {
  it('el motor de serie reproduce los números del catálogo', () => {
    const d = defaultDesign() // 86 × 86, biela 139, cigüeñal forjado
    const { assembly, summary } = buildDesign(d)

    expect(summary.rodLength).toBeCloseTo(0.139, 4)
    expect(summary.deckHeight).toBeCloseTo(0.212, 4)
    // El catálogo da 10200 rpm al cigüeñal forjado de 86 mm; la ley de velocidad
    // media de pistón tiene que devolver ese mismo número, no uno parecido.
    expect(summary.rpmLimit).toBeCloseTo(10200, 0)
    expect(assembly.rod.spec.mass).toBeCloseTo(0.57, 3)
    expect(assembly.piston.spec.mass).toBeCloseTo(0.4, 3)
    expect(assembly.piston.spec.compressionHeight).toBeCloseTo(0.03, 4)
  })

  it('la relación de compresión que pides es la que sale al resolver', () => {
    for (const cr of [8, 9.5, 10.5, 12, 13.5]) {
      const d: EngineDesign = { ...defaultDesign(), compressionRatio: cr }
      const { assembly } = buildDesign(d)
      const resuelto = resolveEngine(assembly)
      // Es una inversión exacta de la fórmula de assembly.ts, no un ajuste.
      expect(resuelto.geometry.compressionRatio).toBeCloseTo(cr, 3)
    }
  })

  it('un motor diseñado no arrastra errores de compatibilidad', () => {
    const { assembly } = buildDesign(defaultDesign())
    const errores = resolveEngine(assembly).issues.filter((i) => i.severity === 'error')
    expect(errores).toEqual([])
  })
})

describe('Diseñador — las leyes de escalado se notan', () => {
  it('más carrera, menos vueltas (velocidad media de pistón constante)', () => {
    const corto = buildDesign({ ...defaultDesign(), stroke: 0.07 })
    const largo = buildDesign({ ...defaultDesign(), stroke: 0.1 })
    expect(corto.summary.rpmLimit).toBeGreaterThan(largo.summary.rpmLimit)
    // Y la velocidad media en el límite tiene que ser LA MISMA: es el invariante.
    expect(corto.summary.meanPistonSpeedAtLimit).toBeCloseTo(
      largo.summary.meanPistonSpeedAtLimit, 3
    )
  })

  it('una biela más larga pandea antes (Euler: carga crítica ∝ 1/L²)', () => {
    const corta = buildDesign({ ...defaultDesign(), rodRatio: 1.5 })
    const larga = buildDesign({ ...defaultDesign(), rodRatio: 1.9 })
    const lim = (r: ReturnType<typeof buildDesign>): number =>
      r.assembly.rod.limits.find((l) => l.variable === 'rodCompression')!.value
    expect(lim(corta)).toBeGreaterThan(lim(larga))
  })

  it('el pistón engorda con el cubo del calibre', () => {
    const a = buildDesign({ ...defaultDesign(), bore: 0.086 })
    const b = buildDesign({ ...defaultDesign(), bore: 0.172 }) // el doble
    expect(b.assembly.piston.spec.mass / a.assembly.piston.spec.mass).toBeCloseTo(8, 1)
  })

  it('un motor muy supercuadrado pierde presión admisible en el bloque', () => {
    const cuadrado = buildDesign({ ...defaultDesign(), bore: 0.086, stroke: 0.086 })
    const super2 = buildDesign({ ...defaultDesign(), bore: 0.1, stroke: 0.06 })
    const p = (r: ReturnType<typeof buildDesign>): number =>
      r.assembly.block.limits.find((l) => l.variable === 'peakCylinderPressure')!.value
    expect(p(super2)).toBeLessThan(p(cuadrado))
  })

  it('cada límite explica de dónde sale', () => {
    const { assembly } = buildDesign(defaultDesign())
    const todos = [
      ...assembly.block.limits, ...assembly.crank.limits,
      ...assembly.rod.limits, ...assembly.piston.limits
    ]
    for (const l of todos) {
      expect(l.provenance).toBe('derived-analytic')
      expect(l.explanation.length).toBeGreaterThan(30)
      expect(l.failureMode.length).toBeGreaterThan(5)
    }
  })
})

describe('Diseñador — avisos', () => {
  it('avisa cuando la cámara ya no da para meter las válvulas', () => {
    // A 45:1 la cámara aún es positiva, pero la junta se come un tercio del
    // volumen muerto: el motor no se puede fabricar aunque los números cuadren.
    const { warnings } = buildDesign({ ...defaultDesign(), compressionRatio: 45 })
    expect(warnings.join(' ')).toMatch(/no se puede fabricar/)
  })

  it('avisa si la cámara sale directamente negativa', () => {
    const { warnings } = buildDesign({ ...defaultDesign(), compressionRatio: 150 })
    expect(warnings.join(' ')).toMatch(/cámara sale negativa/)
  })

  it('no avisa de la cámara en compresiones normales', () => {
    for (const cr of [9, 10.5, 12, 14]) {
      const { warnings } = buildDesign({ ...defaultDesign(), compressionRatio: cr })
      expect(warnings.join(' '), `CR ${cr}`).not.toMatch(/cámara|fabricar/)
    }
  })

  it('avisa de relaciones biela/carrera extremas', () => {
    expect(buildDesign({ ...defaultDesign(), rodRatio: 1.3 }).warnings.join(' ')).toMatch(/muy corta/)
    expect(buildDesign({ ...defaultDesign(), rodRatio: 2.1 }).warnings.join(' ')).toMatch(/muy larga/)
  })

  it('avisa de un V con cilindros impares', () => {
    const { warnings } = buildDesign({ ...defaultDesign(), layout: 'v', cylinders: 5 })
    expect(warnings.join(' ')).toMatch(/descompensado/)
  })
})

describe('Diseñador — arquitecturas', () => {
  it('nombra y angula cada disposición', () => {
    const v8: EngineDesign = { ...defaultDesign(), layout: 'v', cylinders: 8, bankAngleDeg: 90 }
    expect(architectureLabel(v8)).toBe('V8')
    expect(bankAngleRad(v8)).toBeCloseTo(Math.PI / 2, 6)
    expect(architectureLabel({ ...defaultDesign(), cylinders: 6 })).toBe('L6')
    const boxer = { ...defaultDesign(), layout: 'boxer' as const, cylinders: 4 }
    expect(architectureLabel(boxer)).toBe('B4')
    expect(bankAngleRad(boxer)).toBeCloseTo(Math.PI, 6)
  })

  it('la cilindrada sale de la geometría, no de una tabla', () => {
    // V8 de 4.0: 8 cilindros de 500 cc → calibre 92, carrera 75.2
    const v8 = buildDesign({
      ...defaultDesign(), layout: 'v', cylinders: 8, bore: 0.092, stroke: 0.0752
    })
    expect(v8.summary.displacementL).toBeCloseTo(4.0, 1)
    expect(v8.summary.architecture).toBe('V8')
  })

  it.each([1, 2, 3, 4, 5, 6, 8, 10, 12, 16])('un %i cilindros se construye y resuelve', (n) => {
    const { assembly } = buildDesign({ ...defaultDesign(), cylinders: n })
    const r = resolveEngine(assembly)
    expect(r.geometry.cylinders).toBe(n)
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([])
    // Y el arquetipo tiene que saber encenderlos a todos, sin repetir ninguno.
    const arq = buildArchetype({
      geometry: r.geometry, reciprocatingMass: 0.5, rotatingMassPerCyl: 0.35
    })
    expect(new Set(Array.from(arq.firingOrder)).size).toBe(n)
  })
})

describe('Diseñador — el motor diseñado FUNCIONA de verdad', () => {
  it('un V8 diseñado a mano arranca y gira en el HIL', () => {
    const d: EngineDesign = {
      ...defaultDesign(),
      name: 'V8 de prueba',
      layout: 'v', cylinders: 8, bankAngleDeg: 90,
      bore: 0.092, stroke: 0.0752, compressionRatio: 10.5,
      blockMaterial: 'fundicion', crankType: 'forjado'
    }
    const { assembly, summary } = buildDesign(d)
    const e = resolveEngine(assembly)
    expect(e.issues.filter((i) => i.severity === 'error')).toEqual([])

    const loop = new SimLoop(
      {
        geometry: e.geometry,
        archetype: buildArchetype({
          geometry: e.geometry,
          reciprocatingMass: assembly.piston.spec.mass + 0.16,
          rotatingMassPerCyl: 0.35,
          bankAngle: bankAngleRad(d)
        }),
        veCurve: assembly.head.spec.veCurve,
        fuel: { stoichAFR: g95.stoichAFR, lhv: g95.lhv },
        injectorFlow: assembly.injector.spec.staticFlow,
        injectorDutyMax: 0.85,
        turbo: { inertia: 6e-5, present: false },
        ambientP: 101325, ambientT: 298, humidity: 0.4
      },
      defaultHarness(7),
      {
        idleRpm: 900, revLimit: Math.round(summary.rpmLimit * 0.85), lambdaBase: 1,
        lambdaWotDrop: 0.14, advIdle: 0.17, advMax: 0.56, advAtRpm: 6500,
        veEst: assembly.head.spec.veCurve,
        injectorFlow: assembly.injector.spec.staticFlow, injectorDutyMax: 0.85,
        stoichAFR: g95.stoichAFR, boostTarget: 0
      }
    )
    loop.physical.ignitionKey = true
    for (let t = 0; t < Math.round(4 / TICK_DT); t++) {
      loop.physical.throttle = 0.5
      loop.tick(TICK_DT)
    }
    // Arrancó y está girando: el motor que acabas de diseñar es simulable.
    expect(loop.core.rpm).toBeGreaterThan(700)
    expect(Number.isFinite(loop.core.rpm)).toBe(true)
  })

  it('el mismo diseño da siempre el mismo motor (determinismo)', () => {
    const d = { ...defaultDesign(), cylinders: 6, bore: 0.084, stroke: 0.09 }
    const a = buildDesign(d)
    const b = buildDesign(d)
    expect(JSON.stringify(a.assembly)).toBe(JSON.stringify(b.assembly))
  })
})
