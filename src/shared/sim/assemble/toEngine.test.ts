import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { assembleEngine } from './toEngine'
import { MARKER } from './scene'
import type { EngineScene, ScenePart, Vec3, PartRole } from './scene'

const STL = join(process.cwd(), 'design', 'k20c1', 'out_final', 'stl')
const hay = existsSync(join(STL, 'head.stl'))

function leerStl(r: string): Float32Array {
  const b = readFileSync(r)
  const n = b.readUInt32LE(80)
  const p = new Float32Array(n * 9)
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12
    for (let v = 0; v < 9; v++) p[t * 9 + v] = b.readFloatLE(o + v * 4) * 0.001
  }
  return p
}

const D = { stroke: 85.9, rodLength: 139.0, crankZ: 120.0, deckZ: 332.0,
            cylinderX: [-141, -47, 47, 141], pinPhaseDeg: [0, 180, 180, 0] }
const mm = (v: number): number => v * 0.001
const thr = D.stroke / 2

function escena(opts: { conSemantica: boolean }): EngineScene {
  const piston = leerStl(join(STL, 'piston_1.stl'))
  const rod = leerStl(join(STL, 'conrod_1.stl'))
  const head = leerStl(join(STL, 'head.stl'))
  const parts: ScenePart[] = [{
    id: 'crank', name: 'crankshaft', role: 'crank', density: 7850,
    markers: [
      { id: MARKER.crankAxisA, position: [mm(-200), 0, mm(D.crankZ)] },
      { id: MARKER.crankAxisB, position: [mm(200), 0, mm(D.crankZ)] },
      ...D.cylinderX.map((_, i) => ({
        id: MARKER.crankPin(i),
        position: [mm(D.cylinderX[i]!), 0, mm(D.crankZ + (D.pinPhaseDeg[i] === 0 ? thr : -thr))] as Vec3
      }))
    ]
  }, {
    id: 'head', name: 'head.stl', role: 'head', mesh: { positions: head }, markers: []
  }]
  for (let i = 0; i < 4; i++) {
    const zPin = D.crankZ + (D.pinPhaseDeg[i] === 0 ? thr : -thr)
    const zBul = zPin + D.rodLength
    parts.push({ id: `rod${i}`, name: 'rod', role: 'rod', cylinder: i, mesh: { positions: rod }, density: 7850,
      markers: [
        { id: MARKER.rodBigEnd, position: [mm(D.cylinderX[i]!), 0, mm(zPin)] },
        { id: MARKER.rodSmallEnd, position: [mm(D.cylinderX[i]!), 0, mm(zBul)] }
      ] })
    parts.push({ id: `pist${i}`, name: 'piston', role: 'piston', cylinder: i, mesh: { positions: piston }, density: 2700,
      markers: [
        { id: MARKER.pistonPin, position: [mm(D.cylinderX[i]!), 0, mm(zBul)] },
        { id: MARKER.pistonCrown, position: [mm(D.cylinderX[i]!), 0, mm(D.deckZ)] }
      ] })
    if (opts.conSemantica) {
      for (const [rol, mk] of [['injector', MARKER.injectorTip], ['sparkPlug', MARKER.sparkGap]] as Array<[PartRole, string]>) {
        parts.push({ id: `${rol}${i}`, name: rol, role: rol, cylinder: i,
          markers: [{ id: mk, position: [mm(D.cylinderX[i]!), 0, mm(D.deckZ + 5)], direction: [0, 0, -1] }] })
      }
    }
  }
  if (opts.conSemantica) {
    parts.push({ id: 'starter', name: 'starter', role: 'starter',
      markers: [{ id: MARKER.starterDrive, position: [mm(-220), 0, mm(D.crankZ)], direction: [1, 0, 0] }] })
  }
  return { name: 'K20C1', parts }
}

describe.skipIf(!hay)('Puente montaje → motor simulable', () => {
  it('mide la cámara de la culata REAL y saca una compresión', () => {
    const e = assembleEngine(escena({ conSemantica: true }))
    console.log(
      `\n  cámara ${(e.chamberVolume * 1e6).toFixed(1)} cc` +
      `  compresión ${e.geometry.compressionRatio.toFixed(2)}:1` +
      `  cilindrada ${(e.geometry.displacement * 1e6).toFixed(0)} cc` +
      `\n  problemas: ${e.problemas.length ? e.problemas.join(' | ') : '(ninguno)'}`
    )
    // RESULTADO REAL, y es un hallazgo sobre el MODELO, no un fallo del medidor:
    // la culata del K20 son 1804 triángulos que van de z=317 a 427, o sea el
    // contorno exterior sin las cámaras vaciadas. No hay hueco que medir, y el
    // medidor tiene que decir ESO y no "muévela de sitio".
    expect(Number.isNaN(e.chamberVolume)).toBe(true)
    expect(e.problemas.join(' ')).toMatch(/maciza justo encima del pistón/)
    expect(e.listo).toBe(false)
  })

  it('con una culata que SÍ tiene cámara, la mide y saca la compresión', () => {
    // Culata de prueba: sólido con un rebaje cilíndrico de 47,9 cc sobre el
    // cilindro 1. Comprueba que el camino completo funciona cuando la geometría
    // trae lo que tiene que traer.
    const sc = escena({ conSemantica: true })
    const cx = mm(D.cylinderX[0]!)
    const z0 = mm(D.deckZ)
    const alto = 47.9e-6 / (Math.PI * (0.0854 / 2) ** 2) // altura para ese volumen
    const caja = (x0: number, y0: number, za: number, x1: number, y1: number, zb: number): number[] => {
      const v = [[x0, y0, za], [x1, y0, za], [x1, y1, za], [x0, y1, za],
                 [x0, y0, zb], [x1, y0, zb], [x1, y1, zb], [x0, y1, zb]]
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
      return f.flatMap((c) => c.flatMap((i) => v[i]!))
    }
    // Sólido que empieza justo donde acaba la cámara.
    const head = new Float32Array(caja(cx - 0.1, -0.1, z0 + alto, cx + 0.1, 0.1, z0 + 0.1))
    sc.parts = sc.parts.map((p) => p.role === 'head' ? { ...p, mesh: { positions: head } } : p)
    const e = assembleEngine(sc)
    expect(e.chamberVolume).toBeGreaterThan(0)
    expect(e.geometry.compressionRatio).toBeGreaterThan(8)
    expect(e.geometry.compressionRatio).toBeLessThan(14)
  })

  it('deduce el orden de encendido y la disposición de la geometría', () => {
    const e = assembleEngine(escena({ conSemantica: true }))
    expect(e.geometry.cylinders).toBe(4)
    expect(e.archetype.cylinders).toBe(4)
    expect(new Set(Array.from(e.archetype.firingOrder)).size).toBe(4)
    // Todos los pistones apuntan igual → en línea, ángulo de banco cero.
    expect(e.archetype.bankAngle).toBeCloseTo(0, 3)
  })

  it('sin inyectores ni bujías avisa de que no puede funcionar', () => {
    const e = assembleEngine(escena({ conSemantica: false }))
    const txt = e.problemas.join(' ')
    expect(txt).toMatch(/inyector/i)
    expect(txt).toMatch(/bujía/i)
    expect(txt).toMatch(/arranque/i)
    expect(e.listo).toBe(false)
  })

  it('cuenta la semántica marcada', () => {
    const e = assembleEngine(escena({ conSemantica: true }))
    expect(e.semantica.inyectoresPorCilindro).toHaveLength(4)
    expect(e.semantica.bujiasPorCilindro).toHaveLength(4)
    expect(e.semantica.tieneArranque).toBe(true)
  })
})

describe('Puente — escena vacía', () => {
  it('no revienta y explica qué falta', () => {
    const e = assembleEngine({ name: 'nada', parts: [] })
    expect(e.listo).toBe(false)
    expect(e.problemas.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!hay)('El motor montado ARRANCA', () => {
  /** Escena completa con una culata que sí tiene cámara vaciada. */
  function escenaCompleta(): EngineScene {
    const sc = escena({ conSemantica: true })
    const cx = mm(D.cylinderX[0]!)
    const z0 = mm(D.deckZ)
    const alto = 47.9e-6 / (Math.PI * (0.0854 / 2) ** 2)
    const v = (x0: number, y0: number, za: number, x1: number, y1: number, zb: number): number[] => {
      const p = [[x0, y0, za], [x1, y0, za], [x1, y1, za], [x0, y1, za],
                 [x0, y0, zb], [x1, y0, zb], [x1, y1, zb], [x0, y1, zb]]
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
      return f.flatMap((c) => c.flatMap((i) => p[i]!))
    }
    const head = new Float32Array(v(cx - 0.1, -0.1, z0 + alto, cx + 0.1, 0.1, z0 + 0.1))
    sc.parts = sc.parts.map((p) => p.role === 'head' ? { ...p, mesh: { positions: head } } : p)
    return sc
  }

  it('un motor montado de cero gira de verdad en el HIL', async () => {
    const { toRunnable } = await import('./toEngine')
    const { SimLoop } = await import('../hil/simLoop')
    const { TICK_DT, defaultHarness } = await import('../hil/types')
    const { FUELS } = await import('../index')

    const e = assembleEngine(escenaCompleta())
    expect(e.listo).toBe(true)

    const g95 = FUELS.gasolina95!
    const r = toRunnable(e, { stoichAFR: g95.stoichAFR, lhv: g95.lhv })
    // Lo que NO se puede medir de una malla se declara como supuesto.
    expect(r.supuestos.length).toBeGreaterThan(0)
    expect(r.supuestos.join(' ')).toMatch(/Respiración|Inyectores/)

    const loop = new SimLoop(r.core, defaultHarness(9), r.calib)
    loop.physical.ignitionKey = true
    for (let t = 0; t < Math.round(4 / TICK_DT); t++) {
      loop.physical.throttle = 0.4
      loop.tick(TICK_DT)
    }
    console.log(
      `\n  MOTOR MONTADO DESDE MALLAS: ${e.geometry.cylinders} cil, ` +
      `${(e.geometry.displacement * 1e6).toFixed(0)} cc, ` +
      `${e.geometry.compressionRatio.toFixed(2)}:1  →  ${loop.core.rpm.toFixed(0)} rpm`
    )
    // Arrancó y gira: el círculo está cerrado.
    expect(loop.core.rpm).toBeGreaterThan(500)
    expect(Number.isFinite(loop.core.rpm)).toBe(true)
  })

  it('los supuestos se declaran, no se esconden', async () => {
    const { toRunnable } = await import('./toEngine')
    const { FUELS } = await import('../index')
    const g95 = FUELS.gasolina95!
    const r = toRunnable(assembleEngine(escenaCompleta()), { stoichAFR: g95.stoichAFR, lhv: g95.lhv })
    // Los dos que no salen de la geometría tienen que estar nombrados.
    expect(r.supuestos.some((s) => /Respiración/.test(s))).toBe(true)
    expect(r.supuestos.some((s) => /Inyectores/.test(s))).toBe(true)
    expect(r.core.injectorFlow).toBeGreaterThan(0)
  })
})

describe.skipIf(!hay)('Del montaje al banco de potencia', () => {
  function completa(): EngineScene {
    const sc = escena({ conSemantica: true })
    const cx = mm(D.cylinderX[0]!); const z0 = mm(D.deckZ)
    const alto = 47.9e-6 / (Math.PI * (0.0854 / 2) ** 2)
    const v = (x0: number, y0: number, za: number, x1: number, y1: number, zb: number): number[] => {
      const p = [[x0, y0, za], [x1, y0, za], [x1, y1, za], [x0, y1, za],
                 [x0, y0, zb], [x1, y0, zb], [x1, y1, zb], [x0, y1, zb]]
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
      return f.flatMap((c) => c.flatMap((i) => p[i]!))
    }
    const head = new Float32Array(v(cx - 0.1, -0.1, z0 + alto, cx + 0.1, 0.1, z0 + 0.1))
    sc.parts = sc.parts.map((p) => p.role === 'head' ? { ...p, mesh: { positions: head } } : p)
    return sc
  }

  it('el motor montado se resuelve y da una curva de potencia', async () => {
    const { toAssembly } = await import('./toEngine')
    const { resolveEngine } = await import('../assembly')
    const { runDyno, defaultTune, FUELS } = await import('../index')

    const e = assembleEngine(completa())
    const { assembly } = toAssembly(e)
    const res = resolveEngine(assembly)
    expect(res.issues.filter((i) => i.severity === 'error')).toEqual([])

    // Las cotas MEDIDAS tienen que sobrevivir el viaje al banco.
    expect(res.geometry.cylinders).toBe(4)
    expect(res.geometry.stroke * 1000).toBeCloseTo(85.9, 1)
    expect(res.geometry.rodLength * 1000).toBeCloseTo(139, 1)
    // Y las masas medidas de la malla, también.
    expect(assembly.rod.spec.mass).toBeCloseTo(e.measurement.rodMass!, 4)
    expect(assembly.piston.spec.mass).toBeCloseTo(e.measurement.pistonMass!, 4)

    const dyno = runDyno(res, defaultTune(), FUELS.gasolina95!)
    // `power` viene en VATIOS (no kW): 735,5 W = 1 CV.
    const pico = Math.max(...dyno.points.map((p) => p.power))
    console.log(`\n  BANCO DEL MOTOR MONTADO: ${(pico / 735.5).toFixed(0)} CV de pico`)
    expect(pico).toBeGreaterThan(10000) // >13 CV
    expect(Number.isFinite(pico)).toBe(true)
  })

  it('los identificadores no pisan a los del catálogo', async () => {
    const { toAssembly } = await import('./toEngine')
    const { assembly } = toAssembly(assembleEngine(completa()))
    for (const p of [assembly.block, assembly.crank, assembly.rod, assembly.piston, assembly.head]) {
      expect(p.id).toMatch(/montaje-/)
    }
  })
})

describe.skipIf(!hay)('Mover un marcador CAMBIA el motor', () => {
  function conInyectorEn(altura: number): EngineScene {
    const sc = escena({ conSemantica: true })
    const cx = mm(D.cylinderX[0]!); const z0 = mm(D.deckZ)
    const alto = 47.9e-6 / (Math.PI * (0.0854 / 2) ** 2)
    const v = (x0: number, y0: number, za: number, x1: number, y1: number, zb: number): number[] => {
      const p = [[x0, y0, za], [x1, y0, za], [x1, y1, za], [x0, y1, za],
                 [x0, y0, zb], [x1, y0, zb], [x1, y1, zb], [x0, y1, zb]]
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
      return f.flatMap((c) => c.flatMap((i) => p[i]!))
    }
    const head = new Float32Array(v(cx - 0.1, -0.1, z0 + alto, cx + 0.1, 0.1, z0 + 0.1))
    sc.parts = sc.parts.map((p) => {
      if (p.role === 'head') return { ...p, mesh: { positions: head } }
      if (p.role !== 'injector') return p
      // Solo se mueve la ALTURA de la punta del inyector. Nada más cambia.
      return { ...p, markers: p.markers.map((k) => ({
        ...k, position: [k.position[0], k.position[1], z0 + altura] as Vec3
      })) }
    })
    return sc
  }

  it('meter el inyector dentro del cilindro lo convierte en inyección directa y sube el llenado', async () => {
    const { toRunnable } = await import('./toEngine')
    const { FUELS } = await import('../index')
    const g95 = FUELS.gasolina95!
    const fuel = { stoichAFR: g95.stoichAFR, lhv: g95.lhv }

    const fuera = assembleEngine(conInyectorEn(0.2))    // 20 cm arriba: colector
    const dentro = assembleEngine(conInyectorEn(0.015)) // 15 mm: asomado a la cámara

    expect(fuera.efectos.inyeccionDirecta).toBe(false)
    expect(dentro.efectos.inyeccionDirecta).toBe(true)

    const rf = toRunnable(fuera, fuel)
    const rd = toRunnable(dentro, fuel)
    const veMax = (r: typeof rf): number => Math.max(...r.core.veCurve.map((p) => p[1]))
    // El MISMO motor, movido un marcador, respira más.
    expect(veMax(rd)).toBeGreaterThan(veMax(rf))
    console.log(
      `\n  inyector fuera → VE máx ${veMax(rf).toFixed(3)}` +
      `\n  inyector dentro → VE máx ${veMax(rd).toFixed(3)}  (${(dentro.efectos.factorLlenado * 100 - 100).toFixed(0)}% más)`
    )
    // Y lo dice en pantalla, no en silencio.
    expect(rd.supuestos.join(' ')).toMatch(/DIRECTA/)
  })

  it('descentrar la bujía recorta el avance de la ECU', async () => {
    const { toRunnable } = await import('./toEngine')
    const { FUELS } = await import('../index')
    const g95 = FUELS.gasolina95!
    const fuel = { stoichAFR: g95.stoichAFR, lhv: g95.lhv }

    const mover = (dx: number): EngineScene => {
      const sc = conInyectorEn(0.015)
      return { ...sc, parts: sc.parts.map((p) => p.role !== 'sparkPlug' ? p : ({
        ...p, markers: p.markers.map((k) => ({
          ...k, position: [k.position[0] + dx, k.position[1], k.position[2]] as Vec3
        }))
      })) }
    }
    const centrada = toRunnable(assembleEngine(mover(0)), fuel)
    const fueraDeEje = toRunnable(assembleEngine(mover(0.03)), fuel)
    expect(fueraDeEje.calib.advMax).toBeLessThan(centrada.calib.advMax)
  })
})
