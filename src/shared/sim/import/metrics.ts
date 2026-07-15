import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

/**
 * Métricas geométricas de una malla triangular importada (STEP teselado o STL).
 * Son la entrada del derivador de límites: espesor mínimo de pared, sección
 * mínima, volumen... Todo en las unidades de la malla (se normaliza a metros
 * antes de llamar aquí).
 */

export interface GeometryMetrics {
  volume: number // m³
  surfaceArea: number // m²
  bbox: { x: number; y: number; z: number } // dimensiones
  /** Espesor de pared robusto (percentil 5 del muestreo). */
  minWallThickness: number // m
  /** Área de la menor sección transversal a lo largo del eje mayor. */
  minSectionArea: number // m²
  longestAxis: 'x' | 'y' | 'z'
}

export interface AnalyzeOptions {
  thicknessSamples?: number
  sectionStations?: number
  sectionGrid?: number
}

export function analyzeMesh(
  positions: Float32Array,
  index?: Uint32Array,
  opts: AnalyzeOptions = {}
): GeometryMetrics {
  const { thicknessSamples = 600, sectionStations = 20, sectionGrid = 32 } = opts

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (index) geometry.setIndex(new THREE.BufferAttribute(index, 1))

  const triCount = (index ? index.length : positions.length / 3) / 3
  if (triCount < 4) throw new Error('Malla vacía o degenerada')

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()

  const vertexAt = (tri: number, corner: number, out: THREE.Vector3): void => {
    const vi = index ? index[tri * 3 + corner]! : tri * 3 + corner
    out.fromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute, vi)
  }

  // ---- Volumen (teorema de la divergencia), área y bbox ----
  let volume = 0
  let surfaceArea = 0
  const triAreas = new Float64Array(triCount)
  geometry.computeBoundingBox()
  const bb = geometry.boundingBox!
  for (let t = 0; t < triCount; t++) {
    vertexAt(t, 0, a)
    vertexAt(t, 1, b)
    vertexAt(t, 2, c)
    volume += a.dot(ab.copy(b).cross(c)) / 6
    const area = ac.copy(c).sub(a).cross(ab.copy(b).sub(a)).length() / 2
    triAreas[t] = area
    surfaceArea += area
  }
  volume = Math.abs(volume)

  const size = new THREE.Vector3()
  bb.getSize(size)
  const bbox = { x: size.x, y: size.y, z: size.z }
  const longestAxis: 'x' | 'y' | 'z' =
    size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
  const diag = size.length()

  // ---- BVH para raycasting ----
  const bvh = new MeshBVH(geometry)
  const ray = new THREE.Ray()
  const invMat = new THREE.Matrix4().identity()

  // ---- Espesor de pared: desde el centroide de triángulos muestreados,
  // rayo hacia dentro (contra la normal); la distancia al primer impacto
  // es el espesor local. Percentil 5 = espesor mínimo robusto. ----
  const cumArea = new Float64Array(triCount)
  let acc = 0
  for (let t = 0; t < triCount; t++) {
    acc += triAreas[t]!
    cumArea[t] = acc
  }
  const pickTriByArea = (u: number): number => {
    const target = u * acc
    let lo = 0
    let hi = triCount - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cumArea[mid]! < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const normal = new THREE.Vector3()
  const centroid = new THREE.Vector3()
  const thicknesses: number[] = []
  // Muestreo determinista (secuencia de Weyl) para resultados reproducibles
  let u = 0.5
  for (let s = 0; s < thicknessSamples; s++) {
    u = (u + 0.6180339887498949) % 1
    const t = pickTriByArea(u)
    vertexAt(t, 0, a)
    vertexAt(t, 1, b)
    vertexAt(t, 2, c)
    centroid.copy(a).add(b).add(c).divideScalar(3)
    // normal exterior CCW = (b−a)×(c−a); invertida apunta hacia dentro
    normal.copy(ab.copy(b).sub(a)).cross(ac.copy(c).sub(a)).normalize().multiplyScalar(-1)
    ray.origin.copy(centroid).addScaledVector(normal, diag * 1e-4)
    ray.direction.copy(normal)
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, Infinity)
    if (hit && hit.distance > diag * 1e-3 && hit.distance < diag) {
      thicknesses.push(hit.distance + diag * 1e-4)
    }
  }
  thicknesses.sort((x, y) => x - y)
  const minWallThickness =
    thicknesses.length > 0 ? thicknesses[Math.floor(thicknesses.length * 0.05)]! : 0

  // ---- Sección mínima: estaciones a lo largo del eje mayor; en cada una,
  // rejilla de puntos con test de paridad (nº de cortes del rayo) ----
  const axisIdx = longestAxis === 'x' ? 0 : longestAxis === 'y' ? 1 : 2
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z']
  const [u1, u2] = axes.filter((_, i) => i !== axisIdx) as ['x' | 'y' | 'z', 'x' | 'y' | 'z']
  const min = bb.min
  const axisLen = size[longestAxis]
  const cellW = size[u1] / sectionGrid
  const cellH = size[u2] / sectionGrid
  const cellArea = cellW * cellH

  const dir = new THREE.Vector3()
  dir[longestAxis] = 1

  let minSectionArea = Infinity
  for (let st = 0; st < sectionStations; st++) {
    // evitamos los extremos (caras planas dan paridades ambiguas)
    const frac = 0.06 + (0.88 * (st + 0.5)) / sectionStations
    const station = min[longestAxis] + frac * axisLen
    let inside = 0
    for (let i = 0; i < sectionGrid; i++) {
      for (let j = 0; j < sectionGrid; j++) {
        ray.origin.set(0, 0, 0)
        ray.origin[u1] = min[u1] + (i + 0.5) * cellW
        ray.origin[u2] = min[u2] + (j + 0.5) * cellH
        ray.origin[longestAxis] = station
        ray.direction.copy(dir)
        let count = 0
        // contamos todos los cruces por delante del punto
        bvh.shapecast({
          intersectsBounds: (box) => ray.intersectsBox(box),
          intersectsTriangle: (tri) => {
            const target = new THREE.Vector3()
            if (ray.intersectTriangle(tri.a, tri.b, tri.c, false, target) !== null) {
              if (target[longestAxis] > station + axisLen * 1e-6) count++
            }
            return false
          }
        })
        if (count % 2 === 1) inside++
      }
    }
    const area = inside * cellArea
    if (area > 0 && area < minSectionArea) minSectionArea = area
  }
  if (!Number.isFinite(minSectionArea)) minSectionArea = 0

  void invMat
  return { volume, surfaceArea, bbox, minWallThickness, minSectionArea, longestAxis }
}
