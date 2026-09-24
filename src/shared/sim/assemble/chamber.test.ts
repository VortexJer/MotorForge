import { describe, it, expect } from 'vitest'
import { measureChamber, compressionFrom, mallaCerrada } from './chamber'
import type { Vec3 } from './scene'

/** Caja rectangular cerrada, en triángulos sueltos. */
function caja(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const v: number[][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
  ]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const p = new Float32Array(f.length * 9)
  f.forEach((c, i) => c.forEach((idx, j) => {
    p[i * 9 + j * 3] = v[idx]![0]!; p[i * 9 + j * 3 + 1] = v[idx]![1]!; p[i * 9 + j * 3 + 2] = v[idx]![2]!
  }))
  return p
}

describe('Cámara — malla cerrada', () => {
  it('una caja cerrada lo está', () => {
    expect(mallaCerrada(caja(0, 0, 0, 1, 1, 1))).toBe(true)
  })
  it('quitarle una cara la abre', () => {
    const c = caja(0, 0, 0, 1, 1, 1)
    expect(mallaCerrada(c.slice(0, c.length - 18))).toBe(false)
  })
})

describe('Cámara — medición del hueco', () => {
  // Culata de mentira: un bloque macizo con un rebaje. El hueco entre la corona
  // (z=0) y la cara inferior del bloque (z=0.01) es la cámara.
  const centro: Vec3 = [0, 0, 0]
  const eje: Vec3 = [0, 0, 1]
  const bore = 0.08

  it('mide el hueco entre la corona y la culata', () => {
    // Bloque macizo que empieza 10 mm por encima de la corona.
    const head = caja(-0.1, -0.1, 0.01, 0.1, 0.1, 0.2)
    const r = measureChamber({ headPositions: head, crownCenter: centro, axis: eje, bore, resolution: 28 })
    expect(r.ok).toBe(true)
    // El hueco es un cilindro de 80 mm de diámetro y 10 mm de alto.
    const esperado = Math.PI * (bore / 2) ** 2 * 0.01
    expect(r.volume).toBeGreaterThan(esperado * 0.9)
    expect(r.volume).toBeLessThan(esperado * 1.1)
  })

  it('sin hueco (culata pegada a la corona) da casi cero', () => {
    const head = caja(-0.1, -0.1, 0, 0.1, 0.1, 0.2)
    const r = measureChamber({ headPositions: head, crownCenter: centro, axis: eje, bore, resolution: 20 })
    expect(r.volume).toBeLessThan(Math.PI * (bore / 2) ** 2 * 0.002)
  })

  it('una malla ABIERTA se rechaza en vez de dar un número falso', () => {
    const c = caja(-0.1, -0.1, 0.01, 0.1, 0.1, 0.2)
    const rota = c.slice(0, c.length - 18)
    const r = measureChamber({ headPositions: rota, crownCenter: centro, axis: eje, bore })
    expect(r.ok).toBe(false)
    expect(Number.isNaN(r.volume)).toBe(true)
    expect(r.motivo).toMatch(/abierta/)
  })

  it('la compresión sale de la cámara y la cilindrada', () => {
    // 86×86 con cámara de 47,9 cc da ~10,5:1 (el mismo caso del diseñador).
    const cr = compressionFrom(0.086, 0.086, 47.9e-6)
    expect(cr).toBeGreaterThan(10)
    expect(cr).toBeLessThan(11.5)
  })
})
