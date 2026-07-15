import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { runVoxelFea } from './fea'

/** Soup de triángulos (sin índice) de una caja centrada en el origen. */
function boxSoup(sx: number, sy: number, sz: number): Float32Array {
  const geo = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed()
  return new Float32Array(geo.getAttribute('position')!.array)
}

describe('FEA vóxel (nivel B)', () => {
  it('barra axial: von Mises ≈ F/A (±25%)', () => {
    // Barra 20×20×100 mm → A = 4e-4 m², σ esperada = 2500 Pa por newton
    const soup = boxSoup(0.02, 0.02, 0.1)
    const r = runVoxelFea(soup, undefined, 'rod-axial', { resolution: 20 })

    expect(r.converged).toBe(true)
    expect(r.elements).toBeGreaterThan(200)
    const expected = 1 / 4e-4
    expect(r.vmPerUnit).toBeGreaterThan(expected * 0.75)
    expect(r.vmPerUnit).toBeLessThan(expected * 1.25)
  })

  it('corona de pistón: converge y da tensión finita y positiva', () => {
    const geo = new THREE.CylinderGeometry(0.043, 0.043, 0.03, 32).toNonIndexed()
    const soup = new Float32Array(geo.getAttribute('position')!.array)
    const r = runVoxelFea(soup, undefined, 'piston-crown', { resolution: 24 })

    expect(r.converged).toBe(true)
    expect(Number.isFinite(r.vmPerUnit)).toBe(true)
    expect(r.vmPerUnit).toBeGreaterThan(0)
  })

  it('es determinista', () => {
    const soup = boxSoup(0.02, 0.02, 0.1)
    const a = runVoxelFea(soup, undefined, 'rod-axial', { resolution: 16 })
    const b = runVoxelFea(boxSoup(0.02, 0.02, 0.1), undefined, 'rod-axial', { resolution: 16 })
    expect(a.vmPerUnit).toBe(b.vmPerUnit)
  })
})
