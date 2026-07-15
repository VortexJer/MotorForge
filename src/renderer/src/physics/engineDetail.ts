import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { CRANK_PHASE } from './sockets'
import type { EngineSockets } from './sockets'

/**
 * Árbol maestro de componentes 3D del motor, montado como un MOTOR
 * SECCIONADO DE EXPOSICIÓN (cutaway): en los niveles de inspección y banco
 * el bloque y la culata tienen la cara frontal abierta para ver el tren
 * alternativo y la distribución APOYADOS en sus soportes reales (bancada,
 * torres de levas); en vista global se muestran las carcasas cerradas para
 * la silueta. Metodología de las guías CAD del usuario: cada pieza nace de
 * su geometría de referencia y se ensambla por sus superficies de contacto
 * (bridas, asientos, apoyos) — nada flota.
 *
 * Rendimiento (§2): estáticos fusionados con mergeGeometries (una malla por
 * material) y tornillería/muelles/válvulas SOLO como InstancedMesh.
 * LOD (§3): tier 0 inspección / tier 1 banco (proxies) / tier 2 global.
 */

export type LodTier = 0 | 1 | 2

/** Pulso electrónico (§4): valores exactos del pliego. */
export const PULSE_COLOR = '#facc15'
export const PULSE_EMISSIVE = '#eab308'
export const PULSE_INTENSITY = 4.5

const CAD_GRAY = '#565e6b'

function cad(color: string, metalness = 0.45, roughness = 0.5): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness })
}

/** Cota del suelo de la celda bajo la bancada (r = radio de muñequilla). */
export function engineFloorY(crankRadius: number): number {
  return -crankRadius - 2.0
}

/** Caja de fundición: cantos redondeados para que la luz dibuje las aristas. */
function casting(w: number, h: number, d: number): RoundedBoxGeometry {
  return new RoundedBoxGeometry(w, h, d, 2, Math.min(0.05, w * 0.2, h * 0.2, d * 0.2))
}

/** Acumula geometrías transformadas y las fusiona en una malla por material. */
class Merger {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>()

  add(geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4): void {
    // normalizar a no-indexado: mergeGeometries exige homogeneidad y
    // RoundedBoxGeometry viene sin índice (si no, descarta el bucket entero)
    const transformed = geo.clone().applyMatrix4(m)
    const g = transformed.index ? transformed.toNonIndexed() : transformed
    if (g !== transformed) transformed.dispose()
    const list = this.buckets.get(mat)
    if (list) list.push(g)
    else this.buckets.set(mat, [g])
    geo.dispose()
  }

  tube(points: THREE.Vector3[], radius: number, mat: THREE.Material, segments = 10): void {
    const path = new THREE.CatmullRomCurve3(points)
    this.add(new THREE.TubeGeometry(path, segments, radius, 8), mat, new THREE.Matrix4())
    // bridas en los extremos: los tubos SIEMPRE terminan en algo
    for (const p of [points[0]!, points[points.length - 1]!]) {
      this.add(new THREE.CylinderGeometry(radius * 1.45, radius * 1.45, 0.05, 10), mat, mat4(p.x, p.y, p.z))
    }
  }

  build(name: string): THREE.Mesh[] {
    const out: THREE.Mesh[] = []
    for (const [mat, geos] of this.buckets) {
      const merged = mergeGeometries(geos, false)
      geos.forEach((g) => g.dispose())
      if (!merged) throw new Error('Merger: bucket con geometrías incompatibles (se perdería la pieza)')
      const mesh = new THREE.Mesh(merged, mat)
      mesh.name = name
      out.push(mesh)
    }
    return out
  }
}

const Q = new THREE.Quaternion()
const V = new THREE.Vector3()
const ONE = new THREE.Vector3(1, 1, 1)

function mat4(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1): THREE.Matrix4 {
  Q.setFromEuler(new THREE.Euler(rx, ry, rz))
  return new THREE.Matrix4().compose(V.set(x, y, z), Q, ONE.clone().multiplyScalar(s))
}

interface InstancedPair {
  fine: THREE.InstancedMesh
  proxy: THREE.InstancedMesh
}

function instancedPair(
  fineGeo: THREE.BufferGeometry,
  mat: THREE.Material,
  matrices: THREE.Matrix4[],
  proxyScale = 1
): InstancedPair {
  const fine = new THREE.InstancedMesh(fineGeo, mat, matrices.length)
  const proxy = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.07 * proxyScale, 0.1 * proxyScale, 0.07 * proxyScale),
    mat,
    matrices.length
  )
  matrices.forEach((m, i) => {
    fine.setMatrixAt(i, m)
    proxy.setMatrixAt(i, m)
  })
  fine.instanceMatrix.needsUpdate = true
  proxy.instanceMatrix.needsUpdate = true
  proxy.visible = false
  return { fine, proxy }
}

export interface EngineDetail {
  root: THREE.Group
  /** Volante + corona + piñón + muñones extremos: hijo del grupo del cigüeñal. */
  crankAttach: THREE.Group
  camIntake: THREE.Group
  camExhaust: THREE.Group
  camSprockets: THREE.Group
  valves: THREE.InstancedMesh
  springs: THREE.InstancedMesh
  buckets: THREE.InstancedMesh
  rodBolts: THREE.InstancedMesh
  glowInjector: THREE.MeshStandardMaterial[]
  glowCoil: THREE.MeshStandardMaterial[]
  /** Bomba de gasolina de alta presión: destella con cada ciclo de inyección. */
  glowPump: THREE.MeshStandardMaterial
  /** Aspas del electroventilador doble: las gira la escena según el caudal de agua. */
  fanBlades: THREE.Group[]
  tier: LodTier
  dispose(): void
  /** Cinemática de distribución + LOD + vista seccionada/cerrada. */
  update(thetaVisual: number, tier: LodTier, cutaway?: boolean): void
}

export function buildEngineDetail(sockets: EngineSockets, cylinders: number): EngineDetail {
  const { spacing, crankRadius: r, boreRadius: boreR, block } = sockets
  const deckY = block.deckY
  const cyls = cylinders
  const halfW = (spacing * (cyls + 1)) / 2
  /** Extremos visuales del cigüeñal del rig (PhysicsLab): spacing·(cyls+0.6)/2. */
  const shaftHalf = (spacing * (cyls + 0.6)) / 2
  const frontX = -halfW - 0.15 // plano de distribución, pegado a la cara frontal
  const rearX = halfW + 0.3 // volante, pegado a la cara trasera
  const panTop = -r - 0.5
  const panBottom = -r - 0.92
  const blockD = boreR * 3.44 // profundidad del bloque en Z
  const wallZ = blockD / 2

  const root = new THREE.Group()
  root.name = 'engine-detail'

  // materiales PBR diferenciados: aluminio mecanizado, chapa lacada, acero,
  // fundición rugosa, goma y latón — con el mapa de entorno cobran volumen
  const mAlu = cad('#8891a0', 0.55, 0.38)
  const mDark = cad('#2e343d', 0.25, 0.6)
  const mSteel = cad('#aab3c0', 0.8, 0.32)
  const mCast = cad('#5a544c', 0.3, 0.72)
  const mHose = cad('#1e2228', 0.05, 0.9)
  const mBrass = cad('#a08b58', 0.85, 0.42)

  const closed = new Merger() // carcasas cerradas: SOLO vista global
  const cut = new Merger() // carcasa seccionada: inspección y banco
  const always = new Merger() // cárter, tapa: visibles siempre
  const detail = new Merger() // tuberías, colectores, sensores: fuera en global
  const fineStatic = new Merger() // menudencias: solo inspección

  // ===================================================== BLOQUE (cutaway)
  const blockH = deckY - panTop
  // cerrado (silueta): bloque completo + tapa de distribución frontal
  closed.add(casting(halfW * 2, blockH, blockD), mAlu, mat4(0, panTop + blockH / 2, 0))
  closed.add(casting(0.5, blockH * 0.9, blockD * 0.9), mAlu, mat4(frontX, panTop + blockH / 2, 0))
  // seccionado: pared trasera, dos testeros, faldón frontal bajo y banda del deck
  cut.add(new THREE.BoxGeometry(halfW * 2, blockH, 0.14), mAlu, mat4(0, panTop + blockH / 2, -wallZ + 0.07))
  for (const ex of [-halfW, halfW]) {
    cut.add(new THREE.BoxGeometry(0.14, blockH, blockD), mAlu, mat4(ex + (ex < 0 ? 0.07 : -0.07), panTop + blockH / 2, 0))
  }
  cut.add(new THREE.BoxGeometry(halfW * 2, 0.8, 0.12), mAlu, mat4(0, panTop + 0.4, wallZ - 0.06)) // faldón del cárter
  cut.add(new THREE.BoxGeometry(halfW * 2, 0.42, 0.12), mAlu, mat4(0, deckY - 0.21, wallZ - 0.06)) // banda del deck
  // apoyos de bancada (bulkheads): el cigüeñal DESCANSA aquí
  const mainCapMs: THREE.Matrix4[] = []
  for (let b = 0; b <= cyls; b++) {
    const x = -halfW + spacing * 0.5 + b * spacing
    cut.add(new THREE.BoxGeometry(0.18, deckY - 0.5, blockD - 0.5), mAlu, mat4(x, (deckY - 0.5) / 2 + 0.25, 0))
    // sombrerete de bancada abrazando el muñón
    cut.add(new THREE.BoxGeometry(0.26, 0.5, boreR * 0.9), mDark, mat4(x, -0.28, 0))
    // semicojinete (nivel fino)
    fineStatic.add(
      new THREE.CylinderGeometry(boreR * 0.19, boreR * 0.19, 0.2, 10, 1, false, 0, Math.PI),
      mBrass,
      mat4(x, 0, 0, 0, 0, Math.PI / 2)
    )
    mainCapMs.push(mat4(x - 0.09, -0.5, 0), mat4(x + 0.09, -0.5, 0))
  }
  // galerías de refrigeración y aceite en la pared trasera
  detail.add(new THREE.CylinderGeometry(0.08, 0.08, halfW * 2 - 0.5, 8), mAlu, mat4(0, deckY - 0.55, -wallZ + 0.16, 0, 0, Math.PI / 2))
  detail.add(new THREE.CylinderGeometry(0.06, 0.06, halfW * 2 - 0.5, 8), mBrass, mat4(0, panTop + 0.9, -wallZ + 0.16, 0, 0, Math.PI / 2))

  // Cárter: bañera fijada a la base del bloque (siempre visible)
  always.add(new THREE.BoxGeometry(halfW * 2, 0.1, blockD), mDark, mat4(0, panTop - 0.05, 0))
  always.add(casting(halfW * 1.7, panTop - panBottom, blockD * 0.72), mDark, mat4(0, (panTop + panBottom) / 2, 0))

  // ---- bancada de ensayo: el motor está MONTADO, no flotando ----
  const floorY = engineFloorY(r)
  for (const ex of [-1, 1]) {
    const colX = ex * (halfW + 0.34)
    always.add(casting(0.5, deckY * 0.4 - floorY, 0.8), mDark, mat4(colX, (deckY * 0.4 + floorY) / 2, 0))
    always.add(casting(1.1, 0.12, 1.3), mDark, mat4(colX, floorY + 0.06, 0)) // pie
    always.add(casting(0.5, 0.16, 0.6), mSteel, mat4(ex * (halfW + 0.06), deckY * 0.36, 0)) // brazo de anclaje
  }
  always.add(casting(halfW * 2 + 1.4, 0.14, 0.5), mDark, mat4(0, floorY + 0.07, 0)) // travesaño
  detail.add(new THREE.BoxGeometry(halfW * 1.72, 0.04, blockD * 0.74), mHose, mat4(0, panTop - 0.11, 0)) // junta de cárter

  // ===================================================== CULATA (cutaway)
  const headH = 1.15
  const headTop = deckY + 0.05 + headH
  closed.add(casting(halfW * 2, headH, blockD * 0.93), mAlu, mat4(0, deckY + 0.05 + headH / 2, 0))
  // seccionada: pared trasera, testeros, placa portalevas y murete frontal bajo
  cut.add(new THREE.BoxGeometry(halfW * 2, headH, 0.14), mAlu, mat4(0, deckY + 0.05 + headH / 2, -wallZ * 0.93 + 0.07))
  for (const ex of [-halfW, halfW]) {
    cut.add(new THREE.BoxGeometry(0.14, headH, blockD * 0.93), mAlu, mat4(ex + (ex < 0 ? 0.07 : -0.07), deckY + 0.05 + headH / 2, 0))
  }
  cut.add(new THREE.BoxGeometry(halfW * 2, 0.16, blockD * 0.93), mAlu, mat4(0, headTop - 0.08, 0)) // placa portalevas
  cut.add(new THREE.BoxGeometry(halfW * 2, 0.26, 0.12), mAlu, mat4(0, deckY + 0.18, wallZ * 0.93 - 0.06)) // murete frontal
  // torres de apoyo de los árboles de levas (las levas DESCANSAN aquí)
  const camY = headTop - 0.34
  const camZ = boreR * 0.62
  for (let b = 0; b <= cyls; b++) {
    const x = -halfW + spacing * 0.5 + b * spacing
    for (const z of [camZ, -camZ]) {
      cut.add(new THREE.BoxGeometry(0.16, headTop - 0.16 - camY + 0.12, 0.3), mAlu, mat4(x, (camY + headTop - 0.16) / 2 - 0.02, z))
    }
  }
  // tapa de balancines nervada + tapón de aceite + su junta
  always.add(casting(halfW * 2, 0.32, blockD * 0.88), mDark, mat4(0, headTop + 0.16, 0))
  for (let rb = 0; rb < 5; rb++) {
    always.add(
      casting(halfW * 1.7, 0.06, 0.13),
      mDark,
      mat4(0, headTop + 0.34, -blockD * 0.32 + rb * blockD * 0.16)
    )
  }
  always.add(new THREE.CylinderGeometry(0.16, 0.17, 0.1, 12), mHose, mat4(-halfW * 0.62, headTop + 0.37, blockD * 0.2))
  detail.add(new THREE.BoxGeometry(halfW * 1.96, 0.035, blockD * 0.86), mHose, mat4(0, headTop + 0.005, 0))
  // junta de culata multicapa sobre el deck
  detail.add(new THREE.BoxGeometry(halfW * 2, 0.035, blockD * 0.95), mBrass, mat4(0, deckY + 0.025, 0))

  // puertos con brida en ambos laterales de la culata
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    detail.add(new THREE.CylinderGeometry(boreR * 0.2, boreR * 0.22, 0.24, 10), mAlu, mat4(cx, deckY + 0.6, wallZ * 0.93 + 0.02, Math.PI / 2, 0, 0))
    detail.add(new THREE.CylinderGeometry(boreR * 0.18, boreR * 0.2, 0.24, 10), mCast, mat4(cx, deckY + 0.52, -wallZ * 0.93 - 0.02, Math.PI / 2, 0, 0))
  }

  // ---- árboles de levas: eje que llega hasta el plano de distribución ----
  const camLen = halfW - 0.1 - frontX // desde el piñón hasta el testero trasero
  const camCenterX = (frontX + (halfW - 0.1)) / 2
  const buildCam = (z: number): THREE.Group => {
    const g = new THREE.Group()
    g.position.set(0, camY, z)
    const parts = new Merger()
    parts.add(new THREE.CylinderGeometry(0.08, 0.08, camLen, 10), mSteel, mat4(camCenterX, 0, 0, 0, 0, Math.PI / 2))
    for (let i = 0; i < cyls; i++) {
      for (const k of [-1, 1]) {
        parts.add(new THREE.CylinderGeometry(0.15, 0.15, 0.09, 12), mSteel, mat4(block.cylinders[i]!.x + k * boreR * 0.34, 0.045, 0, 0, 0, Math.PI / 2))
      }
    }
    // piñón de leva en el extremo frontal, SOBRE el propio eje
    parts.add(new THREE.CylinderGeometry(0.32, 0.32, 0.1, 16), mSteel, mat4(frontX, 0, 0, 0, 0, Math.PI / 2))
    parts.build('cam').forEach((m) => g.add(m))
    return g
  }
  const camIntake = buildCam(camZ)
  const camExhaust = buildCam(-camZ)
  root.add(camIntake, camExhaust)
  const camSprockets = new THREE.Group() // integrados en los ejes; se conserva por contrato
  root.add(camSprockets)

  // válvulas con asiento: platillo a ras del deck, muelle sentado en la culata
  const valveGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.032, 0.032, 0.62, 8).translate(0, 0.31, 0),
    new THREE.CylinderGeometry(0.15, 0.09, 0.055, 12)
  ])!
  const valveMs: THREE.Matrix4[] = []
  const valveMeta: Array<{ cyl: number; exhaust: boolean; x: number; z: number; scale: number }> = []
  for (let i = 0; i < cyls; i++) {
    for (const side of [1, -1]) {
      for (const k of [-1, 1]) {
        const x = block.cylinders[i]!.x + k * boreR * 0.34
        const z = side * boreR * 0.4
        const scale = side === 1 ? 1.0 : 0.86
        valveMeta.push({ cyl: i, exhaust: side === -1, x, z, scale })
        valveMs.push(mat4(x, deckY + 0.08, z, 0, 0, 0, scale))
        // asiento de válvula mecanizado (nivel fino)
        fineStatic.add(new THREE.TorusGeometry(0.15 * scale, 0.022, 6, 14), mBrass, mat4(x, deckY + 0.07, z, Math.PI / 2, 0, 0))
      }
    }
  }
  const valves = new THREE.InstancedMesh(valveGeo, mSteel, valveMs.length)
  valveMs.forEach((m, i) => valves.setMatrixAt(i, m))
  valves.name = 'valves'
  root.add(valves)

  const springGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.1, 0.1, 0.32, 10, 4, true),
    new THREE.CylinderGeometry(0.11, 0.11, 0.04, 10).translate(0, 0.18, 0)
  ])!
  const springs = new THREE.InstancedMesh(springGeo, mSteel, valveMs.length)
  const buckets = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 10), mDark, valveMs.length)
  root.add(springs, buckets)

  // cadena de distribución envolviendo piñón de cigüeñal y piñones de levas
  const chainPts = [
    new THREE.Vector3(frontX, -0.28, 0.1),
    new THREE.Vector3(frontX, camY * 0.35, camZ + 0.42),
    new THREE.Vector3(frontX, camY, camZ + 0.34),
    new THREE.Vector3(frontX, camY + 0.4, 0),
    new THREE.Vector3(frontX, camY, -camZ - 0.34),
    new THREE.Vector3(frontX, camY * 0.35, -camZ - 0.42),
    new THREE.Vector3(frontX, -0.28, -0.1)
  ]
  detail.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(chainPts, true), 40, 0.04, 6, true), mSteel, new THREE.Matrix4())
  // guía de deslizamiento y tensor hidráulico apoyados en la cara frontal
  detail.add(new THREE.BoxGeometry(0.08, camY * 0.8, 0.16), mHose, mat4(frontX + 0.12, camY * 0.5, camZ + 0.34, 0.12, 0, 0))
  detail.add(new THREE.BoxGeometry(0.12, 0.3, 0.16), mDark, mat4(frontX + 0.14, camY * 0.5, -camZ - 0.34))

  // ===================================================== TURBO Y FLUIDOS
  // colector de escape → caja colectora → brida → turbina (todo encadenado)
  const colX = halfW * 0.55
  const colY = deckY - 0.1
  const colZ = -wallZ - 0.7
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    detail.tube(
      [
        new THREE.Vector3(cx, deckY + 0.52, -wallZ * 0.93 - 0.12),
        new THREE.Vector3(cx + (colX - cx) * 0.5, deckY + 0.15, colZ + 0.25),
        new THREE.Vector3(colX, colY, colZ + 0.1)
      ],
      0.13,
      mCast,
      8
    )
  }
  detail.add(casting(0.55, 0.42, 0.45), mCast, mat4(colX, colY, colZ)) // caja colectora
  const turbX = colX + 0.75
  const turbY = colY
  const turbZ = colZ
  detail.add(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 10), mCast, mat4(colX + 0.4, colY, colZ, 0, 0, Math.PI / 2)) // brida colector→turbina
  closed.add(new THREE.TorusGeometry(0.48, 0.24, 10, 20), mCast, mat4(turbX, turbY, turbZ, 0, Math.PI / 2, 0)) // caracola turbina
  cut.add(new THREE.TorusGeometry(0.48, 0.24, 10, 20), mCast, mat4(turbX, turbY, turbZ, 0, Math.PI / 2, 0))
  detail.add(new THREE.CylinderGeometry(0.11, 0.11, 0.62, 10), mSteel, mat4(turbX + 0.35, turbY, turbZ, 0, 0, Math.PI / 2)) // eje central
  closed.add(new THREE.TorusGeometry(0.45, 0.22, 10, 20), mAlu, mat4(turbX + 0.72, turbY, turbZ, 0, Math.PI / 2, 0)) // caracola compresor
  cut.add(new THREE.TorusGeometry(0.45, 0.22, 10, 20), mAlu, mat4(turbX + 0.72, turbY, turbZ, 0, Math.PI / 2, 0))
  // wastegate MONTADA sobre la caracola de turbina, varilla al actuador
  detail.add(new THREE.CylinderGeometry(0.16, 0.16, 0.14, 12), mDark, mat4(turbX - 0.15, turbY + 0.56, turbZ + 0.12, 0.4, 0, 0))
  detail.add(new THREE.CylinderGeometry(0.025, 0.025, 0.42, 6), mSteel, mat4(turbX - 0.08, turbY + 0.35, turbZ + 0.18, 0.9, 0, 0))
  // bajante de escape
  detail.tube(
    [new THREE.Vector3(turbX, turbY - 0.45, turbZ), new THREE.Vector3(turbX + 0.2, panTop, turbZ - 0.2)],
    0.15,
    mCast,
    6
  )

  // plénum + mariposa + ramales que ATERRIZAN en las bridas de admisión
  const plenumZ = wallZ + 0.75
  const plenumY = deckY + 0.72
  closed.add(new THREE.CylinderGeometry(0.4, 0.4, halfW * 1.7, 12), mDark, mat4(0, plenumY, plenumZ, 0, 0, Math.PI / 2))
  cut.add(new THREE.CylinderGeometry(0.4, 0.4, halfW * 1.7, 12), mDark, mat4(0, plenumY, plenumZ, 0, 0, Math.PI / 2))
  const tbX = -halfW * 0.85 - 0.28
  detail.add(new THREE.CylinderGeometry(0.28, 0.28, 0.46, 12), mAlu, mat4(tbX, plenumY, plenumZ, 0, 0, Math.PI / 2)) // cuerpo de mariposa
  detail.add(new THREE.CylinderGeometry(0.25, 0.25, 0.03, 12), mSteel, mat4(tbX, plenumY, plenumZ, 0, 0.5, Math.PI / 2)) // mariposa
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    detail.tube(
      [new THREE.Vector3(cx, deckY + 0.6, wallZ * 0.93 + 0.14), new THREE.Vector3(cx, plenumY - 0.18, plenumZ - 0.28)],
      0.12,
      mAlu,
      6
    )
  }

  // aceite del turbo: suministro fino desde la galería y retorno al cárter
  detail.tube(
    [new THREE.Vector3(halfW * 0.8, panTop + 0.9, -wallZ + 0.2), new THREE.Vector3(turbX + 0.35, turbY + 0.12, turbZ + 0.1)],
    0.032,
    mSteel,
    8
  )
  detail.tube(
    [new THREE.Vector3(turbX + 0.35, turbY - 0.14, turbZ + 0.1), new THREE.Vector3(halfW * 0.75, panTop - 0.2, -wallZ * 0.5)],
    0.05,
    mSteel,
    8
  )
  // rampa de inyección sobre los inyectores + línea de combustible a la rampa
  detail.add(new THREE.CylinderGeometry(0.08, 0.08, halfW * 1.6, 8), mSteel, mat4(0, deckY + 1.02, wallZ * 0.93 + 0.28, 0, 0, Math.PI / 2))
  detail.tube(
    [new THREE.Vector3(halfW * 0.8, deckY + 1.02, wallZ * 0.93 + 0.28), new THREE.Vector3(halfW + 0.3, panTop + 0.4, wallZ * 0.6)],
    0.035,
    mSteel,
    8
  )

  // ============================================ RADIADOR E INTERCOOLER
  // radiador frontal: núcleo con aletas + dos tanques; los manguitos van
  // DEL motor AL radiador (nada acaba en el aire)
  const radX = -halfW - 1.55
  detail.add(casting(0.22, 2.5, blockD * 1.7), mDark, mat4(radX, 0.7, 0))
  for (let f = 0; f < 12; f++) {
    detail.add(new THREE.BoxGeometry(0.16, 0.035, blockD * 1.6), mSteel, mat4(radX, -0.4 + f * 0.2, 0))
  }
  for (const tz of [-1, 1]) {
    detail.add(casting(0.26, 2.5, 0.3), mDark, mat4(radX, 0.7, tz * (blockD * 0.85 + 0.14)))
  }
  // termostato en la culata + manguito superior al tanque; inferior desde el bloque
  detail.add(new THREE.CylinderGeometry(0.14, 0.16, 0.2, 10), mAlu, mat4(-halfW - 0.08, deckY - 0.3, wallZ * 0.45, 0, 0, Math.PI / 2))
  detail.tube(
    [new THREE.Vector3(-halfW - 0.16, deckY - 0.3, wallZ * 0.45), new THREE.Vector3(radX + 0.15, 1.75, blockD * 0.85)],
    0.11,
    mHose,
    8
  )
  detail.tube(
    [new THREE.Vector3(-halfW - 0.05, panTop + 0.85, wallZ * 0.45), new THREE.Vector3(radX + 0.15, -0.35, blockD * 0.85)],
    0.11,
    mHose,
    8
  )
  for (const hy of [deckY - 0.32, panTop + 0.83]) {
    fineStatic.add(new THREE.TorusGeometry(0.12, 0.02, 6, 12), mSteel, mat4(-halfW - 0.2, hy, wallZ * 0.46, 0, Math.PI / 2, 0.2))
  }
  // intercooler bajo el radiador + tubería completa caliente/fría
  detail.add(casting(0.22, 1.0, blockD * 1.5), mAlu, mat4(radX, -1.45, 0))
  for (const tz of [-1, 1]) detail.add(casting(0.26, 1.0, 0.28), mDark, mat4(radX, -1.45, tz * (blockD * 0.75 + 0.13)))
  detail.tube(
    [
      new THREE.Vector3(turbX + 0.72, turbY + 0.42, turbZ),
      new THREE.Vector3(halfW + 0.5, deckY * 0.35, -wallZ - 0.55),
      new THREE.Vector3(0, -0.6, -wallZ - 0.6),
      new THREE.Vector3(radX + 0.2, -1.35, -(blockD * 0.75 + 0.1))
    ],
    0.15,
    mAlu,
    18
  )
  detail.tube(
    [
      new THREE.Vector3(radX + 0.2, -1.35, blockD * 0.75 + 0.1),
      new THREE.Vector3(-halfW - 0.75, 1.1, wallZ + 0.7),
      new THREE.Vector3(tbX - 0.28, plenumY, plenumZ)
    ],
    0.15,
    mAlu,
    14
  )

  // ============================================ CORREA DE ACCESORIOS
  const beltX = frontX - 0.34
  // alternador con soporte + bomba de agua + tensor (poleas coplanarias)
  detail.add(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 14), mSteel, mat4(beltX + 0.28, 2.15, -1.05, 0, 0, Math.PI / 2))
  detail.add(new THREE.CylinderGeometry(0.18, 0.18, 0.09, 12), mSteel, mat4(beltX, 2.15, -1.05, 0, 0, Math.PI / 2))
  detail.add(new THREE.BoxGeometry(0.5, 0.16, 0.5), mAlu, mat4(-halfW - 0.2, 2.0, -0.85, 0, 0, 0.4)) // soporte
  detail.add(new THREE.CylinderGeometry(0.2, 0.2, 0.09, 12), mSteel, mat4(beltX, 0.95, 0.4, 0, 0, Math.PI / 2)) // polea bomba de agua
  detail.add(new THREE.CylinderGeometry(0.13, 0.13, 0.09, 10), mSteel, mat4(beltX, 1.5, -0.32, 0, 0, Math.PI / 2)) // tensor
  // correa: bucle cerrado alrededor de las cuatro poleas
  const beltLoop: THREE.Vector3[] = [
    new THREE.Vector3(beltX, -0.42, 0),
    new THREE.Vector3(beltX, 0.5, 0.58),
    new THREE.Vector3(beltX, 0.95, 0.62),
    new THREE.Vector3(beltX, 1.55, -0.12),
    new THREE.Vector3(beltX, 2.35, -0.95),
    new THREE.Vector3(beltX, 2.05, -1.32),
    new THREE.Vector3(beltX, 0.55, -0.5)
  ]
  detail.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(beltLoop, true), 44, 0.045, 6, true), mHose, new THREE.Matrix4())

  // ============================================ ARRANQUE, ACEITE Y ESCAPE
  detail.add(new THREE.CylinderGeometry(0.24, 0.24, 0.6, 12), mSteel, mat4(halfW + 0.25, -0.45, 0.55, 0, 0, Math.PI / 2)) // motor de arranque
  detail.add(new THREE.CylinderGeometry(0.13, 0.13, 0.4, 10), mSteel, mat4(halfW + 0.2, -0.18, 0.78, 0, 0, Math.PI / 2)) // solenoide
  detail.add(new THREE.CylinderGeometry(0.17, 0.17, 0.34, 12), mSteel, mat4(halfW * 0.35, panTop + 0.42, -wallZ - 0.18, Math.PI / 2, 0, 0)) // filtro de aceite
  // bajante completa: turbina → resonador → cola
  detail.tube(
    [
      new THREE.Vector3(turbX, turbY - 0.45, turbZ),
      new THREE.Vector3(turbX - 0.3, floorY + 0.5, turbZ - 0.25),
      new THREE.Vector3(turbX - 1.1, floorY + 0.42, turbZ - 0.3)
    ],
    0.14,
    mCast,
    10
  )
  detail.add(casting(0.95, 0.34, 0.42), mSteel, mat4(turbX - 1.65, floorY + 0.42, turbZ - 0.3))
  detail.tube(
    [new THREE.Vector3(turbX - 2.1, floorY + 0.42, turbZ - 0.3), new THREE.Vector3(-halfW - 0.6, floorY + 0.4, turbZ - 0.3)],
    0.12,
    mSteel,
    6
  )
  // varilla de aceite
  detail.tube(
    [new THREE.Vector3(halfW * 0.18, panTop + 0.4, wallZ + 0.02), new THREE.Vector3(halfW * 0.12, deckY + 0.3, wallZ + 0.22)],
    0.024,
    mBrass,
    6
  )
  fineStatic.add(new THREE.TorusGeometry(0.07, 0.018, 6, 12), mBrass, mat4(halfW * 0.12, deckY + 0.38, wallZ + 0.22))

  // ============================================ CIRCUITO DE LUBRICACIÓN
  // bomba de aceite trocoidal en el frontal bajo, accionada por el cigüeñal
  always.add(casting(0.44, 0.44, 0.4), mAlu, mat4(-halfW - 0.26, -0.5, 0.12))
  detail.add(new THREE.CylinderGeometry(0.06, 0.06, 0.35, 8), mSteel, mat4(-halfW - 0.05, -0.35, 0.08, 0, 0, Math.PI / 2)) // eje de accionamiento
  fineStatic.add(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 8), mBrass, mat4(-halfW - 0.26, -0.2, 0.12)) // válvula de alivio
  fineStatic.add(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8), mSteel, mat4(-halfW - 0.26, -0.1, 0.12)) // muelle de la válvula
  // tuberías rígidas de presión (bomba→galería) y retorno (culata→cárter)
  detail.tube(
    [new THREE.Vector3(-halfW - 0.26, -0.28, 0.12), new THREE.Vector3(-halfW - 0.06, deckY * 0.35, -wallZ * 0.5), new THREE.Vector3(-halfW + 0.3, panTop + 0.9, -wallZ + 0.2)],
    0.045,
    mSteel,
    10
  )
  detail.tube(
    [new THREE.Vector3(-halfW + 0.2, deckY + 0.4, -wallZ * 0.6), new THREE.Vector3(-halfW - 0.1, panTop + 0.3, -wallZ * 0.4)],
    0.05,
    mSteel,
    8
  )
  // enfriador de aceite de placas + latiguillos trenzados al filtro
  detail.add(casting(0.5, 0.34, 0.24), mAlu, mat4(0.4, panTop + 0.55, -wallZ - 0.42))
  for (let p = 0; p < 6; p++) {
    detail.add(new THREE.BoxGeometry(0.46, 0.028, 0.2), mSteel, mat4(0.4, panTop + 0.43 + p * 0.05, -wallZ - 0.42))
  }
  detail.tube(
    [new THREE.Vector3(0.62, panTop + 0.55, -wallZ - 0.4), new THREE.Vector3(halfW * 0.35, panTop + 0.5, -wallZ - 0.22)],
    0.045,
    mSteel,
    6
  )
  detail.tube(
    [new THREE.Vector3(0.18, panTop + 0.55, -wallZ - 0.4), new THREE.Vector3(halfW * 0.3, panTop + 0.32, -wallZ - 0.18)],
    0.045,
    mSteel,
    6
  )

  // ============================================ REFRIGERACIÓN: BOMBA E IMPULSOR
  // carcasa dedicada (se vuelve translúcida en inspección para ver el rodete)
  const pumpHousingMat = cad('#8891a0', 0.5, 0.4)
  const pumpHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.42, 14), pumpHousingMat)
  pumpHousing.rotation.z = Math.PI / 2
  pumpHousing.position.set(beltX + 0.36, 0.95, 0.4)
  root.add(pumpHousing)
  const impeller = new THREE.Group()
  impeller.position.set(beltX + 0.36, 0.95, 0.4)
  {
    const impParts = new Merger()
    impParts.add(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 8), mSteel, mat4(0, 0, 0, 0, 0, Math.PI / 2))
    for (let b = 0; b < 6; b++) {
      const a = (b / 6) * Math.PI * 2
      impParts.add(new THREE.BoxGeometry(0.05, 0.05, 0.2), mBrass, mat4(0.02, Math.cos(a) * 0.13, Math.sin(a) * 0.13, a, 0, 0))
    }
    impParts.build('impeller').forEach((m) => impeller.add(m))
  }
  impeller.name = 'lod-fine'
  root.add(impeller)
  // muelle obturador del termostato
  fineStatic.add(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 8, 3, true), mSteel, mat4(-halfW - 0.08, deckY - 0.3, wallZ * 0.45, 0, 0, Math.PI / 2))
  // vaso de expansión junto al radiador + manguito al cuello
  detail.add(casting(0.3, 0.42, 0.26), mAlu, mat4(radX + 0.55, 2.0, -1.3))
  detail.add(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 10), mHose, mat4(radX + 0.55, 2.25, -1.3))
  detail.tube(
    [new THREE.Vector3(radX + 0.42, 1.95, -1.28), new THREE.Vector3(radX + 0.12, 1.8, -(blockD * 0.85))],
    0.04,
    mHose,
    6
  )
  // electroventilador doble tras el radiador (soporte básico + aspas)
  const fanBlades: THREE.Group[] = []
  for (const fz of [-0.72, 0.72]) {
    always.add(casting(0.1, 1.12, 1.12), mDark, mat4(radX + 0.26, 0.7, fz))
    const blades = new THREE.Group()
    blades.position.set(radX + 0.36, 0.7, fz)
    const bParts = new Merger()
    bParts.add(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 10), mDark, mat4(0, 0, 0, 0, 0, Math.PI / 2))
    for (let b = 0; b < 5; b++) {
      const a = (b / 5) * Math.PI * 2
      bParts.add(new THREE.BoxGeometry(0.035, 0.1, 0.4), mDark, mat4(0, Math.cos(a) * 0.28, Math.sin(a) * 0.28, a + 0.5, 0, 0))
    }
    bParts.build('fan').forEach((m) => blades.add(m))
    blades.name = 'lod-detail'
    root.add(blades)
    fanBlades.push(blades)
  }

  // ============================================ ALIMENTACIÓN DE COMBUSTIBLE
  // bomba de alta presión accionada por el árbol de admisión (testero trasero)
  detail.add(new THREE.CylinderGeometry(0.15, 0.17, 0.3, 10), mSteel, mat4(halfW + 0.14, camY, camZ, 0, 0, Math.PI / 2))
  const glowPump = cad(CAD_GRAY)
  const pumpCap = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.14), glowPump)
  pumpCap.position.set(halfW + 0.32, camY, camZ)
  pumpCap.name = 'lod-detail'
  root.add(pumpCap)
  detail.tube(
    [new THREE.Vector3(halfW + 0.2, camY - 0.12, camZ), new THREE.Vector3(halfW * 0.82, deckY + 1.02, wallZ * 0.93 + 0.28)],
    0.03,
    mSteel,
    8
  )
  // regulador de presión en el retorno de la rampa + línea de retorno
  detail.add(new THREE.CylinderGeometry(0.09, 0.09, 0.14, 10), mSteel, mat4(-halfW * 0.82, deckY + 1.02, wallZ * 0.93 + 0.28))
  detail.tube(
    [new THREE.Vector3(-halfW * 0.82, deckY + 0.95, wallZ * 0.93 + 0.28), new THREE.Vector3(-halfW - 0.5, panTop - 0.2, wallZ * 0.55)],
    0.028,
    mSteel,
    8
  )
  // filtro de alto flujo en la línea de entrada
  detail.add(new THREE.CylinderGeometry(0.09, 0.09, 0.3, 10), mAlu, mat4(halfW + 0.28, panTop + 0.4, wallZ * 0.6, 0.9, 0, 0))

  // ============================================ CABLEADO (mazo + caídas)
  detail.add(
    new THREE.CylinderGeometry(0.045, 0.045, halfW * 1.7, 8),
    mHose,
    mat4(0, headTop + 0.3, blockD * 0.46, 0, 0, Math.PI / 2)
  )
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    fineStatic.add(new THREE.CylinderGeometry(0.02, 0.02, 0.34, 6), mHose, mat4(cx, headTop + 0.46, blockD * 0.24, 0.75, 0, 0))
    fineStatic.add(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), mHose, mat4(cx + 0.1, deckY + 1.05, wallZ * 0.93 + 0.34, 0.3, 0, 0.4))
  }

  // ===================================================== TORNILLERÍA
  const boltGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.045, 0.045, 0.2, 8),
    new THREE.CylinderGeometry(0.075, 0.075, 0.05, 6).translate(0, 0.12, 0)
  ])!
  const headBoltMs: THREE.Matrix4[] = []
  for (let i = 0; i < cyls; i++) {
    for (const [dx, dz] of [
      [-boreR * 0.8, -boreR * 1.0],
      [boreR * 0.8, -boreR * 1.0],
      [-boreR * 0.8, boreR * 1.0],
      [boreR * 0.8, boreR * 1.0]
    ]) {
      headBoltMs.push(mat4(block.cylinders[i]!.x + dx!, headTop + 0.02, dz!))
    }
  }
  const headBolts = instancedPair(boltGeo.clone(), mSteel, headBoltMs, 1.2)
  const mainBolts = instancedPair(boltGeo.clone().scale(0.9, 0.9, 0.9), mSteel, mainCapMs)
  const periMs: THREE.Matrix4[] = []
  for (let i = 0; i < 10; i++) periMs.push(mat4(-halfW * 0.9 + (i * halfW * 1.8) / 9, headTop + 0.34, blockD * 0.42, 0, 0, 0, 0.55))
  for (let i = 0; i < 10; i++) periMs.push(mat4(-halfW * 0.82 + (i * halfW * 1.64) / 9, panTop - 0.13, blockD * 0.34, 0, 0, 0, 0.55))
  for (let a = 0; a < 6; a++) {
    periMs.push(mat4(turbX + 0.35, turbY + 0.5 * Math.sin((a * Math.PI) / 3), turbZ + 0.5 * Math.cos((a * Math.PI) / 3), Math.PI / 2, 0, 0, 0.5))
  }
  // pernos allen de las bombas y accesorios (obligatoriamente instanciados)
  for (let a = 0; a < 4; a++) {
    const ang = (a * Math.PI) / 2 + 0.4
    periMs.push(mat4(beltX + 0.5, 0.95 + Math.cos(ang) * 0.36, 0.4 + Math.sin(ang) * 0.36, 0, 0, Math.PI / 2, 0.45)) // bomba de agua
    periMs.push(mat4(-halfW - 0.05, -0.5 + Math.cos(ang) * 0.26, 0.12 + Math.sin(ang) * 0.26, 0, 0, Math.PI / 2, 0.45)) // bomba de aceite
  }
  for (const fz of [-0.72, 0.72]) {
    periMs.push(mat4(radX + 0.3, 1.28, fz + 0.5, 0, 0, Math.PI / 2, 0.4), mat4(radX + 0.3, 0.12, fz - 0.5, 0, 0, Math.PI / 2, 0.4)) // ventiladores
  }
  periMs.push(mat4(halfW + 0.02, camY + 0.2, camZ, 0, 0, Math.PI / 2, 0.45)) // bomba de gasolina
  periMs.push(mat4(halfW + 0.02, camY - 0.2, camZ, 0, 0, Math.PI / 2, 0.45))
  periMs.push(mat4(-halfW - 0.35, 2.15, -0.8, 0, 0, Math.PI / 2, 0.5)) // alternador
  const periBolts = instancedPair(boltGeo.clone(), mSteel, periMs, 0.7)
  const rodBolts = new THREE.InstancedMesh(boltGeo.clone().scale(0.7, 0.7, 0.7), mSteel, cyls * 2)
  rodBolts.frustumCulled = false
  root.add(headBolts.fine, headBolts.proxy, mainBolts.fine, mainBolts.proxy, periBolts.fine, periBolts.proxy, rodBolts)

  // ===================================================== ELECTRÓNICA
  const sensor = (x: number, y: number, z: number, rx = 0, rz = 0): void => {
    detail.add(new THREE.CylinderGeometry(0.065, 0.085, 0.2, 8), mBrass, mat4(x, y, z, rx, 0, rz))
    detail.add(new THREE.BoxGeometry(0.09, 0.08, 0.13), mHose, mat4(x, y + 0.13, z, rx, 0, rz))
  }
  sensor(halfW + 0.1, r * 1.1, 0.4, 0, -0.4) // CKP apuntando a la corona del volante
  sensor(frontX + 0.35, camY + 0.28, camZ, 0, 0.3) // CMP sobre el piñón de admisión
  sensor(halfW * 0.55, panTop + 1.0, -wallZ - 0.06, Math.PI / 2) // presión de aceite (pared trasera)
  sensor(-halfW * 0.45, deckY - 0.4, wallZ * 0.5 + 0.02, 0, 0) // ECT junto a la salida de agua
  sensor(0, plenumY + 0.42, plenumZ) // MAP sobre el plénum
  sensor(0, deckY * 0.55, -wallZ - 0.05, -Math.PI / 2) // knock atornillado a la pared

  const injBodyMs: THREE.Matrix4[] = []
  const coilBodyMs: THREE.Matrix4[] = []
  const glowInjector: THREE.MeshStandardMaterial[] = []
  const glowCoil: THREE.MeshStandardMaterial[] = []
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    // inyector: de la rampa a la brida de admisión
    injBodyMs.push(mat4(cx, deckY + 0.86, wallZ * 0.93 + 0.22, 0.5, 0, 0))
    // bobina COP hundida en la tapa
    coilBodyMs.push(mat4(cx, headTop + 0.4, 0))
    const gi = cad(CAD_GRAY)
    const gc = cad(CAD_GRAY)
    glowInjector.push(gi)
    glowCoil.push(gc)
    const injTip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 0.16, 8), gi)
    injTip.position.set(cx, deckY + 0.7, wallZ * 0.93 + 0.13)
    injTip.rotation.x = 0.5
    injTip.name = 'lod-detail'
    const coilTop = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.16), gc)
    coilTop.position.set(cx, headTop + 0.62, 0)
    coilTop.name = 'lod-detail'
    root.add(injTip, coilTop)
  }
  // actuadores: no son tornillería — en nivel banco siguen enteros
  const injBodies = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.065, 0.05, 0.3, 8), mDark, injBodyMs.length)
  injBodyMs.forEach((m, i) => injBodies.setMatrixAt(i, m))
  const coilGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.085, 0.085, 0.44, 8),
    new THREE.BoxGeometry(0.19, 0.22, 0.19).translate(0, 0.32, 0)
  ])!
  const coilBodies = new THREE.InstancedMesh(coilGeo, mDark, coilBodyMs.length)
  coilBodyMs.forEach((m, i) => coilBodies.setMatrixAt(i, m))
  root.add(injBodies, coilBodies)

  // ============================================ CIGÜEÑAL: volante y piñón
  const crankAttach = new THREE.Group()
  // muñones de extensión hasta volante y distribución (el eje visual del rig
  // termina en ±shaftHalf: nada cuelga en el aire)
  const stubR = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.14, boreR * 0.14, rearX - shaftHalf + 0.2, 10), mSteel)
  stubR.rotation.z = Math.PI / 2
  stubR.position.x = (shaftHalf + rearX) / 2
  crankAttach.add(stubR)
  const stubF = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.13, boreR * 0.13, -frontX - shaftHalf + 0.25, 10), mSteel)
  stubF.rotation.z = Math.PI / 2
  stubF.position.x = (frontX - shaftHalf) / 2
  crankAttach.add(stubF)
  const fly = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.5, r * 1.5, 0.16, 24), mSteel)
  fly.rotation.z = Math.PI / 2
  fly.position.x = rearX
  crankAttach.add(fly)
  const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.09, 0.1), mSteel, 36)
  for (let t = 0; t < 36; t++) {
    const a = (t / 36) * Math.PI * 2
    teeth.setMatrixAt(t, mat4(rearX, Math.cos(a) * r * 1.55, Math.sin(a) * r * 1.55, a, 0, 0, 1))
  }
  teeth.instanceMatrix.needsUpdate = true
  teeth.name = 'lod-fine'
  crankAttach.add(teeth)
  const sprocket = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 14), mSteel)
  sprocket.rotation.z = Math.PI / 2
  sprocket.position.x = frontX
  crankAttach.add(sprocket)

  // ===================================================== merges finales
  const closedMeshes = closed.build('shell-closed')
  const cutMeshes = cut.build('shell-cut')
  const alwaysMeshes = always.build('lod-macro')
  const detailMeshes = detail.build('lod-detail')
  const fineMeshes = fineStatic.build('lod-fine')
  for (const m of closedMeshes) m.visible = false // arrancamos en cutaway
  closedMeshes.forEach((m) => root.add(m))
  cutMeshes.forEach((m) => root.add(m))
  alwaysMeshes.forEach((m) => root.add(m))
  detailMeshes.forEach((m) => root.add(m))
  fineMeshes.forEach((m) => root.add(m))

  const finePairs = [headBolts, mainBolts, periBolts]
  let lastKey = -1

  const d: EngineDetail = {
    root,
    crankAttach,
    camIntake,
    camExhaust,
    camSprockets,
    valves,
    springs,
    buckets,
    rodBolts,
    glowInjector,
    glowCoil,
    glowPump,
    fanBlades,
    tier: 0,
    update(thetaVisual: number, tier: LodTier, cutaway = true): void {
      camIntake.rotation.x = thetaVisual / 2
      camExhaust.rotation.x = thetaVisual / 2
      // el rodete de la bomba de agua gira arrastrado por la correa (1:1)
      impeller.rotation.x = thetaVisual

      if (tier === 0) {
        const liftMax = boreR * 0.16
        const fourPi = Math.PI * 4
        for (let idx = 0; idx < valveMeta.length; idx++) {
          const vm = valveMeta[idx]!
          const c = (((thetaVisual + (CRANK_PHASE[vm.cyl] ?? 0)) % fourPi) + fourPi) % fourPi
          let lift = 0
          if (vm.exhaust && c > Math.PI && c < 2 * Math.PI) lift = Math.sin(c - Math.PI)
          if (!vm.exhaust && c > 2 * Math.PI && c < 3 * Math.PI) lift = Math.sin(c - 2 * Math.PI)
          const y = deckY + 0.08 - lift * liftMax
          valves.setMatrixAt(idx, mat4(vm.x, y, vm.z, 0, 0, 0, vm.scale))
          springs.setMatrixAt(idx, mat4(vm.x, deckY + 0.72 - (lift * liftMax) / 2, vm.z, 0, 0, 0, 1 - lift * 0.28))
          buckets.setMatrixAt(idx, mat4(vm.x, deckY + 0.93 - lift * liftMax, vm.z))
        }
        valves.instanceMatrix.needsUpdate = true
        springs.instanceMatrix.needsUpdate = true
        buckets.instanceMatrix.needsUpdate = true
      }

      const stateKey = tier * 2 + (cutaway ? 1 : 0)
      if (stateKey === lastKey) return
      lastKey = stateKey
      d.tier = tier
      const fineOn = tier === 0
      const proxyOn = tier === 1
      const detailOn = tier < 2
      const cutOn = detailOn && cutaway
      for (const p of finePairs) {
        p.fine.visible = fineOn
        p.proxy.visible = proxyOn
      }
      rodBolts.visible = fineOn
      valves.visible = fineOn
      springs.visible = fineOn
      buckets.visible = fineOn
      teeth.visible = fineOn
      injBodies.visible = detailOn
      coilBodies.visible = detailOn
      // en inspección la carcasa de la bomba se vuelve translúcida y deja
      // ver el rodete de palas girando
      pumpHousingMat.transparent = fineOn
      pumpHousingMat.opacity = fineOn ? 0.32 : 1
      pumpHousingMat.depthWrite = !fineOn
      camIntake.visible = detailOn
      camExhaust.visible = detailOn
      root.traverse((o) => {
        if (o.name === 'lod-fine') o.visible = fineOn
        else if (o.name === 'lod-detail') o.visible = detailOn
        else if (o.name === 'shell-cut') o.visible = cutOn
        else if (o.name === 'shell-closed') o.visible = !cutOn
      })
    },
    dispose(): void {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose()
      })
      for (const m of [mAlu, mDark, mSteel, mCast, mHose, mBrass]) m.dispose()
    }
  }
  return d
}

/** Enciende/apaga el pulso electrónico (§4) sobre un material de actuador. */
export function setActuatorPulse(mat: THREE.MeshStandardMaterial, on: boolean): void {
  if (on) {
    mat.color.set(PULSE_COLOR)
    mat.emissive.set(PULSE_EMISSIVE)
    mat.emissiveIntensity = PULSE_INTENSITY
  } else {
    mat.color.set(CAD_GRAY)
    mat.emissive.set('#000000')
    mat.emissiveIntensity = 0
  }
}
