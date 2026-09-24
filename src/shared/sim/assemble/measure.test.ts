import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { measureEngine, describeMeasurement, diameterAcrossAxis, meshVolume } from './measure'
import { MARKER } from './scene'
import type { EngineScene, ScenePart, Vec3 } from './scene'

/**
 * Validación del medidor contra un motor REAL ya modelado: el K20C1 de
 * `design/k20c1`. Es la prueba que decide si la idea de "trae tu geometría y
 * marca cuatro puntos" puede sostener la simulación, porque hay una verdad
 * conocida contra la que comparar (`datums.json`).
 *
 * Los marcadores se colocan donde los pondría un usuario que acierta: en el eje
 * del cigüeñal, en el centro de cada muñequilla, en los ojos de la biela y en
 * el bulón y la corona del pistón. Lo que NO se le da hecho es el calibre: ese
 * sale de medir la malla, que es la parte que de verdad se está probando.
 */

const DIR = join(process.cwd(), 'design', 'k20c1')
const STL = join(DIR, 'out_final', 'stl')
const hayModelo = existsSync(join(STL, 'piston_1.stl'))

/** Lector de STL binario. 84 bytes de cabecera y 50 por triángulo. */
function leerStl(ruta: string): Float32Array {
  const b = readFileSync(ruta)
  const n = b.readUInt32LE(80)
  const pos = new Float32Array(n * 9)
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12 // +12 salta la normal
    for (let v = 0; v < 9; v++) pos[t * 9 + v] = b.readFloatLE(o + v * 4)
  }
  return pos
}

/** El modelo está en mm; el medidor trabaja en metros. */
function aMetros(p: Float32Array): Float32Array {
  const q = new Float32Array(p.length)
  for (let i = 0; i < p.length; i++) q[i] = p[i]! * 0.001
  return q
}

// Verdad conocida (datums.json del modelo), en mm.
const D = {
  bore: 86.0, stroke: 85.9, rodLength: 139.0,
  crankZ: 120.0, deckZ: 332.0,
  cylinderX: [-141.0, -47.0, 47.0, 141.0],
  pinPhaseDeg: [0, 180, 180, 0]
}
const mm = (v: number): number => v * 0.001
const throwR = D.stroke / 2

function escenaK20(): EngineScene {
  const pistonMesh = aMetros(leerStl(join(STL, 'piston_1.stl')))
  const rodMesh = aMetros(leerStl(join(STL, 'conrod_1.stl')))
  const crankMesh = aMetros(leerStl(join(STL, 'crankshaft.stl')))

  // Muñequilla del cilindro i: sobre el eje X, a radio `throwR`, arriba o abajo
  // según su fase. Es donde un usuario clicaría el centro del muñón.
  const pinPos = (i: number): Vec3 => {
    const arriba = D.pinPhaseDeg[i] === 0
    return [mm(D.cylinderX[i]!), 0, mm(D.crankZ + (arriba ? throwR : -throwR))]
  }

  const crank: ScenePart = {
    id: 'crank', name: 'crankshaft.stl', role: 'crank',
    mesh: { positions: crankMesh }, density: 7850,
    markers: [
      // Eje de bancada: dos puntos en los extremos, a lo largo de X.
      { id: MARKER.crankAxisA, position: [mm(-200), 0, mm(D.crankZ)] },
      { id: MARKER.crankAxisB, position: [mm(200), 0, mm(D.crankZ)] },
      ...D.cylinderX.map((_, i) => ({ id: MARKER.crankPin(i), position: pinPos(i) }))
    ]
  }

  const parts: ScenePart[] = [crank]
  for (let i = 0; i < 4; i++) {
    const arriba = D.pinPhaseDeg[i] === 0
    const zPin = D.crankZ + (arriba ? throwR : -throwR)
    const zBulon = zPin + D.rodLength
    parts.push({
      id: `rod${i}`, name: `conrod_${i + 1}.stl`, role: 'rod', cylinder: i,
      mesh: { positions: rodMesh }, density: 7850,
      markers: [
        { id: MARKER.rodBigEnd, position: [mm(D.cylinderX[i]!), 0, mm(zPin)] },
        { id: MARKER.rodSmallEnd, position: [mm(D.cylinderX[i]!), 0, mm(zBulon)] }
      ]
    })
    parts.push({
      id: `piston${i}`, name: `piston_${i + 1}.stl`, role: 'piston', cylinder: i,
      mesh: { positions: pistonMesh }, density: 2700,
      markers: [
        { id: MARKER.pistonPin, position: [mm(D.cylinderX[i]!), 0, mm(zBulon)] },
        // La corona, en el cilindro 1, llega justo al plano de culata.
        { id: MARKER.pistonCrown, position: [mm(D.cylinderX[i]!), 0, mm(D.deckZ)] }
      ]
    })
  }
  return { name: 'K20C1', parts }
}

describe.skipIf(!hayModelo)('Medidor — contra el K20C1 real', () => {
  it('saca carrera, biela y cilindros de los marcadores', () => {
    const m = measureEngine(escenaK20())
    console.log('\n' + describeMeasurement(m))

    expect(m.fallos).toEqual([])
    expect(m.cylinders).toBe(4)
    // Verdad del modelo: 85,9 mm de carrera y 139 de biela. Tolerancia de una
    // décima de milímetro: si el medidor se desvía más, es que la geometría del
    // marcador no está entrando bien, no que "casi acierta".
    expect(m.stroke * 1000).toBeCloseTo(D.stroke, 1)
    expect(m.rodLength * 1000).toBeCloseTo(D.rodLength, 1)
  })

  it('mide el calibre de la MALLA, y sale el diámetro del pistón (no el del cilindro)', () => {
    const m = measureEngine(escenaK20())
    const boreMm = m.bore * 1000
    // Este es el resultado que importa: nadie le ha dicho el calibre, sale de
    // medir el pistón. Da 85,4 y no 86,0 porque un pistón NO es del diámetro
    // del cilindro: lleva holgura de montaje. O sea que el método mide bien y
    // lo que mide es el pistón; el calibre real es algo mayor.
    expect(boreMm).toBeGreaterThan(84)
    expect(boreMm).toBeLessThan(D.bore)
    expect(D.bore - boreMm).toBeLessThan(1.5)
  })

  it('deduce el orden de encendido de las fases, sin tabla de arquitecturas', () => {
    const m = measureEngine(escenaK20())
    const grados = m.pinPhases.map((f) => Math.round((f * 180) / Math.PI) % 360)
    // El K20 es un L4 con muñequillas a 0-180-180-0: dos parejas.
    expect(new Set(grados).size).toBe(2)
    expect(Math.abs(grados[0]! - grados[1]!)).toBe(180)
    expect(grados[0]).toBe(grados[3])
    expect(grados[1]).toBe(grados[2])
    // Y los cuatro cilindros aparecen una vez cada uno en el orden.
    expect(new Set(m.firingOrder).size).toBe(4)
  })

  it('saca las masas del volumen de la malla', () => {
    const m = measureEngine(escenaK20())
    // Pistón de aluminio de 86 mm: unos cientos de gramos. El número exacto
    // depende de lo maciza que sea la malla; lo que se comprueba es que el
    // camino malla → volumen → masa da algo físicamente sensato.
    expect(m.pistonMass!).toBeGreaterThan(0.1)
    expect(m.pistonMass!).toBeLessThan(1.5)
    expect(m.rodMass!).toBeGreaterThan(0.2)
    expect(m.rodMass!).toBeLessThan(2.5)
  })
})

describe('Medidor — cuando falta información, lo dice', () => {
  const vacia: EngineScene = { name: 'vacía', parts: [] }

  it('una escena vacía falla explicando qué falta y cómo se arregla', () => {
    const m = measureEngine(vacia)
    expect(m.fallos.length).toBeGreaterThan(0)
    const campos = m.fallos.map((f) => f.campo)
    expect(campos).toContain('cylinders')
    expect(campos).toContain('crankAxis')
    // Cada fallo tiene que decir QUÉ hacer, no solo que algo va mal.
    for (const f of m.fallos) {
      expect(f.arregla.length).toBeGreaterThan(20)
    }
  })

  it('un cigüeñal sin muñequillas marcadas no inventa una carrera', () => {
    const m = measureEngine({
      name: 'a medias',
      parts: [
        {
          id: 'c', name: 'crank', role: 'crank', markers: [
            { id: MARKER.crankAxisA, position: [0, 0, 0] },
            { id: MARKER.crankAxisB, position: [0.3, 0, 0] }
          ]
        },
        { id: 'p', name: 'pist', role: 'piston', markers: [] }
      ]
    })
    expect(m.stroke).toBe(0)
    expect(m.fallos.some((f) => f.campo === 'stroke')).toBe(true)
  })

  it('avisa si las muñequillas no están todas al mismo radio', () => {
    const pin = (z: number, x: number): Vec3 => [x, 0, z]
    const m = measureEngine({
      name: 'cigüeñal raro',
      parts: [
        {
          id: 'c', name: 'crank', role: 'crank', markers: [
            { id: MARKER.crankAxisA, position: [-0.2, 0, 0] },
            { id: MARKER.crankAxisB, position: [0.2, 0, 0] },
            { id: MARKER.crankPin(0), position: pin(0.043, -0.1) },
            { id: MARKER.crankPin(1), position: pin(-0.060, 0.1) } // 17 mm más
          ]
        },
        { id: 'p0', name: 'p0', role: 'piston', markers: [] },
        { id: 'p1', name: 'p1', role: 'piston', markers: [] }
      ]
    })
    expect(m.avisos.join(' ')).toMatch(/mismo radio/)
  })
})

describe('Medidor — utilidades de malla', () => {
  it('el volumen de un cubo unidad sale 1', () => {
    // Cubo 1×1×1 en triángulos sueltos (12 caras).
    const v: number[][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
                           [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    const caras = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                   [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
    const pos = new Float32Array(caras.length * 9)
    caras.forEach((c, i) => c.forEach((idx, j) => {
      pos[i * 9 + j * 3] = v[idx]![0]!
      pos[i * 9 + j * 3 + 1] = v[idx]![1]!
      pos[i * 9 + j * 3 + 2] = v[idx]![2]!
    }))
    expect(meshVolume(pos)).toBeCloseTo(1, 6)
  })

  it('el diámetro perpendicular al eje ignora un vértice suelto', () => {
    // Anillo de radio 0,05 alrededor del eje Z, más un pico muy lejos.
    const n = 400
    const pos = new Float32Array((n + 1) * 3)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI
      pos[i * 3] = 0.05 * Math.cos(a)
      pos[i * 3 + 1] = 0.05 * Math.sin(a)
      pos[i * 3 + 2] = 0
    }
    pos[n * 3] = 5 // rebaba a 5 metros
    const d = diameterAcrossAxis(pos, [0, 0, 0], [0, 0, 1])
    expect(d).toBeCloseTo(0.1, 3)
  })
})
