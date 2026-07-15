import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { DerivedLimit } from '../types'
import type { ImportedPartInput, PistonParams, RodParams } from './derive'

/**
 * FEA vóxel (nivel B): elasticidad lineal sobre una malla de hexaedros
 * obtenida voxelizando la pieza importada. Refina los límites analíticos
 * (nivel A) con la tensión von Mises real de la geometría concreta.
 *
 * - Voxelización por paridad de cruces (columnas de rayos sobre el BVH).
 * - Hexaedros trilineales de 8 nodos, un solo material (E se cancela:
 *   la tensión por unidad de carga no depende del módulo elástico).
 * - Gradiente conjugado sin ensamblar la matriz, precondicionador Jacobi.
 * - Casos de carga plantilla: biela a compresión axial, corona de pistón
 *   a presión. El inyector conserva Lamé (pared gruesa lo hace mejor).
 */

export type FeaCase = 'rod-axial' | 'piston-crown'

export interface FeaOptions {
  /** Vóxeles a lo largo del eje mayor de la pieza. */
  resolution?: number
  maxIterations?: number
  /** Tolerancia relativa del residuo del CG. */
  tolerance?: number
}

export interface FeaSummary {
  feaCase: FeaCase
  /**
   * Tensión von Mises (Pa) por unidad de carga: por newton axial en la
   * biela, por pascal de presión de corona en el pistón. Percentil 95
   * excluyendo las zonas de condiciones de contorno.
   */
  vmPerUnit: number
  grid: [number, number, number]
  voxelSize: number // m
  elements: number
  nodes: number
  iterations: number
  converged: boolean
}

const POISSON = 0.3
const SF = 1.35 // mismo factor de seguridad que el nivel A

// ---------------------------------------------------------------------------
// Voxelización

interface VoxelGrid {
  solid: Uint8Array // nx·ny·nz, orden i + nx·(j + ny·k)
  nx: number
  ny: number
  nz: number
  h: number
  sizes: [number, number, number]
}

function voxelize(positions: Float32Array, index: Uint32Array | undefined, resolution: number): VoxelGrid {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (index) geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.computeBoundingBox()
  const bb = geometry.boundingBox!
  const size = new THREE.Vector3()
  bb.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z)
  if (maxDim <= 0) throw new Error('Malla degenerada: caja envolvente sin volumen')

  const h = maxDim / resolution
  const nx = Math.max(1, Math.round(size.x / h))
  const ny = Math.max(1, Math.round(size.y / h))
  const nz = Math.max(1, Math.round(size.z / h))

  const bvh = new MeshBVH(geometry)
  const solid = new Uint8Array(nx * ny * nz)
  const ray = new THREE.Ray()
  ray.direction.set(1, 0, 0)
  const target = new THREE.Vector3()

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      // jitter minúsculo: evita cruzar exactamente aristas compartidas
      const yc = bb.min.y + (j + 0.5) * h + h * 1.7e-4
      const zc = bb.min.z + (k + 0.5) * h + h * 2.3e-4
      ray.origin.set(bb.min.x - maxDim, yc, zc)

      const crossings: number[] = []
      bvh.shapecast({
        intersectsBounds: (box) => ray.intersectsBox(box),
        intersectsTriangle: (tri) => {
          if (ray.intersectTriangle(tri.a, tri.b, tri.c, false, target) !== null) {
            crossings.push(target.x)
          }
          return false
        }
      })
      crossings.sort((a, b) => a - b)
      // dedupe de impactos idénticos (arista compartida por dos triángulos)
      const xs: number[] = []
      for (const x of crossings) {
        if (xs.length === 0 || x - xs[xs.length - 1]! > h * 1e-6) xs.push(x)
      }

      let ci = 0
      for (let i = 0; i < nx; i++) {
        const xc = bb.min.x + (i + 0.5) * h
        while (ci < xs.length && xs[ci]! < xc) ci++
        if (ci % 2 === 1) solid[i + nx * (j + ny * k)] = 1
      }
    }
  }

  return { solid, nx, ny, nz, h, sizes: [size.x, size.y, size.z] }
}

// ---------------------------------------------------------------------------
// Rigidez del hexaedro trilineal (cubo de lado h, E = 1, integración 2×2×2)

const LOCAL_SIGNS: Array<[number, number, number]> = []
for (let a = 0; a < 8; a++) LOCAL_SIGNS.push([(a & 1) * 2 - 1, ((a >> 1) & 1) * 2 - 1, ((a >> 2) & 1) * 2 - 1])

/** Gradientes cartesianos de las 8 funciones de forma en (ξ,η,ζ). */
function shapeGradients(xi: number, eta: number, zeta: number, h: number): Float64Array {
  const g = new Float64Array(24)
  for (let a = 0; a < 8; a++) {
    const [sx, sy, sz] = LOCAL_SIGNS[a]!
    const scale = 2 / h / 8 // dξ/dx = 2/h
    g[a * 3] = sx * (1 + sy * eta) * (1 + sz * zeta) * scale
    g[a * 3 + 1] = sy * (1 + sx * xi) * (1 + sz * zeta) * scale
    g[a * 3 + 2] = sz * (1 + sx * xi) * (1 + sy * eta) * scale
  }
  return g
}

function hexStiffness(h: number, nu: number): Float64Array {
  const lambda = nu / ((1 + nu) * (1 - 2 * nu))
  const mu = 1 / (2 * (1 + nu))
  const c11 = lambda + 2 * mu
  const Ke = new Float64Array(576)
  const gp = 1 / Math.sqrt(3)
  const detJ = (h / 2) ** 3

  for (const xi of [-gp, gp]) {
    for (const eta of [-gp, gp]) {
      for (const zeta of [-gp, gp]) {
        const g = shapeGradients(xi, eta, zeta, h)
        for (let a = 0; a < 8; a++) {
          const gax = g[a * 3]!
          const gay = g[a * 3 + 1]!
          const gaz = g[a * 3 + 2]!
          for (let b = 0; b < 8; b++) {
            const gbx = g[b * 3]!
            const gby = g[b * 3 + 1]!
            const gbz = g[b * 3 + 2]!
            const r = a * 3
            const c = b * 3
            Ke[(r + 0) * 24 + c + 0]! += detJ * (c11 * gax * gbx + mu * (gay * gby + gaz * gbz))
            Ke[(r + 0) * 24 + c + 1]! += detJ * (lambda * gax * gby + mu * gay * gbx)
            Ke[(r + 0) * 24 + c + 2]! += detJ * (lambda * gax * gbz + mu * gaz * gbx)
            Ke[(r + 1) * 24 + c + 0]! += detJ * (lambda * gay * gbx + mu * gax * gby)
            Ke[(r + 1) * 24 + c + 1]! += detJ * (c11 * gay * gby + mu * (gax * gbx + gaz * gbz))
            Ke[(r + 1) * 24 + c + 2]! += detJ * (lambda * gay * gbz + mu * gaz * gby)
            Ke[(r + 2) * 24 + c + 0]! += detJ * (lambda * gaz * gbx + mu * gax * gbz)
            Ke[(r + 2) * 24 + c + 1]! += detJ * (lambda * gaz * gby + mu * gay * gbz)
            Ke[(r + 2) * 24 + c + 2]! += detJ * (c11 * gaz * gbz + mu * (gax * gbx + gay * gby))
          }
        }
      }
    }
  }
  return Ke
}

// ---------------------------------------------------------------------------
// Solver

export function runVoxelFea(
  positions: Float32Array,
  index: Uint32Array | undefined,
  feaCase: FeaCase,
  opts: FeaOptions = {}
): FeaSummary {
  const { resolution = 26, maxIterations = 4000, tolerance = 1e-6 } = opts
  const grid = voxelize(positions, index, resolution)
  const { solid, nx, ny, nz, h, sizes } = grid

  // Eje de trabajo: mayor para la biela (axial), menor para el pistón (corona)
  const dims = [nx, ny, nz] as const
  const order = [0, 1, 2].sort((a, b) => sizes[b]! - sizes[a]!)
  const axis = feaCase === 'rod-axial' ? order[0]! : order[2]!
  const nAxis = dims[axis]!
  if (nAxis < 4) throw new Error('Resolución insuficiente a lo largo del eje de carga')

  const nodesX = nx + 1
  const nodesY = ny + 1
  const nodeIndex = (ix: number, iy: number, iz: number): number => ix + nodesX * (iy + nodesY * iz)
  const voxelAt = (i: number, j: number, k: number): number =>
    i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : solid[i + nx * (j + ny * k)]!

  // ---- Numeración de nodos activos y lista de elementos ----
  const totalNodes = nodesX * nodesY * (nz + 1)
  const active = new Int32Array(totalNodes).fill(-1)
  let elementCount = 0
  for (let v = 0; v < solid.length; v++) if (solid[v] === 1) elementCount++
  if (elementCount === 0) throw new Error('La voxelización no encontró interior (¿malla abierta?)')

  const elemNodes = new Int32Array(elementCount * 8)
  const elemCoord = new Int32Array(elementCount * 3)
  let nodeCount = 0
  let e = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (solid[i + nx * (j + ny * k)] !== 1) continue
        for (let a = 0; a < 8; a++) {
          const n = nodeIndex(i + (a & 1), j + ((a >> 1) & 1), k + ((a >> 2) & 1))
          if (active[n] === -1) active[n] = nodeCount++
          elemNodes[e * 8 + a] = active[n]!
        }
        elemCoord[e * 3] = i
        elemCoord[e * 3 + 1] = j
        elemCoord[e * 3 + 2] = k
        e++
      }
    }
  }
  const ndof = nodeCount * 3

  // Coordenada de rejilla de cada nodo activo a lo largo del eje de carga
  const nodeAxisPos = new Int32Array(nodeCount)
  for (let iz = 0; iz <= nz; iz++) {
    for (let iy = 0; iy <= ny; iy++) {
      for (let ix = 0; ix <= nx; ix++) {
        const idx = active[nodeIndex(ix, iy, iz)]!
        if (idx !== -1) nodeAxisPos[idx] = axis === 0 ? ix : axis === 1 ? iy : iz
      }
    }
  }

  // ---- Condiciones de contorno por plantilla ----
  const fixFrac = feaCase === 'rod-axial' ? 0.1 : 0.15
  const loadFrac = 0.1
  const fixLayers = Math.max(1, Math.round(fixFrac * nAxis))
  const loadLayers = Math.max(1, Math.round(loadFrac * nAxis))

  // Pistón: la corona es el extremo con la capa de vóxeles más maciza
  let crownAtMax = true
  if (feaCase === 'piston-crown') {
    let atMin = 0
    let atMax = 0
    for (let ee = 0; ee < elementCount; ee++) {
      const p = elemCoord[ee * 3 + axis]!
      if (p === 0) atMin++
      if (p === nAxis - 1) atMax++
    }
    crownAtMax = atMax >= atMin
  }
  // Con la corona en el mínimo, espejamos la coordenada axial y listo
  const axisPos = (raw: number, span: number): number => (crownAtMax ? raw : span - raw)

  const fixed = new Uint8Array(ndof)
  const f = new Float64Array(ndof)

  for (let n = 0; n < nodeCount; n++) {
    if (axisPos(nodeAxisPos[n]!, nAxis) <= fixLayers) {
      fixed[n * 3] = 1
      fixed[n * 3 + 1] = 1
      fixed[n * 3 + 2] = 1
    }
  }

  if (feaCase === 'rod-axial') {
    // 1 N de compresión repartido en los nodos del extremo opuesto
    const loadNodes: number[] = []
    for (let n = 0; n < nodeCount; n++) {
      if (axisPos(nodeAxisPos[n]!, nAxis) >= nAxis - loadLayers) loadNodes.push(n)
    }
    if (loadNodes.length === 0) throw new Error('Sin nodos en la zona de carga')
    const sign = crownAtMax ? -1 : 1
    for (const n of loadNodes) f[n * 3 + axis] = sign / loadNodes.length
  } else {
    // 1 Pa sobre las caras expuestas del tercio de la corona
    const crownZone = Math.ceil(0.65 * nAxis)
    const dOff: [number, number, number] = [0, 0, 0]
    dOff[axis] = crownAtMax ? 1 : -1
    let loaded = 0
    for (let ee = 0; ee < elementCount; ee++) {
      const i = elemCoord[ee * 3]!
      const j = elemCoord[ee * 3 + 1]!
      const k = elemCoord[ee * 3 + 2]!
      if (axisPos(elemCoord[ee * 3 + axis]!, nAxis - 1) < crownZone) continue
      if (voxelAt(i + dOff[0], j + dOff[1], k + dOff[2]) === 1) continue
      // cara expuesta hacia la corona: carga consistente h²/4 por nodo
      const faceBit = crownAtMax ? 1 : 0
      const perNode = (h * h) / 4
      const sign = crownAtMax ? -1 : 1
      for (let a = 0; a < 8; a++) {
        const bit = axis === 0 ? a & 1 : axis === 1 ? (a >> 1) & 1 : (a >> 2) & 1
        if (bit !== faceBit) continue
        f[elemNodes[ee * 8 + a]! * 3 + axis]! += sign * perNode
      }
      loaded++
    }
    if (loaded === 0) throw new Error('Sin caras expuestas en la zona de corona')
  }
  for (let d = 0; d < ndof; d++) if (fixed[d] === 1) f[d] = 0

  // ---- CG sin matriz con precondicionador Jacobi ----
  const Ke = hexStiffness(h, POISSON)
  const diag = new Float64Array(ndof)
  for (let ee = 0; ee < elementCount; ee++) {
    for (let a = 0; a < 8; a++) {
      const base = elemNodes[ee * 8 + a]! * 3
      for (let c = 0; c < 3; c++) diag[base + c]! += Ke[(a * 3 + c) * 24 + a * 3 + c]!
    }
  }
  for (let d = 0; d < ndof; d++) if (diag[d] === 0 || fixed[d] === 1) diag[d] = 1

  const ue = new Float64Array(24)
  const qe = new Float64Array(24)
  const matvec = (p: Float64Array, q: Float64Array): void => {
    q.fill(0)
    for (let ee = 0; ee < elementCount; ee++) {
      for (let a = 0; a < 8; a++) {
        const base = elemNodes[ee * 8 + a]! * 3
        for (let c = 0; c < 3; c++) {
          const d = base + c
          ue[a * 3 + c] = fixed[d] === 1 ? 0 : p[d]!
        }
      }
      for (let r = 0; r < 24; r++) {
        let acc = 0
        const row = r * 24
        for (let c = 0; c < 24; c++) acc += Ke[row + c]! * ue[c]!
        qe[r] = acc
      }
      for (let a = 0; a < 8; a++) {
        const base = elemNodes[ee * 8 + a]! * 3
        for (let c = 0; c < 3; c++) {
          const d = base + c
          if (fixed[d] === 0) q[d]! += qe[a * 3 + c]!
        }
      }
    }
  }

  const x = new Float64Array(ndof)
  const r = Float64Array.from(f)
  const z = new Float64Array(ndof)
  const p = new Float64Array(ndof)
  const q = new Float64Array(ndof)

  const dot = (u: Float64Array, v: Float64Array): number => {
    let s = 0
    for (let d = 0; d < ndof; d++) s += u[d]! * v[d]!
    return s
  }

  const fNorm = Math.sqrt(dot(f, f))
  if (fNorm === 0) throw new Error('Vector de cargas nulo')

  for (let d = 0; d < ndof; d++) z[d] = r[d]! / diag[d]!
  p.set(z)
  let rz = dot(r, z)
  let iterations = 0
  let converged = false

  for (let it = 0; it < maxIterations; it++) {
    iterations = it + 1
    matvec(p, q)
    const pq = dot(p, q)
    if (pq <= 0) break
    const alpha = rz / pq
    for (let d = 0; d < ndof; d++) {
      x[d]! += alpha * p[d]!
      r[d]! -= alpha * q[d]!
    }
    if (Math.sqrt(dot(r, r)) / fNorm < tolerance) {
      converged = true
      break
    }
    for (let d = 0; d < ndof; d++) z[d] = r[d]! / diag[d]!
    const rzNew = dot(r, z)
    const beta = rzNew / rz
    rz = rzNew
    for (let d = 0; d < ndof; d++) p[d] = z[d]! + beta * p[d]!
  }

  // ---- Von Mises por elemento (centro), excluyendo zonas de contorno ----
  const lambda = POISSON / ((1 + POISSON) * (1 - 2 * POISSON))
  const mu = 1 / (2 * (1 + POISSON))
  const c11 = lambda + 2 * mu
  const gc = shapeGradients(0, 0, 0, h)

  const margin = Math.ceil(1.5 * fixLayers)
  const loadMargin = feaCase === 'rod-axial' ? Math.ceil(1.5 * loadLayers) : 0
  const vms: number[] = []

  for (let ee = 0; ee < elementCount; ee++) {
    const pos = axisPos(elemCoord[ee * 3 + axis]!, nAxis - 1)
    if (pos < margin || pos >= nAxis - loadMargin) continue

    let exx = 0
    let eyy = 0
    let ezz = 0
    let gxy = 0
    let gyz = 0
    let gzx = 0
    for (let a = 0; a < 8; a++) {
      const base = elemNodes[ee * 8 + a]! * 3
      const ux = x[base]!
      const uy = x[base + 1]!
      const uz = x[base + 2]!
      const gax = gc[a * 3]!
      const gay = gc[a * 3 + 1]!
      const gaz = gc[a * 3 + 2]!
      exx += gax * ux
      eyy += gay * uy
      ezz += gaz * uz
      gxy += gay * ux + gax * uy
      gyz += gaz * uy + gay * uz
      gzx += gaz * ux + gax * uz
    }
    const tr = lambda * (exx + eyy + ezz)
    const sxx = tr + (c11 - lambda) * exx
    const syy = tr + (c11 - lambda) * eyy
    const szz = tr + (c11 - lambda) * ezz
    const txy = mu * gxy
    const tyz = mu * gyz
    const tzx = mu * gzx
    const vm = Math.sqrt(
      0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (txy * txy + tyz * tyz + tzx * tzx)
    )
    vms.push(vm)
  }
  if (vms.length === 0) throw new Error('Sin elementos fuera de las zonas de contorno')
  vms.sort((a, b) => a - b)
  const vmPerUnit = vms[Math.min(vms.length - 1, Math.floor(vms.length * 0.95))]!

  return {
    feaCase,
    vmPerUnit,
    grid: [nx, ny, nz],
    voxelSize: h,
    elements: elementCount,
    nodes: nodeCount,
    iterations,
    converged
  }
}

// ---------------------------------------------------------------------------
// Refinado de límites (nivel A → nivel B)

const kN = (n: number): string => (n / 1000).toFixed(0)
const mpa = (pa: number): string => (pa / 1e6).toFixed(0)

export function refineRodLimitsWithFea(
  analytic: DerivedLimit[],
  input: ImportedPartInput,
  params: RodParams,
  fea: FeaSummary
): DerivedLimit[] {
  const m = input.material
  const gridTxt = `${fea.grid[0]}×${fea.grid[1]}×${fea.grid[2]}`
  // El FEA lineal no ve pandeo: mantenemos Euler como techo independiente
  const A = input.metrics.minSectionArea
  const I = (1.4 * A * A) / (4 * Math.PI)
  const buckling = (Math.PI * Math.PI * m.youngModulus * I) / (params.centerDistance * params.centerDistance)

  return analytic.map((l) => {
    if (l.variable === 'rodCompression') {
      const yieldFea = m.yieldStrength / fea.vmPerUnit
      const value = Math.min(yieldFea, buckling) / SF
      const governs = yieldFea < buckling ? 'plastificación (FEA)' : 'pandeo de Euler'
      return {
        ...l,
        value,
        provenance: 'derived-fea',
        explanation: `FEA vóxel ${gridTxt} (${fea.elements} elementos): von Mises p95 de ${mpa(fea.vmPerUnit * 1000)} MPa/kN axial → ${governs} a ${kN(value * SF)} kN (÷${SF} seguridad)`
      }
    }
    if (l.variable === 'rodTension') {
      const value = (0.5 * m.fatigueLimit) / fea.vmPerUnit / SF
      return {
        ...l,
        value,
        provenance: 'derived-fea',
        explanation: `FEA vóxel ${gridTxt}: fatiga (${mpa(m.fatigueLimit)} MPa) sobre la tensión real por kN, factor 0.5 por uniones (÷${SF} seguridad)`
      }
    }
    return l
  })
}

export function refinePistonLimitsWithFea(
  analytic: DerivedLimit[],
  input: ImportedPartInput,
  _params: PistonParams,
  fea: FeaSummary
): DerivedLimit[] {
  const m = input.material
  const gridTxt = `${fea.grid[0]}×${fea.grid[1]}×${fea.grid[2]}`
  return analytic.map((l) => {
    if (l.variable === 'peakCylinderPressure') {
      const sigmaAllow = 0.55 * m.yieldStrength
      const value = sigmaAllow / fea.vmPerUnit / SF
      return {
        ...l,
        value,
        provenance: 'derived-fea',
        explanation: `FEA vóxel ${gridTxt} (${fea.elements} elementos): presión en corona con apoyo en falda, von Mises p95 ${fea.vmPerUnit.toFixed(1)}× la presión aplicada; σ_adm=0.55·σy de ${m.name} (÷${SF} seguridad)`
      }
    }
    return l
  })
}
