import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CRANK_PHASE } from './sockets'
import type { EngineSockets } from './sockets'

/**
 * Árbol maestro de componentes 3D del motor (pliego LOD):
 *
 *  A) Estructura central: bloque con camisas/galerías, cigüeñal (el rig de
 *     Rapier) + volante con corona dentada y piñón de distribución, cojinetes
 *     de bancada, cárter.
 *  B) Distribución y culata: culata con puertos, dos árboles de levas con
 *     levas por cilindro, 16 válvulas sincronizadas al ciclo de 4 tiempos,
 *     muelles/cazoletas/taqués, cadena con piñones, tensor y guías.
 *  C) Sobrealimentación y fluidos: turbo (dos caracolas + eje + wastegate),
 *     colector de admisión con mariposa y plénum, colector de escape,
 *     tuberías de intercooler, aceite del turbo, manguitos de radiador con
 *     abrazaderas y rampa de inyección.
 *  D) Tornillería: culata, bancada, sombreretes y periféricos + juntas.
 *  E) Electrónica: CKP, CMP, presión de aceite, ECT, MAP, knock; inyectores
 *     y bobinas con pulso eléctrico.
 *
 * Reglas de rendimiento (§2): tornillería/muelles/válvulas/bujías SOLO como
 * InstancedMesh; todo lo estático sin movimiento relativo se fusiona con
 * mergeGeometries en una malla por material. Presupuesto: <30 draw calls.
 *
 * LOD (§3): tier 0 inspección (todo), tier 1 banco (tornillería fina →
 * proxies low-poly), tier 2 global (solo carcasas macro).
 */

export type LodTier = 0 | 1 | 2

/** Pulso electrónico (§4): valores exactos del pliego. */
export const PULSE_COLOR = '#facc15'
export const PULSE_EMISSIVE = '#eab308'
export const PULSE_INTENSITY = 4.5

const CAD_GRAY = '#565e6b'

function cad(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.9 })
}

/** Acumula geometrías transformadas y las fusiona en una malla por material. */
class Merger {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>()

  add(geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4): void {
    const g = geo.clone().applyMatrix4(m)
    const list = this.buckets.get(mat)
    if (list) list.push(g)
    else this.buckets.set(mat, [g])
    geo.dispose()
  }

  build(name: string): THREE.Mesh[] {
    const out: THREE.Mesh[] = []
    for (const [mat, geos] of this.buckets) {
      const merged = mergeGeometries(geos, false)
      geos.forEach((g) => g.dispose())
      if (!merged) continue
      const mesh = new THREE.Mesh(merged, mat)
      mesh.name = name
      out.push(mesh)
    }
    return out
  }
}

const M = new THREE.Matrix4()
const Q = new THREE.Quaternion()
const V = new THREE.Vector3()
const ONE = new THREE.Vector3(1, 1, 1)

function mat4(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1): THREE.Matrix4 {
  Q.setFromEuler(new THREE.Euler(rx, ry, rz))
  return new THREE.Matrix4().compose(V.set(x, y, z), Q, ONE.clone().multiplyScalar(s))
}

/** InstancedMesh + proxy low-poly (tier banco) con las mismas matrices. */
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
  const proxy = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07 * proxyScale, 0.1 * proxyScale, 0.07 * proxyScale), mat, matrices.length)
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
  /** Volante + corona dentada + piñón: añadir como hijo del grupo del cigüeñal. */
  crankAttach: THREE.Group
  /** Árboles de levas (giran a ω/2 alrededor de X). */
  camIntake: THREE.Group
  camExhaust: THREE.Group
  camSprockets: THREE.Group
  valves: THREE.InstancedMesh
  springs: THREE.InstancedMesh
  buckets: THREE.InstancedMesh
  /** Pernos de biela: matrices actualizadas por frame desde los cuerpos. */
  rodBolts: THREE.InstancedMesh
  /** Materiales de pulso por cilindro (§4). */
  glowInjector: THREE.MeshStandardMaterial[]
  glowCoil: THREE.MeshStandardMaterial[]
  tier: LodTier
  dispose(): void
  /** Cinemática de distribución + LOD. */
  update(thetaVisual: number, tier: LodTier): void
}

export function buildEngineDetail(sockets: EngineSockets, cylinders: number): EngineDetail {
  const { spacing, crankRadius: r, boreRadius: boreR, block } = sockets
  const deckY = block.deckY
  const cyls = cylinders
  const halfW = (spacing * (cyls + 1)) / 2
  const frontX = -halfW - spacing * 0.15 // distribución
  const rearX = halfW + spacing * 0.15 // volante

  const root = new THREE.Group()
  root.name = 'engine-detail'

  // materiales CAD mate compartidos
  const mAlu = cad('#6d7684') // bloque/culata mecanizados
  const mDark = cad('#394049') // tapas, plénum
  const mSteel = cad(CAD_GRAY) // tornillería, válvulas, eje
  const mCast = cad('#4e4a45') // colector de escape/caracola turbina (fundición)
  const mHose = cad('#22262d') // manguitos y goma
  const mBrass = cad('#8a7a55') // sensores/conectores

  const macro = new Merger()
  const detail = new Merger()
  const fineStatic = new Merger()

  // ============================================================ A) ESTRUCTURA
  // Bloque con camisas: carcasa + faldones; galerías/conductos como canales
  const blockH = deckY * 0.62
  macro.add(new THREE.BoxGeometry(halfW * 2, blockH, boreR * 3.4), mAlu, mat4(0, deckY - blockH / 2 - 0.05, 0))
  // galerías de refrigeración y aceite (relieve longitudinal en el bloque)
  detail.add(new THREE.CylinderGeometry(0.09, 0.09, halfW * 2 - 0.4, 8), mAlu, mat4(0, deckY - 0.5, boreR * 1.72, 0, 0, Math.PI / 2))
  detail.add(new THREE.CylinderGeometry(0.07, 0.07, halfW * 2 - 0.4, 8), mBrass, mat4(0, deckY - blockH + 0.4, boreR * 1.72, 0, 0, Math.PI / 2))

  // Sombreretes de bancada + semicojinetes (nivel fino)
  const mainCapMs: THREE.Matrix4[] = []
  for (let b = 0; b <= cyls; b++) {
    const x = -halfW + spacing * 0.5 + b * spacing
    detail.add(new THREE.BoxGeometry(spacing * 0.24, r * 0.7, boreR * 0.9), mAlu, mat4(x, -r * 0.42, 0))
    fineStatic.add(
      new THREE.CylinderGeometry(boreR * 0.19, boreR * 0.19, spacing * 0.2, 10, 1, false, 0, Math.PI),
      mBrass,
      mat4(x, 0, 0, 0, 0, Math.PI / 2)
    )
    mainCapMs.push(mat4(x - spacing * 0.08, -r * 0.55, 0), mat4(x + spacing * 0.08, -r * 0.55, 0))
  }

  // Junta de culata (multicapa) + junta de tapa + junta de cárter
  detail.add(new THREE.BoxGeometry(halfW * 2, 0.035, boreR * 3.42), mBrass, mat4(0, deckY + 0.02, 0))
  detail.add(new THREE.BoxGeometry(halfW * 1.94, 0.03, boreR * 3.1), mHose, mat4(0, deckY + 1.44, 0))
  detail.add(new THREE.BoxGeometry(halfW * 1.82, 0.03, boreR * 2.7), mHose, mat4(0, -r - 0.72, 0))

  // ============================================================ B) CULATA Y DISTRIBUCIÓN
  const headH = 1.25
  macro.add(new THREE.BoxGeometry(halfW * 2, headH, boreR * 3.2), mAlu, mat4(0, deckY + 0.05 + headH / 2, 0))
  macro.add(new THREE.BoxGeometry(halfW * 1.96, 0.34, boreR * 3.05), mDark, mat4(0, deckY + headH + 0.24, 0)) // tapa balancines

  // puertos de admisión/escape (bocas en los laterales de la culata)
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    detail.add(new THREE.CylinderGeometry(boreR * 0.2, boreR * 0.24, 0.3, 10), mAlu, mat4(cx, deckY + 0.62, boreR * 1.62, Math.PI / 2, 0, 0))
    detail.add(new THREE.CylinderGeometry(boreR * 0.19, boreR * 0.22, 0.3, 10), mCast, mat4(cx, deckY + 0.5, -boreR * 1.62, Math.PI / 2, 0, 0))
  }

  // Árboles de levas: eje + una leva por válvula, en grupos que rotan
  const camY = deckY + headH - 0.18
  const camZ = boreR * 0.62
  const buildCam = (z: number, mat: THREE.Material): THREE.Group => {
    const g = new THREE.Group()
    g.position.set(0, camY, z)
    const parts = new Merger()
    parts.add(new THREE.CylinderGeometry(0.085, 0.085, halfW * 2 - 0.2, 10), mat, mat4(0, 0, 0, 0, 0, Math.PI / 2))
    for (let i = 0; i < cyls; i++) {
      for (const k of [-1, 1]) {
        const x = block.cylinders[i]!.x + k * boreR * 0.34
        // lóbulo excéntrico
        parts.add(new THREE.CylinderGeometry(0.16, 0.16, 0.09, 12), mat, mat4(x, 0.05, 0, 0, 0, Math.PI / 2))
      }
    }
    parts.build('cam').forEach((m) => g.add(m))
    return g
  }
  const camIntake = buildCam(camZ, mSteel)
  const camExhaust = buildCam(-camZ, mSteel)
  root.add(camIntake, camExhaust)

  // Válvulas (16v): admisión platillo mayor, escape menor — instanciadas
  const valveGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.035, 0.035, 0.62, 8).translate(0, 0.31, 0),
    new THREE.CylinderGeometry(0.16, 0.1, 0.06, 12)
  ])!
  const valveMs: THREE.Matrix4[] = []
  const valveMeta: Array<{ cyl: number; exhaust: boolean; x: number; z: number; scale: number }> = []
  for (let i = 0; i < cyls; i++) {
    for (const side of [1, -1]) {
      for (const k of [-1, 1]) {
        const x = block.cylinders[i]!.x + k * boreR * 0.34
        const z = side * boreR * 0.4
        const scale = side === 1 ? 1.0 : 0.86 // escape más pequeño
        valveMeta.push({ cyl: i, exhaust: side === -1, x, z, scale })
        valveMs.push(mat4(x, deckY + 0.12, z, 0, 0, 0, scale))
      }
    }
  }
  const valves = new THREE.InstancedMesh(valveGeo, mSteel, valveMs.length)
  valveMs.forEach((m, i) => valves.setMatrixAt(i, m))
  valves.name = 'valves'
  root.add(valves)

  // Muelles + cazoletas/chavetas + taqués (instanciados, comprimen con la leva)
  const springGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.11, 0.11, 0.34, 10, 4, true),
    new THREE.CylinderGeometry(0.12, 0.12, 0.04, 10).translate(0, 0.19, 0) // cazoleta+chaveta
  ])!
  const springs = new THREE.InstancedMesh(springGeo, mSteel, valveMs.length)
  const bucketGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.08, 10)
  const buckets = new THREE.InstancedMesh(bucketGeo, mDark, valveMs.length)
  root.add(springs, buckets)

  // Distribución: piñones de levas + cadena + tensor + guías (frontal)
  const camSprockets = new THREE.Group()
  for (const z of [camZ, -camZ]) {
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.1, 16), mSteel)
    sp.rotation.z = Math.PI / 2
    sp.position.set(frontX, camY, z)
    camSprockets.add(sp)
  }
  root.add(camSprockets)
  // cadena: bucle simplificado crank→levas (tubo), guías y tensor
  const chainPath = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(frontX, 0.15, 0.3),
      new THREE.Vector3(frontX, camY, camZ + 0.36),
      new THREE.Vector3(frontX, camY + 0.42, 0),
      new THREE.Vector3(frontX, camY, -camZ - 0.36),
      new THREE.Vector3(frontX, 0.15, -0.3)
    ],
    true
  )
  detail.add(new THREE.TubeGeometry(chainPath, 32, 0.045, 6, true), mSteel, new THREE.Matrix4())
  detail.add(new THREE.BoxGeometry(0.1, deckY * 0.7, 0.14), mHose, mat4(frontX, deckY * 0.5, camZ + 0.28, 0, 0, 0.1))
  detail.add(new THREE.BoxGeometry(0.12, 0.3, 0.18), mDark, mat4(frontX, deckY * 0.45, -camZ - 0.3)) // tensor hidráulico

  // ============================================================ C) TURBO Y FLUIDOS
  const turboX = rearX - 0.2
  const turboY = deckY * 0.6
  const turboZ = -boreR * 2.5
  // caracola de turbina (fundición) + caracola de compresor (aluminio) + eje
  macro.add(new THREE.TorusGeometry(0.55, 0.26, 10, 20), mCast, mat4(turboX, turboY, turboZ, 0, Math.PI / 2, 0))
  macro.add(new THREE.TorusGeometry(0.52, 0.24, 10, 20), mAlu, mat4(turboX + 0.85, turboY, turboZ, 0, Math.PI / 2, 0))
  detail.add(new THREE.CylinderGeometry(0.12, 0.12, 1.0, 10), mSteel, mat4(turboX + 0.42, turboY, turboZ, 0, 0, Math.PI / 2))
  // wastegate: cápsula neumática + varilla
  detail.add(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 12), mDark, mat4(turboX - 0.1, turboY + 0.62, turboZ + 0.3))
  detail.add(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), mSteel, mat4(turboX - 0.05, turboY + 0.32, turboZ + 0.2, 0.5, 0, 0))

  // Colector de escape: ramales de fundición hacia la turbina
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(cx, deckY + 0.5, -boreR * 1.75),
      new THREE.Vector3(cx + (turboX - cx) * 0.4, deckY * 0.86, -boreR * 2.2),
      new THREE.Vector3(turboX - 0.6, turboY, turboZ + 0.1)
    ])
    detail.add(new THREE.TubeGeometry(path, 10, 0.14, 8), mCast, new THREE.Matrix4())
  }

  // Admisión: plénum + mariposa + ramales
  const plenumZ = boreR * 2.4
  macro.add(new THREE.CylinderGeometry(0.42, 0.42, halfW * 1.7, 12), mDark, mat4(0, deckY + 0.7, plenumZ, 0, 0, Math.PI / 2))
  detail.add(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 12), mAlu, mat4(-halfW * 0.85 - 0.3, deckY + 0.7, plenumZ, 0, 0, Math.PI / 2)) // cuerpo de mariposa
  detail.add(new THREE.CylinderGeometry(0.27, 0.27, 0.03, 12), mSteel, mat4(-halfW * 0.85 - 0.3, deckY + 0.7, plenumZ, 0, 0.5, Math.PI / 2)) // mariposa + eje
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(cx, deckY + 0.66, boreR * 1.75),
      new THREE.Vector3(cx, deckY + 0.85, plenumZ - 0.3)
    ])
    detail.add(new THREE.TubeGeometry(path, 6, 0.13, 8), mAlu, new THREE.Matrix4())
  }

  // Tuberías intercooler (compresor→mariposa), aceite del turbo, manguitos radiador
  const icPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(turboX + 0.85, turboY + 0.5, turboZ),
    new THREE.Vector3(halfW * 0.7, deckY + 1.9, 0),
    new THREE.Vector3(-halfW * 0.85 - 0.7, deckY + 0.9, plenumZ - 0.2)
  ])
  detail.add(new THREE.TubeGeometry(icPath, 14, 0.16, 8), mAlu, new THREE.Matrix4())
  const oilFeed = new THREE.CatmullRomCurve3([
    new THREE.Vector3(turboX + 0.42, turboY + 0.14, turboZ),
    new THREE.Vector3(halfW * 0.8, deckY * 0.45, -boreR * 1.6)
  ])
  detail.add(new THREE.TubeGeometry(oilFeed, 6, 0.035, 6), mSteel, new THREE.Matrix4())
  const oilReturn = new THREE.CatmullRomCurve3([
    new THREE.Vector3(turboX + 0.42, turboY - 0.2, turboZ),
    new THREE.Vector3(halfW * 0.7, -r - 0.4, -boreR * 1.2)
  ])
  detail.add(new THREE.TubeGeometry(oilReturn, 6, 0.05, 6), mSteel, new THREE.Matrix4())
  for (const sgn of [1, -1]) {
    const hose = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-halfW - 0.1, deckY * (sgn === 1 ? 0.85 : 0.35), boreR * 1.5),
      new THREE.Vector3(-halfW - 0.9, deckY * (sgn === 1 ? 0.95 : 0.25), boreR * 1.7)
    ])
    detail.add(new THREE.TubeGeometry(hose, 5, 0.11, 8), mHose, new THREE.Matrix4())
    // abrazaderas
    fineStatic.add(new THREE.TorusGeometry(0.12, 0.02, 6, 12), mSteel, mat4(-halfW - 0.2, deckY * (sgn === 1 ? 0.86 : 0.34), boreR * 1.52, 0, Math.PI / 2, 0))
  }

  // Rampa de inyección de alta presión
  detail.add(new THREE.CylinderGeometry(0.09, 0.09, halfW * 1.6, 8), mSteel, mat4(0, deckY + 1.06, boreR * 1.28, 0, 0, Math.PI / 2))

  // ============================================================ D) TORNILLERÍA (instanciada)
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
      headBoltMs.push(mat4(block.cylinders[i]!.x + dx!, deckY + headH + 0.45, dz!))
    }
  }
  const headBolts = instancedPair(boltGeo.clone(), mSteel, headBoltMs, 1.2)

  const mainBolts = instancedPair(boltGeo.clone().scale(0.9, 0.9, 0.9), mSteel, mainCapMs)

  // periféricos: tapa de balancines, cárter, caracolas
  const periMs: THREE.Matrix4[] = []
  for (let i = 0; i < 10; i++) periMs.push(mat4(-halfW * 0.9 + (i * halfW * 1.8) / 9, deckY + headH + 0.44, boreR * 1.45, 0, 0, 0, 0.55))
  for (let i = 0; i < 10; i++) periMs.push(mat4(-halfW * 0.85 + (i * halfW * 1.7) / 9, -r - 0.74, boreR * 1.25, 0, 0, 0, 0.55))
  for (let a = 0; a < 6; a++) {
    periMs.push(mat4(turboX + 0.42 + 0.4 * Math.cos((a * Math.PI) / 3) * 0.2, turboY + 0.62 * Math.sin((a * Math.PI) / 3), turboZ, Math.PI / 2, 0, 0, 0.5))
  }
  const periBolts = instancedPair(boltGeo.clone(), mSteel, periMs, 0.7)

  // pernos de biela: matrices por frame desde los cuerpos de Rapier
  const rodBolts = new THREE.InstancedMesh(boltGeo.clone().scale(0.7, 0.7, 0.7), mSteel, cyls * 2)
  rodBolts.frustumCulled = false
  root.add(headBolts.fine, headBolts.proxy, mainBolts.fine, mainBolts.proxy, periBolts.fine, periBolts.proxy, rodBolts)

  // ============================================================ E) ELECTRÓNICA
  // sensores estáticos (nivel detalle): CKP, CMP, presión aceite, ECT, MAP, knock
  const sensor = (x: number, y: number, z: number, rx = 0, rz = 0): void => {
    detail.add(new THREE.CylinderGeometry(0.07, 0.09, 0.22, 8), mBrass, mat4(x, y, z, rx, 0, rz))
    detail.add(new THREE.BoxGeometry(0.1, 0.08, 0.14), mHose, mat4(x, y + 0.16, z, rx, 0, rz)) // conector
  }
  sensor(rearX - 0.05, r * 1.15, boreR * 0.9) // CKP sobre la corona del volante
  sensor(frontX + 0.3, camY + 0.35, camZ) // CMP
  sensor(halfW * 0.55, deckY * 0.4, boreR * 1.74, Math.PI / 2) // presión de aceite
  sensor(-halfW * 0.45, deckY - 0.35, boreR * 1.74, Math.PI / 2) // ECT
  sensor(0, deckY + 1.16, plenumZ, 0) // MAP en el plénum
  sensor(0, deckY * 0.55, -boreR * 1.74, -Math.PI / 2) // knock atornillado al bloque

  // inyectores + bobinas: cuerpo instanciado + punta de pulso individual (§4)
  const injBodyMs: THREE.Matrix4[] = []
  const coilBodyMs: THREE.Matrix4[] = []
  const glowInjector: THREE.MeshStandardMaterial[] = []
  const glowCoil: THREE.MeshStandardMaterial[] = []
  for (let i = 0; i < cyls; i++) {
    const cx = block.cylinders[i]!.x
    injBodyMs.push(mat4(cx, deckY + 0.9, boreR * 1.3, 0.35, 0, 0))
    coilBodyMs.push(mat4(cx, deckY + headH + 0.62, 0))
    const gi = cad(CAD_GRAY)
    const gc = cad(CAD_GRAY)
    glowInjector.push(gi)
    glowCoil.push(gc)
    const injTip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 0.16, 8), gi)
    injTip.position.set(cx, deckY + 0.76, boreR * 1.36)
    injTip.rotation.x = 0.35
    injTip.name = 'lod-detail'
    const coilTop = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.16), gc)
    coilTop.position.set(cx, deckY + headH + 0.9, 0)
    coilTop.name = 'lod-detail'
    root.add(injTip, coilTop)
  }
  const injGeo = new THREE.CylinderGeometry(0.07, 0.05, 0.34, 8)
  const injBodies = instancedPair(injGeo, mDark, injBodyMs, 0.8)
  const coilGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8), // bujía+vaso
    new THREE.BoxGeometry(0.2, 0.24, 0.2).translate(0, 0.35, 0) // bobina COP
  ])!
  const coilBodies = instancedPair(coilGeo, mDark, coilBodyMs, 0.9)
  root.add(injBodies.fine, injBodies.proxy, coilBodies.fine, coilBodies.proxy)

  // ============================================================ VOLANTE (hijo del cigüeñal)
  const crankAttach = new THREE.Group()
  const fly = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.5, r * 1.5, 0.16, 24), mSteel)
  fly.rotation.z = Math.PI / 2
  fly.position.x = rearX - 0.4
  crankAttach.add(fly)
  // corona dentada del motor de arranque: dientes instanciados (hijos → una draw call)
  const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.09, 0.1), mSteel, 36)
  for (let t = 0; t < 36; t++) {
    const a = (t / 36) * Math.PI * 2
    teeth.setMatrixAt(t, mat4(rearX - 0.4, Math.cos(a) * r * 1.55, Math.sin(a) * r * 1.55, a, 0, 0, 1))
  }
  teeth.instanceMatrix.needsUpdate = true
  teeth.name = 'lod-fine'
  crankAttach.add(teeth)
  // piñón de distribución en el morro
  const sprocket = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.1, 14), mSteel)
  sprocket.rotation.z = Math.PI / 2
  sprocket.position.x = frontX + 0.15
  crankAttach.add(sprocket)

  // ============================================================ ensamblado de merges
  const macroMeshes = macro.build('lod-macro')
  const detailMeshes = detail.build('lod-detail')
  const fineMeshes = fineStatic.build('lod-fine')
  macroMeshes.forEach((m) => root.add(m))
  detailMeshes.forEach((m) => root.add(m))
  fineMeshes.forEach((m) => root.add(m))

  const finePairs = [headBolts, mainBolts, periBolts, injBodies, coilBodies]

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
    tier: 0,
    update(thetaVisual: number, tier: LodTier): void {
      // ---- distribución a ω/2, sincronizada con el ciclo de 4 tiempos ----
      camIntake.rotation.x = thetaVisual / 2
      camExhaust.rotation.x = thetaVisual / 2
      camSprockets.children.forEach((sp) => (sp.rotation.x = thetaVisual / 2))

      if (tier === 0) {
        const liftMax = boreR * 0.16
        const fourPi = Math.PI * 4
        for (let idx = 0; idx < valveMeta.length; idx++) {
          const vm = valveMeta[idx]!
          const c = (((thetaVisual + (CRANK_PHASE[vm.cyl] ?? 0)) % fourPi) + fourPi) % fourPi
          let lift = 0
          if (vm.exhaust && c > Math.PI && c < 2 * Math.PI) lift = Math.sin(c - Math.PI)
          if (!vm.exhaust && c > 2 * Math.PI && c < 3 * Math.PI) lift = Math.sin(c - 2 * Math.PI)
          const y = deckY + 0.12 - lift * liftMax
          valves.setMatrixAt(idx, mat4(vm.x, y, vm.z, 0, 0, 0, vm.scale))
          springs.setMatrixAt(idx, mat4(vm.x, deckY + 0.78 - (lift * liftMax) / 2, vm.z, 0, 0, 0, 1 - lift * 0.28))
          buckets.setMatrixAt(idx, mat4(vm.x, deckY + 0.99 - lift * liftMax, vm.z))
        }
        valves.instanceMatrix.needsUpdate = true
        springs.instanceMatrix.needsUpdate = true
        buckets.instanceMatrix.needsUpdate = true
      }

      // ---- LOD (§3): inspección / banco / vista global ----
      if (tier === d.tier) return
      d.tier = tier
      const fineOn = tier === 0
      const proxyOn = tier === 1
      const detailOn = tier < 2
      for (const p of finePairs) {
        p.fine.visible = fineOn
        p.proxy.visible = proxyOn
      }
      rodBolts.visible = fineOn
      valves.visible = fineOn
      springs.visible = fineOn
      buckets.visible = fineOn
      teeth.visible = fineOn
      camSprockets.visible = detailOn
      camIntake.visible = detailOn
      camExhaust.visible = detailOn
      root.traverse((o) => {
        if (o.name === 'lod-fine') o.visible = fineOn
        else if (o.name === 'lod-detail') o.visible = detailOn
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
