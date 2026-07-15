import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { analyzeMesh } from './metrics'
import {
  buildImportedInjector,
  buildImportedPiston,
  buildImportedRod,
  deriveInjectorLimits,
  derivePistonLimits,
  deriveRodLimits
} from './derive'
import { materialById } from '../materials'
import type { GeometryMetrics } from './metrics'

function positionsOf(geo: THREE.BufferGeometry): Float32Array {
  const soup = geo.toNonIndexed()
  return new Float32Array(soup.getAttribute('position').array)
}

/** Tubo hueco cerrado (revolución de un rectángulo): volumen y pared exactos. */
function tubeMesh(ri: number, ro: number, length: number): Float32Array {
  const profile = [
    new THREE.Vector2(ri, 0),
    new THREE.Vector2(ro, 0),
    new THREE.Vector2(ro, length),
    new THREE.Vector2(ri, length),
    new THREE.Vector2(ri, 0)
  ]
  return positionsOf(new THREE.LatheGeometry(profile, 64))
}

describe('métricas de malla', () => {
  it('mide un prisma: volumen, bbox, pared y sección mínimas', () => {
    const m = analyzeMesh(positionsOf(new THREE.BoxGeometry(0.02, 0.1, 0.03)))
    expect(m.volume).toBeCloseTo(0.02 * 0.1 * 0.03, 7)
    expect(m.longestAxis).toBe('y')
    expect(m.minWallThickness).toBeGreaterThan(0.018)
    expect(m.minWallThickness).toBeLessThan(0.022)
    // sección transversal al eje largo: 20×30 mm
    expect(m.minSectionArea).toBeGreaterThan(0.02 * 0.03 * 0.85)
    expect(m.minSectionArea).toBeLessThan(0.02 * 0.03 * 1.15)
  })

  it('mide un tubo de pared gruesa: la pared es ro−ri, la sección es la corona', () => {
    const ri = 0.0015
    const ro = 0.0035
    const L = 0.04
    const m = analyzeMesh(tubeMesh(ri, ro, L))
    const wallExpected = ro - ri
    const ringArea = Math.PI * (ro * ro - ri * ri)
    expect(m.volume).toBeCloseTo(ringArea * L, 8)
    expect(m.minWallThickness).toBeGreaterThan(wallExpected * 0.8)
    expect(m.minWallThickness).toBeLessThan(wallExpected * 1.2)
    expect(m.minSectionArea).toBeGreaterThan(ringArea * 0.75)
    expect(m.minSectionArea).toBeLessThan(ringArea * 1.25)
  })
})

const rodMetrics: GeometryMetrics = {
  volume: 8.0e-5, // → ~630 g en acero
  surfaceArea: 0.02,
  bbox: { x: 0.17, y: 0.04, z: 0.02 },
  minWallThickness: 0.005,
  minSectionArea: 2.2e-4, // 220 mm²
  longestAxis: 'x'
}

describe('derivación de límites', () => {
  it('biela: mejor material ⇒ más carga admisible, y magnitudes realistas', () => {
    const params = { centerDistance: 0.139 }
    const weak = deriveRodLimits({ name: 'b', metrics: rodMetrics, material: materialById('steel-c70') }, params)
    const strong = deriveRodLimits({ name: 'b', metrics: rodMetrics, material: materialById('steel-4340') }, params)
    const wc = weak.find((l) => l.variable === 'rodCompression')!
    const sc = strong.find((l) => l.variable === 'rodCompression')!
    expect(sc.value).toBeGreaterThan(wc.value)
    // Banda plausible para una biela de 220 mm² de sección
    expect(wc.value).toBeGreaterThan(40e3)
    expect(sc.value).toBeLessThan(400e3)
    expect(sc.provenance).toBe('derived-analytic')
    expect(sc.explanation).toMatch(/mm²/)
  })

  it('pistón: corona más gruesa ⇒ más presión; el límite térmico es el del material', () => {
    const thin: GeometryMetrics = { ...rodMetrics, minWallThickness: 0.005 }
    const thick: GeometryMetrics = { ...rodMetrics, minWallThickness: 0.009 }
    const mat = materialById('alu-2618')
    const params = { bore: 0.086, compressionHeight: 0.03 }
    const pThin = derivePistonLimits({ name: 'p', metrics: thin, material: mat }, params)
    const pThick = derivePistonLimits({ name: 'p', metrics: thick, material: mat }, params)
    const prThin = pThin.find((l) => l.variable === 'peakCylinderPressure')!
    const prThick = pThick.find((l) => l.variable === 'peakCylinderPressure')!
    expect(prThick.value).toBeGreaterThan(prThin.value * 2)
    expect(pThin.find((l) => l.variable === 'crownTemp')!.value).toBe(mat.maxServiceTemp)
    // Orden de magnitud: decenas-pocas centenas de bar
    expect(prThin.value).toBeGreaterThan(30e5)
    expect(prThick.value).toBeLessThan(600e5)
  })

  it('inyector: Lamé da miles de bar para un cuerpo común-rail en 17-4PH', () => {
    const g: GeometryMetrics = { ...rodMetrics, minWallThickness: 0.002 }
    const limits = deriveInjectorLimits(
      { name: 'i', metrics: g, material: materialById('steel-17-4ph') },
      { channelDiameter: 0.003, staticFlow: 5e-3 }
    )
    const rail = limits.find((l) => l.variable === 'railPressure')!
    expect(rail.value).toBeGreaterThan(2000e5)
    expect(rail.value).toBeLessThan(6000e5)
  })

  it('las piezas construidas encajan en los slots: masa = volumen × densidad', () => {
    const mat = materialById('steel-4340')
    const rod = buildImportedRod({ name: 'Biela custom', metrics: rodMetrics, material: mat }, { centerDistance: 0.139 })
    expect(rod.kind).toBe('rod')
    expect(rod.source).toBe('imported')
    expect(rod.spec.mass).toBeCloseTo(8.0e-5 * 7850, 3)
    expect(rod.spec.length).toBe(0.139)

    const piston = buildImportedPiston(
      { name: 'Pistón custom', metrics: rodMetrics, material: materialById('alu-2618') },
      { bore: 0.086, compressionHeight: 0.03 }
    )
    expect(piston.spec.bore).toBe(0.086)

    const injector = buildImportedInjector(
      { name: 'Iny custom', metrics: rodMetrics, material: materialById('steel-17-4ph') },
      { channelDiameter: 0.003, staticFlow: 6e-3 }
    )
    expect(injector.spec.staticFlow).toBe(6e-3)
    expect(injector.limits.some((l) => l.variable === 'injectorDuty')).toBe(true)
  })
})
