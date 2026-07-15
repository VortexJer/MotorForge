import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildSockets } from './sockets'
import { PULSE_INTENSITY, buildEngineDetail, setActuatorPulse } from './engineDetail'
import type { LodTier } from './engineDetail'

const GEO = {
  bore: 0.086,
  stroke: 0.086,
  rodLength: 0.139,
  cylinders: 4,
  displacement: 2.0e-3,
  clearanceVolume: 4.7e-5,
  compressionRatio: 11.7,
  deckClearance: 5e-4
}

function counts(root: THREE.Object3D): { meshes: number; instanced: number; instances: number } {
  let meshes = 0
  let instanced = 0
  let instances = 0
  root.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) {
      instanced++
      instances += o.count
    } else if (o instanceof THREE.Mesh) meshes++
  })
  return { meshes, instanced, instances }
}

describe('árbol maestro de componentes 3D (pliego LOD)', () => {
  const sockets = buildSockets(GEO, 10)
  const d = buildEngineDetail(sockets, 4)

  it('presupuesto de draw calls: estáticos fusionados y tornillería instanciada', () => {
    const c = counts(d.root)
    // §2: el detalle completo (con lubricación, refrigeración y combustible)
    // cabe en <42 mallas — cada una es un bucket fusionado o una pieza móvil
    // dedicada (rodete, aspas, carcasa translúcida) — y la tornillería
    // repetitiva vive en InstancedMesh (decenas de instancias por draw call)
    expect(c.meshes).toBeLessThan(42)
    expect(c.instanced).toBeGreaterThanOrEqual(8)
    expect(c.instances).toBeGreaterThan(95)
  })

  it('16 válvulas sincronizadas al ciclo de 4 tiempos', () => {
    expect(d.valves.count).toBe(16)
    const m = new THREE.Matrix4()
    const before: number[] = []
    d.update(0, 0)
    for (let i = 0; i < 16; i++) {
      d.valves.getMatrixAt(i, m)
      before.push(m.elements[13]!) // componente Y
    }
    // media vuelta de ciclo después (θ = 1.5π): hay válvulas de escape abiertas
    d.update(Math.PI * 1.5, 0)
    let moved = 0
    for (let i = 0; i < 16; i++) {
      d.valves.getMatrixAt(i, m)
      if (Math.abs(m.elements[13]! - before[i]!) > 1e-4) moved++
    }
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThan(16) // solo las del cilindro/fase que toca
  })

  it('LOD §3: inspección todo, banco proxies, global solo macro', () => {
    const visibleByName = (name: string): boolean => {
      let any = false
      d.root.traverse((o) => {
        if (o.name === name && o.visible) any = true
      })
      return any
    }
    d.update(0, 0 as LodTier)
    expect(d.valves.visible).toBe(true)
    expect(visibleByName('lod-detail')).toBe(true)

    d.update(0, 1 as LodTier)
    expect(d.valves.visible).toBe(false) // fino fuera
    expect(visibleByName('lod-detail')).toBe(true) // tuberías siguen

    d.update(0, 2 as LodTier)
    expect(visibleByName('lod-detail')).toBe(false) // solo carcasas macro
    expect(visibleByName('lod-macro')).toBe(true)
  })

  it('pulso §4: valores exactos y retorno al gris CAD', () => {
    const mat = d.glowInjector[0]!
    setActuatorPulse(mat, true)
    expect(mat.emissiveIntensity).toBe(PULSE_INTENSITY)
    expect(`#${mat.color.getHexString()}`).toBe('#facc15')
    expect(`#${mat.emissive.getHexString()}`).toBe('#eab308')
    setActuatorPulse(mat, false)
    expect(mat.emissiveIntensity).toBe(0)
  })
})
