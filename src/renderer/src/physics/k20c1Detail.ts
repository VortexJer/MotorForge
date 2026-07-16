import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { EngineSockets } from './sockets'
import type { EngineDetail, LodTier } from './engineDetail'

/**
 * Motor de exhibición Honda K20C1 (Civic Type R) modelado con solidsight en
 * `design/k20c1/model.py` y exportado a STL por pieza. Este módulo lo adapta
 * al contrato EngineDetail del laboratorio:
 *
 *  - Coordenadas: solidsight es Z-up con el eje del cigüeñal en X a z=120 mm;
 *    el laboratorio es Y-up con el cigüeñal en el origen. M = rotX(-90°) ·
 *    escala · traslación(-CRANK_Z).
 *  - Escala ANISÓTROPA a propósito: kx = spacing/94 (el rig separa cilindros
 *    a bore·1.3, el K20C1 real a 94 mm) y k = bore/86 en Y/Z. Como todas las
 *    piezas móviles giran alrededor de X, el estiramiento en X no se deforma
 *    al girar.
 *  - Piezas móviles: geometría recentrada a su pivote (eje de leva, eje del
 *    cigüeñal, bulón, cabeza de biela) y montada en un grupo en ese pivote.
 *  - VISTA SECCIONADA: plano de recorte (clipping plane) en z=0 sobre los
 *    materiales de bloque/culata/tapas/cárter — el corte revela camisas,
 *    mamparos y foso de agua reales del modelo. Requiere
 *    renderer.localClippingEnabled = true (lo activa PhysicsLab).
 *  - La carga de STL es asíncrona: el builder devuelve el contrato al
 *    instante con grupos vacíos y los puebla al resolver; onReady() avisa al
 *    rig para intercambiar las geometrías de pistón/biela.
 */

const CAD_GRAY = '#565e6b'

// ---- datums del modelo (mm, ver design/k20c1/datums.json)
const MM = {
  crankZ: 120,
  pitch: 94,
  bore: 86,
  camY: 40,
  camZ: 434,
  cylX: [-141, -47, 47, 141],
  injector: [106.5, 337.5] as const, // (y, z); x = cylX
  coilZ: 486,
  pumpCap: [-208, 30, 408] as const
}

const STATIC_PARTS = [
  'block',
  'head',
  'valve_cover',
  'chain_cover',
  'oil_pan',
  'intake_manifold',
  'throttle_body',
  'fuel_rail',
  'hp_pump',
  'turbo_hot',
  'turbo_core',
  'turbo_cold',
  'downpipe',
  'alternator',
  'belt',
  'ignition_coils',
  'oil_filter',
  'starter',
  'dipstick'
] as const

const CRANK_PARTS = ['crankshaft', 'flywheel', 'crank_pulley'] as const
const ALL_PARTS = [...STATIC_PARTS, ...CRANK_PARTS, 'cam_intake', 'cam_exhaust', 'piston_1', 'conrod_1'] as const

/** Piezas que se ocultan en vista global (tier 2). */
const FINE_PARTS = new Set(['fuel_rail', 'hp_pump', 'dipstick', 'ignition_coils'])
/** Materiales que reciben el plano de corte de la vista seccionada. */
const CLIPPED_PARTS = new Set(['block', 'head', 'valve_cover', 'chain_cover', 'oil_pan'])

// URLs de los STL empaquetados por vite
const stlUrls = import.meta.glob('../assets/k20c1/*.stl', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

let geomCache: Promise<Map<string, THREE.BufferGeometry>> | null = null

function loadGeometries(): Promise<Map<string, THREE.BufferGeometry>> {
  if (geomCache) return geomCache
  const loader = new STLLoader()
  geomCache = Promise.all(
    ALL_PARTS.map(async (name) => {
      const entry = Object.entries(stlUrls).find(([p]) => p.endsWith(`/${name}.stl`))
      if (!entry) throw new Error(`k20c1: falta el STL de "${name}"`)
      const buf = await (await fetch(entry[1])).arrayBuffer()
      return [name, loader.parse(buf)] as const
    })
  ).then((pairs) => new Map<string, THREE.BufferGeometry>(pairs))
  return geomCache
}

function mat(color: string, metalness: number, roughness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness })
}

/** Material por pieza (paleta CAD del laboratorio; instancias dedicadas). */
function materialFor(name: string): THREE.MeshStandardMaterial {
  switch (name) {
    case 'valve_cover':
      return mat('#8f1f26', 0.28, 0.62) // rojo crinkle Type R
    case 'block':
      return mat('#6f7887', 0.5, 0.44) // aluminio de fundición
    case 'alternator':
    case 'turbo_cold':
      return mat('#7d8694', 0.55, 0.4) // aluminio mecanizado
    case 'head':
    case 'chain_cover':
      return mat('#5f6874', 0.45, 0.52)
    case 'oil_pan':
    case 'starter':
    case 'crank_pulley':
      return mat('#262b33', 0.25, 0.62)
    case 'intake_manifold':
    case 'ignition_coils':
      return mat('#1d2127', 0.05, 0.84) // plástico técnico
    case 'belt':
      return mat('#16191e', 0.05, 0.92)
    case 'turbo_hot':
    case 'downpipe':
      return mat('#4a453e', 0.3, 0.74) // fundición
    case 'oil_filter':
      return mat('#9c5f47', 0.35, 0.55)
    case 'dipstick':
      return mat('#c9a45a', 0.85, 0.42)
    default:
      return mat('#95a0af', 0.85, 0.3) // acero
  }
}

export function buildK20C1Detail(sockets: EngineSockets, cylinders: number): EngineDetail {
  const { spacing, boreRadius } = sockets
  const kx = spacing / MM.pitch
  const k = (boreRadius * 2) / MM.bore
  const toLab = (x: number, y: number, z: number): THREE.Vector3 =>
    new THREE.Vector3(x * kx, (z - MM.crankZ) * k, -y * k)
  const M = new THREE.Matrix4()
    .makeRotationX(-Math.PI / 2)
    .multiply(new THREE.Matrix4().makeScale(kx, k, k))
    .multiply(new THREE.Matrix4().makeTranslation(0, 0, -MM.crankZ))

  const root = new THREE.Group()
  root.name = 'engine-detail-k20c1'
  const crankAttach = new THREE.Group()
  const camIntake = new THREE.Group()
  const camExhaust = new THREE.Group()
  camIntake.position.copy(toLab(0, MM.camY, MM.camZ))
  camExhaust.position.copy(toLab(0, -MM.camY, MM.camZ))
  root.add(camIntake, camExhaust)

  // plano de la vista seccionada (se aparta a 1e6 cuando está cerrada:
  // así el toggle no recompila materiales)
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6)

  const materials: THREE.MeshStandardMaterial[] = []
  const meshByName = new Map<string, THREE.Mesh>()

  // ---- pulsos electrónicos por cilindro (§4) — cuerpos propios sobre las
  // posiciones reales de bobina/inyector/bomba HP del modelo
  const glowInjector: THREE.MeshStandardMaterial[] = []
  const glowCoil: THREE.MeshStandardMaterial[] = []
  const glowPump = mat(CAD_GRAY, 0.4, 0.5)
  materials.push(glowPump)
  const glowGroup = new THREE.Group()
  root.add(glowGroup)
  for (let i = 0; i < Math.min(cylinders, 4); i++) {
    const cx = MM.cylX[i]!
    const gi = mat(CAD_GRAY, 0.4, 0.5)
    const gc = mat(CAD_GRAY, 0.4, 0.5)
    glowInjector.push(gi)
    glowCoil.push(gc)
    materials.push(gi, gc)
    const inj = new THREE.Mesh(new THREE.SphereGeometry(9 * k, 10, 8), gi)
    inj.position.copy(toLab(cx, MM.injector[0], MM.injector[1]))
    const coil = new THREE.Mesh(new THREE.CylinderGeometry(15 * k, 15 * k, 6 * k, 12), gc)
    coil.position.copy(toLab(cx, 0, MM.coilZ))
    glowGroup.add(inj, coil)
  }
  const pumpCap = new THREE.Mesh(new THREE.CylinderGeometry(11 * k, 11 * k, 8 * k, 12), glowPump)
  pumpCap.position.copy(toLab(MM.pumpCap[0], MM.pumpCap[1], MM.pumpCap[2]))
  glowGroup.add(pumpCap)

  // ---- relleno asíncrono
  let ready = false
  const readyCbs: Array<() => void> = []
  let pistonGeometry: THREE.BufferGeometry | undefined
  let rodGeometry: THREE.BufferGeometry | undefined

  void loadGeometries()
    .then((geos) => {
      const addMesh = (name: string, geo: THREE.BufferGeometry, parent: THREE.Object3D): THREE.Mesh => {
        const m = materialFor(name)
        if (CLIPPED_PARTS.has(name)) {
          m.clippingPlanes = [clipPlane]
          m.clipShadows = true
          m.side = THREE.DoubleSide
        }
        materials.push(m)
        const mesh = new THREE.Mesh(geo, m)
        mesh.name = name
        mesh.castShadow = true
        mesh.receiveShadow = true
        parent.add(mesh)
        meshByName.set(name, mesh)
        return mesh
      }

      for (const name of STATIC_PARTS) {
        const g = geos.get(name)!.clone()
        g.applyMatrix4(M)
        addMesh(name, g, root)
      }
      for (const name of CRANK_PARTS) {
        const g = geos.get(name)!.clone()
        g.applyMatrix4(M) // el eje del cigüeñal ya queda en el origen
        addMesh(name, g, crankAttach)
      }
      for (const [name, group, py] of [
        ['cam_intake', camIntake, MM.camY],
        ['cam_exhaust', camExhaust, -MM.camY]
      ] as const) {
        const g = geos.get(name)!.clone()
        g.applyMatrix4(M)
        const p = toLab(0, py, MM.camZ)
        g.translate(-p.x, -p.y, -p.z)
        addMesh(name, g, group)
      }

      // geometrías para el rig (origen: bulón / centro de biela, cilindro 1 en PMS)
      const pinTdc = toLab(MM.cylX[0]!, 0, MM.crankZ + 42.95 + 139)
      pistonGeometry = geos.get('piston_1')!.clone()
      pistonGeometry.applyMatrix4(M)
      pistonGeometry.translate(-pinTdc.x, -pinTdc.y, -pinTdc.z)
      const bigEndTdc = toLab(MM.cylX[0]!, 0, MM.crankZ + 42.95)
      rodGeometry = geos.get('conrod_1')!.clone()
      rodGeometry.applyMatrix4(M)
      // el cuerpo rígido de la biela tiene el origen en su punto medio
      rodGeometry.translate(-bigEndTdc.x, -bigEndTdc.y - sockets.rodLength / 2, -bigEndTdc.z)

      ready = true
      lastKey = -1 // fuerza re-aplicar tier/cutaway sobre las mallas nuevas
      for (const cb of readyCbs) cb()
    })
    .catch((err) => {
      console.error('k20c1Detail: fallo cargando STL, el motor de exhibición no se mostrará', err)
    })

  // ---- contrato EngineDetail (los InstancedMesh del árbol procedural no
  // aplican aquí: dummies invisibles que aceptan setMatrixAt sin coste)
  const dummyMat = mat(CAD_GRAY, 0, 1)
  materials.push(dummyMat)
  const dummy = (count: number): THREE.InstancedMesh => {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.001, 0.001, 0.001), dummyMat, count)
    im.visible = false
    return im
  }
  const rodBolts = dummy(Math.max(cylinders * 2, 1))
  root.add(rodBolts)

  let lastKey = -1
  const d: EngineDetail = {
    root,
    crankAttach,
    camIntake,
    camExhaust,
    camSprockets: new THREE.Group(),
    valves: dummy(1),
    springs: dummy(1),
    buckets: dummy(1),
    rodBolts,
    glowInjector,
    glowCoil,
    glowPump,
    fanBlades: [],
    tier: 0,
    selfContained: true,
    get pistonGeometry() {
      return pistonGeometry
    },
    get rodGeometry() {
      return rodGeometry
    },
    onReady(cb: () => void): void {
      if (ready) cb()
      else readyCbs.push(cb)
    },
    update(thetaVisual: number, tier: LodTier, cutaway = true): void {
      camIntake.rotation.x = thetaVisual / 2
      camExhaust.rotation.x = thetaVisual / 2
      if (!ready) return
      const stateKey = tier * 2 + (cutaway ? 1 : 0)
      if (stateKey === lastKey) return
      lastKey = stateKey
      d.tier = tier
      clipPlane.constant = cutaway ? 0 : 1e6
      const fineOn = tier < 2
      for (const [name, mesh] of meshByName) {
        if (FINE_PARTS.has(name)) mesh.visible = fineOn
      }
      glowGroup.visible = fineOn
      // las levas viven bajo la tapa: solo se ven (y se pagan) en el corte
      camIntake.visible = cutaway
      camExhaust.visible = cutaway
    },
    dispose(): void {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose()
      })
      pistonGeometry?.dispose()
      rodGeometry?.dispose()
      for (const m of materials) m.dispose()
    }
  }
  return d
}
