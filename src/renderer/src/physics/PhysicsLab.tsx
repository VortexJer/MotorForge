import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import RAPIER from '@dimforge/rapier3d-compat'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { ResolvedEngine } from '@sim/types'
import { CRANK_PHASE, buildSockets, rodScale } from './sockets'
import type { CustomSockets, EngineSockets } from './sockets'
import {
  PHYS_MATERIALS,
  PISTON_COLD_FACTOR,
  checkStress,
  hotPistonRadius,
  isSeized,
  thermalStep
} from './engineMath'
import type { FailureMode, PhysMaterial } from './engineMath'
import { EngineAudio } from './audio'
import { PULSE_COLOR, buildEngineDetail, engineFloorY, setActuatorPulse } from './engineDetail'
import type { EngineDetail, LodTier } from './engineDetail'
import SocketEditor from './SocketEditor'
import Tachometer from './Tachometer'

/**
 * Laboratorio físico (pliego): el tren alternativo como cuerpos rígidos de
 * Rapier unidos por juntas de revolución y deslizantes. Nada de animación
 * por frames: el cigüeñal es un cuerpo cinemático motorizado y bielas y
 * pistones se mueven porque las juntas los obligan.
 *
 * Cámara lenta automática: las fuerzas de fatiga usan ω REAL; Rapier gira a
 * ω visual acotada (ningún integrador aguanta 8000 rpm a 60 fps).
 */

const S = 10 // 1 m → 10 unidades de escena
const IDLE_RPM = 950
const AMBIENT_K = 298

/**
 * Velocidad visual del cigüeñal: crece con las rpm reales para que acelerar
 * SE VEA (ralentí ~9 rad/s → corte ~28 rad/s), con techo integrable. El
 * factor de cámara lenta resultante se muestra en el HUD.
 */
function visualOmegaFor(rpm: number, omegaReal: number): number {
  if (omegaReal <= 0) return 0
  return Math.min(omegaReal, 6 + 24 * Math.min(rpm / 8000, 1.25))
}

// grupos de colisión: piezas unidas no colisionan; al romper, chocan con la jaula
const GROUP_CAGE = 0x0001_0002 // membership jaula, filtra piezas
const GROUP_JOINED = 0x0002_0000 // piezas unidas: no colisionan con nada
const GROUP_LOOSE = 0x0002_0003 // piezas sueltas: chocan con jaula y entre sí

export interface LabControls {
  throttle: number // 0..1 — palanca (posición fija)
  /** Pedal momentáneo 0..1: manda el máximo de palanca y pedal. */
  pedal: number
  ignition: boolean
  pulses: boolean
  revLimit: number
  waterFlow: number // 0..1
  oilFlow: number // 0..1
  rodLengthMm: number
  rodAreaMm2: number
  materialId: PhysMaterial['id']
  boltKit: 'serie' | 'arp'
  paused: boolean // Custom Sandbox
}

export interface Telemetry {
  rpm: number
  sigmaMpa: number
  sigmaLimitMpa: number
  eulerPct: number
  boltPct: number
  tMotorC: number
  boostBar: number
  pistonClearanceUm: number
  /** Factor de cámara lenta de la escena (1 = tiempo real). */
  slowmo: number
  status: 'off' | 'cranking' | 'running' | 'broken' | 'seized'
  failure: FailureMode
  failureText: string | null
}

const BOLT_KITS = {
  serie: { diameter: 0.0065, yield: 640e6, label: 'Pernos de serie M6.5' },
  arp: { diameter: 0.009, yield: 1200e6, label: 'Pernos ARP M9' }
} as const

/** Metal técnico: responde al entorno PBR sin llegar a espejo. */
function cadMat(color: string, metalness = 0.55, roughness = 0.42): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness })
}

function neonRed(mat: THREE.MeshStandardMaterial): void {
  mat.color.set('#ff1a1a')
  mat.emissive.set('#ff2020')
  mat.emissiveIntensity = 1.4
  mat.roughness = 0.4
}

interface CylinderRig {
  piston: RAPIER.RigidBody
  rod: RAPIER.RigidBody
  pistonCollider: RAPIER.Collider
  rodCollider: RAPIER.Collider
  joints: RAPIER.ImpulseJoint[]
  pistonMesh: THREE.Group
  rodMesh: THREE.Group
  pistonMat: THREE.MeshStandardMaterial
  rodMat: THREE.MeshStandardMaterial
  prevY: number
  rising: boolean
  strokePhase: number // 0..1: alterna PMS de compresión / escape
  broken: boolean
}

interface SceneProps {
  engine: ResolvedEngine
  controls: React.MutableRefObject<LabControls>
  onTelemetry: (t: Telemetry) => void
  audio: EngineAudio
  customRod: THREE.Group | null
}

function PhysicsScene({ engine, controls, onTelemetry, audio, customRod }: SceneProps): React.JSX.Element | null {
  const g = engine.geometry
  const sockets = useMemo<EngineSockets>(() => buildSockets(g, S), [g])
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const orbitRef = useRef<OrbitControlsImpl | null>(null)

  const worldRef = useRef<RAPIER.World | null>(null)
  const crankRef = useRef<RAPIER.RigidBody | null>(null)
  const rigsRef = useRef<CylinderRig[]>([])
  const crankMeshRef = useRef<THREE.Group | null>(null)
  const crankMatRef = useRef<THREE.MeshStandardMaterial>(cadMat('#6b7382'))
  const sparkLights = useRef<THREE.PointLight[]>([])
  const sparkTimers = useRef<number[]>([])
  const detailRef = useRef<EngineDetail | null>(null)
  /** Ángulo visual acumulado del cigüeñal: sincroniza levas y válvulas. */
  const thetaVisRef = useRef(0)
  const tierRef = useRef<LodTier>(0)

  // estado del motor (real, no visual)
  const rpmRef = useRef(0)
  const thetaRef = useRef(0)
  const thermal = useRef({ tMotor: AMBIENT_K })
  const statusRef = useRef<Telemetry['status']>('off')
  const failureRef = useRef<{ mode: FailureMode; text: string | null }>({ mode: null, text: null })
  const telemetryClock = useRef(0)

  const focusRef = useRef<{ target: THREE.Vector3; camPos: THREE.Vector3; obj: THREE.Object3D } | null>(null)
  const composerRef = useRef<EffectComposer | null>(null)
  const outlineRef = useRef<OutlinePass | null>(null)

  const originalRodLength = g.rodLength
  const originalRodArea = 3.0e-4

  // entorno PBR + tone mapping cinematográfico: sin esto los metales salen
  // planos y toda la escena parece de plástico gris
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = envMap
    scene.environmentIntensity = 0.55
    scene.fog = new THREE.FogExp2('#05070c', 0.0085)
    gl.toneMapping = THREE.ACESFilmicToneMapping
    gl.toneMappingExposure = 1.12
    return () => {
      scene.environment = null
      scene.fog = null
      envMap.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])

  // ---- construcción del mundo: cuerpos, juntas y mallas ----
  useEffect(() => {
    const world = new RAPIER.World({ x: 0, y: -9.81 * S * 0.25, z: 0 })
    worldRef.current = world
    const root = new THREE.Group()
    root.name = 'phys-root'
    scene.add(root)

    const { spacing, crankRadius: r, rodLength: l, boreRadius: boreR, block } = sockets
    const deckY = block.deckY
    const ch = 0.03 * S
    const cyls = g.cylinders

    // ---- Bloque: cuerpo fijo + jaula de colisión (cárter y paredes) ----
    const blockBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    const cageW = spacing * (cyls + 1)
    const cageD = boreR * 4
    const floorY = -r - 0.8
    const wall = (hx: number, hy: number, hz: number, x: number, y: number, z: number): void => {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setCollisionGroups(GROUP_CAGE),
        blockBody
      )
    }
    wall(cageW / 2, 0.1, cageD / 2, 0, floorY, 0) // suelo del cárter
    wall(cageW / 2, deckY, 0.1, 0, floorY + deckY, -cageD / 2) // pared trasera
    wall(cageW / 2, deckY, 0.1, 0, floorY + deckY, cageD / 2) // pared delantera
    wall(0.1, deckY, cageD / 2, -cageW / 2, floorY + deckY, 0)
    wall(0.1, deckY, cageD / 2, cageW / 2, floorY + deckY, 0)

    // visual del bloque: camisas transparentes + cárter (macro, siempre visible)
    const linerMat = new THREE.MeshStandardMaterial({
      color: '#8fa3bd',
      metalness: 0.05,
      roughness: 0.85,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    for (let i = 0; i < cyls; i++) {
      const liner = new THREE.Mesh(new THREE.CylinderGeometry(boreR, boreR, r * 2.6, 32, 1, true), linerMat)
      liner.position.set(block.cylinders[i]!.x, deckY - r * 1.3, 0)
      root.add(liner)
    }
    const pan = new THREE.Mesh(new THREE.BoxGeometry(cageW * 0.9, 0.12, cageD * 0.8), cadMat('#2c323d'))
    pan.position.set(0, floorY, 0)
    root.add(pan)

    // ---- Árbol maestro de componentes (pliego LOD): culata, distribución,
    // turbo, tuberías, tornillería instanciada y sensores ----
    const det = buildEngineDetail(sockets, cyls)
    root.add(det.root)
    detailRef.current = det
    ;(window as unknown as Record<string, unknown>)['__mfTier'] = 0
    // sombras en todo el motor (las camisas transparentes solo reciben)
    root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        const transparent = o.material instanceof THREE.Material && o.material.transparent
        o.castShadow = !transparent
        o.receiveShadow = true
      }
    })

    // luces de chispa (§4: PointLight amarillo 15 ms sobre bujía/corona)
    sparkLights.current = []
    sparkTimers.current = []
    for (let i = 0; i < cyls; i++) {
      const light = new THREE.PointLight(PULSE_COLOR, 0, boreR * 9)
      light.position.set(block.cylinders[i]!.x, deckY + ch, 0)
      root.add(light)
      sparkLights.current.push(light)
      sparkTimers.current.push(0)
    }

    // ---- Cigüeñal: cuerpo cinemático motorizado ----
    const crank = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicVelocityBased())
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(sockets.spacing * cyls * 0.55, r * 0.3, r * 0.3).setCollisionGroups(GROUP_JOINED),
      crank
    )
    crankRef.current = crank

    const crankGroup = new THREE.Group()
    const crankMat = crankMatRef.current
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(boreR * 0.16, boreR * 0.16, spacing * (cyls + 0.6), 14),
      crankMat
    )
    shaft.rotation.z = Math.PI / 2
    crankGroup.add(shaft)
    for (let i = 0; i < cyls; i++) {
      const pin = sockets.crank.rodPins[i]!
      const web = new THREE.Group()
      web.position.x = pin.position.x
      web.rotation.x = pin.phase
      const journal = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.14, boreR * 0.14, spacing * 0.4, 12), crankMat)
      journal.position.y = r
      journal.rotation.z = Math.PI / 2
      web.add(journal)
      for (const sSign of [-1, 1]) {
        // brazo hacia la muñequilla + contrapeso de media luna en oposición
        const arm = new THREE.Mesh(new THREE.BoxGeometry(spacing * 0.1, r * 1.15, boreR * 0.42), crankMat)
        arm.position.set(sSign * spacing * 0.2, r * 0.5, 0)
        web.add(arm)
        const weight = new THREE.Mesh(
          new THREE.CylinderGeometry(r * 0.95, r * 0.95, spacing * 0.1, 20, 1, false, Math.PI, Math.PI),
          crankMat
        )
        weight.rotation.z = Math.PI / 2
        weight.position.set(sSign * spacing * 0.2, -r * 0.25, 0)
        web.add(weight)
      }
      crankGroup.add(web)
    }
    // volante + corona dentada + piñón de distribución giran con el cigüeñal
    crankGroup.add(det.crankAttach)
    root.add(crankGroup)
    crankMeshRef.current = crankGroup

    // ---- Bielas y pistones por cilindro: dinámicos + juntas ----
    const rigs: CylinderRig[] = []
    for (let i = 0; i < cyls; i++) {
      const phase = CRANK_PHASE[i] ?? 0
      const cx = block.cylinders[i]!.x
      const pinY0 = r * Math.cos(phase) + Math.sqrt(l * l - r * r * Math.sin(phase) ** 2)

      // pistón
      const piston = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(cx, pinY0, 0).setCcdEnabled(true)
      )
      const pistonCollider = world.createCollider(
        RAPIER.ColliderDesc.cylinder(ch * 0.9, boreR * 0.94).setCollisionGroups(GROUP_JOINED).setDensity(2.5),
        piston
      )

      // biela
      const midY0 = (r * Math.cos(phase) + pinY0) / 2
      const midZ0 = (r * Math.sin(phase)) / 2
      const rod = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(cx, midY0, midZ0).setCcdEnabled(true)
      )
      const dir0 = new THREE.Vector3(0, pinY0 - r * Math.cos(phase), -r * Math.sin(phase)).normalize()
      const q0 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir0)
      rod.setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w }, true)
      const rodCollider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(boreR * 0.16, l * 0.5, boreR * 0.12).setCollisionGroups(GROUP_JOINED).setDensity(3),
        rod
      )

      // juntas (pliego §3): biela-cigüeñal y biela-pistón de revolución,
      // pistón-bloque deslizante estricta en Y
      const ax = { x: 1, y: 0, z: 0 }
      const jRodCrank = world.createImpulseJoint(
        RAPIER.JointData.revolute(
          { x: sockets.crank.rodPins[i]!.position.x, y: sockets.crank.rodPins[i]!.position.y, z: sockets.crank.rodPins[i]!.position.z },
          { x: 0, y: -l / 2, z: 0 },
          ax
        ),
        crank,
        rod,
        true
      )
      const jRodPiston = world.createImpulseJoint(
        RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: l / 2, z: 0 }, ax),
        piston,
        rod,
        true
      )
      const slider = RAPIER.JointData.prismatic({ x: cx, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })
      slider.limitsEnabled = true
      slider.limits = [l - r - 0.2, l + r + 0.2]
      const jPistonBlock = world.createImpulseJoint(slider, blockBody, piston, true)

      // pistón TORNEADO (LatheGeometry): copa en corona, tres gargantas de
      // segmento mecanizadas y falda con entrada
      const pistonMat = cadMat('#cdd3dd', 0.65, 0.32)
      const pistonMesh = new THREE.Group()
      const R = boreR * 0.94
      const top = ch * 1.3
      const bottom = -ch * 2.2
      const pts: THREE.Vector2[] = [
        new THREE.Vector2(0, top - 0.05),
        new THREE.Vector2(R * 0.55, top - 0.05),
        new THREE.Vector2(R * 0.86, top),
        new THREE.Vector2(R, top - 0.05)
      ]
      for (let gI = 0; gI < 3; gI++) {
        const gy = top - 0.16 - gI * 0.12
        pts.push(
          new THREE.Vector2(R, gy + 0.02),
          new THREE.Vector2(R * 0.9, gy + 0.02),
          new THREE.Vector2(R * 0.9, gy - 0.03),
          new THREE.Vector2(R, gy - 0.03)
        )
      }
      pts.push(
        new THREE.Vector2(R, bottom + 0.14),
        new THREE.Vector2(R * 0.96, bottom),
        new THREE.Vector2(R * 0.62, bottom + 0.04)
      )
      const crown = new THREE.Mesh(new THREE.LatheGeometry(pts, 30), pistonMat)
      pistonMesh.add(crown)
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.16, boreR * 0.16, boreR * 1.2, 10), pistonMat)
      pin.rotation.z = Math.PI / 2
      pin.name = 'ring-fine'
      pistonMesh.add(pin)
      // segmentos alojados en sus gargantas mecanizadas
      const ringMat = cadMat('#454d59', 0.85, 0.3)
      for (let rg = 0; rg < 3; rg++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.945, 0.024, 6, 28), ringMat)
        ring.rotation.x = Math.PI / 2
        ring.position.y = top - 0.165 - rg * 0.12
        ring.name = 'ring-fine'
        pistonMesh.add(ring)
      }
      pistonMesh.userData['part'] = `Pistón ${i + 1}`
      root.add(pistonMesh)

      // biela forjada: brazo con sección en I extruida + ojos torneados
      const rodMat = cadMat('#a9b2c2', 0.7, 0.35)
      const rodMesh = new THREE.Group()
      const W = boreR * 0.3
      const T = boreR * 0.22
      const fl = T * 0.32
      const web = W * 0.34
      const iShape = new THREE.Shape()
      iShape.moveTo(-W / 2, -T / 2)
      iShape.lineTo(W / 2, -T / 2)
      iShape.lineTo(W / 2, -T / 2 + fl)
      iShape.lineTo(web / 2, -T / 2 + fl)
      iShape.lineTo(web / 2, T / 2 - fl)
      iShape.lineTo(W / 2, T / 2 - fl)
      iShape.lineTo(W / 2, T / 2)
      iShape.lineTo(-W / 2, T / 2)
      iShape.lineTo(-W / 2, T / 2 - fl)
      iShape.lineTo(-web / 2, T / 2 - fl)
      iShape.lineTo(-web / 2, -T / 2 + fl)
      iShape.lineTo(-W / 2, -T / 2 + fl)
      iShape.closePath()
      const beamLen = l * 0.82
      const beamGeo = new THREE.ExtrudeGeometry(iShape, { depth: beamLen, bevelEnabled: false })
      beamGeo.rotateX(Math.PI / 2)
      beamGeo.translate(0, beamLen / 2, 0)
      rodMesh.add(new THREE.Mesh(beamGeo, rodMat))
      const bigEye = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.27, boreR * 0.27, boreR * 0.3, 18), rodMat)
      bigEye.rotation.z = Math.PI / 2
      bigEye.position.y = -l / 2
      rodMesh.add(bigEye)
      const smallEye = new THREE.Mesh(new THREE.CylinderGeometry(boreR * 0.17, boreR * 0.17, boreR * 0.26, 14), rodMat)
      smallEye.rotation.z = Math.PI / 2
      smallEye.position.y = l / 2
      rodMesh.add(smallEye)
      // semicojinete de biela (nivel inspección)
      const shell = new THREE.Mesh(
        new THREE.CylinderGeometry(boreR * 0.2, boreR * 0.2, boreR * 0.26, 10, 1, false, 0, Math.PI),
        cadMat('#8a7a55')
      )
      shell.rotation.z = Math.PI / 2
      shell.position.y = -l / 2
      shell.name = 'ring-fine'
      rodMesh.add(shell)
      rodMesh.userData['part'] = `Biela ${i + 1}`
      root.add(rodMesh)

      rigs.push({
        piston,
        rod,
        pistonCollider,
        rodCollider,
        joints: [jRodCrank, jRodPiston, jPistonBlock],
        pistonMesh,
        rodMesh,
        pistonMat,
        rodMat,
        prevY: pinY0,
        rising: false,
        strokePhase: i % 2,
        broken: false
      })
    }
    rigsRef.current = rigs

    return () => {
      scene.remove(root)
      det.dispose()
      detailRef.current = null
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          if (o.material instanceof THREE.Material) o.material.dispose()
        }
      })
      world.free()
      worldRef.current = null
      rigsRef.current = []
    }
  }, [scene, sockets, g])

  // ---- biela personalizada del sandbox: sustituye la malla del cilindro 1 ----
  useEffect(() => {
    const rig = rigsRef.current[0]
    if (!rig || !customRod) return
    rig.rodMesh.children.forEach((c) => (c.visible = false))
    const holder = new THREE.Group()
    holder.add(customRod)
    rig.rodMesh.add(holder)
    return () => {
      rig.rodMesh.remove(holder)
      rig.rodMesh.children.forEach((c) => (c.visible = true))
    }
  }, [customRod])

  // ---- composer con OutlinePass para el focus zoom (§7) ----
  useEffect(() => {
    const composer = new EffectComposer(gl)
    composer.addPass(new RenderPass(scene, camera))
    const outline = new OutlinePass(new THREE.Vector2(size.width, size.height), scene, camera)
    outline.edgeStrength = 4
    outline.edgeGlow = 0.4
    outline.visibleEdgeColor.set('#7fb4ff')
    outline.hiddenEdgeColor.set('#25406b')
    composer.addPass(outline)
    composer.addPass(new OutputPass())
    composerRef.current = composer
    outlineRef.current = outline
    return () => {
      composer.dispose()
      composerRef.current = null
    }
  }, [gl, scene, camera, size])

  const breakCylinder = useCallback(
    (rig: CylinderRig, mode: FailureMode, text: string) => {
      const world = worldRef.current
      if (!world || rig.broken) return
      rig.broken = true
      // §4A: destruye las juntas y libera los cuerpos para que reboten en el cárter
      for (const j of rig.joints) world.removeImpulseJoint(j, true)
      rig.joints = []
      rig.pistonCollider.setCollisionGroups(GROUP_LOOSE)
      rig.rodCollider.setCollisionGroups(GROUP_LOOSE)
      rig.rod.applyImpulse({ x: (Math.random() - 0.5) * 2, y: -1.5, z: (Math.random() - 0.5) * 2 }, true)
      // tinte rojo neón en el frame exacto del fallo
      neonRed(rig.rodMat)
      neonRed(rig.pistonMat)
      statusRef.current = 'broken'
      failureRef.current = { mode, text }
      audio.clank()
    },
    [audio]
  )

  useFrame((state, rawDt) => {
    const world = worldRef.current
    const crank = crankRef.current
    const rigs = rigsRef.current
    if (!world || !crank) return
    const c = controls.current
    /** Gas efectivo: palanca (posición fija) o pedal (momentáneo), el mayor. */
    const gas = Math.max(c.throttle, c.pedal)
    const dt = Math.min(rawDt, 0.05)
    const dead = statusRef.current === 'broken' || statusRef.current === 'seized'

    // ---- modelo de RPM real (par − fricción sobre inercia) ----
    let rpm = rpmRef.current
    if (!c.paused) {
      const omega = (rpm * 2 * Math.PI) / 60
      let torque = 0
      if (!dead && c.ignition) {
        if (rpm < IDLE_RPM * 0.8) torque += 55 // §5: motor de arranque
        const throttleEff = Math.max(gas, rpm < IDLE_RPM * 1.15 ? 0.08 : 0)
        if (rpm < c.revLimit) {
          // §4C: si la ECU se configura sin protección, el par residual a
          // alto régimen basta para llevar el motor a la zona de rotura
          const curve = Math.max(Math.sin(Math.min((rpm / 8200) * Math.PI, Math.PI)), 0.38)
          torque += 260 * curve * throttleEff
        }
      }
      // fricción + pérdidas de bombeo con gas cerrado (freno motor real)
      const friction =
        4 +
        3e-5 * omega * omega +
        (1 - gas) * 1.7e-4 * omega * omega +
        (statusRef.current === 'seized' ? 500 : 0)
      const domega = ((torque - friction) / 0.9) * dt
      const newOmega = Math.max(omega + domega, 0)
      rpm = (newOmega * 60) / (2 * Math.PI)
      if (dead && rpm < 30) rpm = 0
      rpmRef.current = rpm
      thetaRef.current += newOmega * dt
      if (!dead) statusRef.current = c.ignition ? (rpm > IDLE_RPM * 0.8 ? 'running' : 'cranking') : 'off'
      if (!c.ignition && !dead && rpm < 40) statusRef.current = 'off'
    }

    // ---- cámara lenta automática + paso de Rapier con sub-pasos ----
    const omegaReal = (rpm * 2 * Math.PI) / 60
    const visualOmega = visualOmegaFor(rpm, omegaReal)
    const slowmo = omegaReal > 0 ? visualOmega / omegaReal : 1
    if (!c.paused) {
      crank.setAngvel({ x: visualOmega, y: 0, z: 0 }, true)
      // sub-pasos: ≤0.12 rad de giro por paso para que las juntas no deriven
      const substeps = Math.min(Math.max(Math.ceil((visualOmega * dt) / 0.12), 1), 10)
      world.timestep = dt / substeps
      for (let s = 0; s < substeps; s++) world.step()
      // ángulo visual acumulado: gobierna levas, válvulas y cadena
      thetaVisRef.current += visualOmega * dt
    }

    // ---- sincroniza mallas con cuerpos ----
    const crankMesh = crankMeshRef.current
    if (crankMesh) {
      const rot = crank.rotation()
      crankMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w)
    }
    for (const rig of rigs) {
      const pt = rig.piston.translation()
      rig.pistonMesh.position.set(pt.x, pt.y, pt.z)
      const pr = rig.piston.rotation()
      rig.pistonMesh.quaternion.set(pr.x, pr.y, pr.z, pr.w)
      const rt = rig.rod.translation()
      rig.rodMesh.position.set(rt.x, rt.y, rt.z)
      const rr = rig.rod.rotation()
      rig.rodMesh.quaternion.set(rr.x, rr.y, rr.z, rr.w)
    }

    // ---- ECU: sensor de PMS sobre el deslizamiento del pistón (§5) ----
    const boostBar = gas * Math.min(rpm / 3800, 1) * 1.1 * (engine.assembly.aspiration.spec.type === 'turbo' ? 1 : 0)
    const pCombBar = 18 + gas * (40 + 26 * boostBar)
    if (!c.paused && !dead && rpm > 200) {
      for (let i = 0; i < rigs.length; i++) {
        const rig = rigs[i]!
        if (rig.broken) continue
        const y = rig.piston.translation().y
        const wasRising = rig.rising
        rig.rising = y > rig.prevY + 1e-5 ? true : y < rig.prevY - 1e-5 ? false : rig.rising
        if (wasRising && !rig.rising) {
          // PMS detectado; alterna compresión/escape (ciclo de 4 tiempos)
          rig.strokePhase = 1 - rig.strokePhase
          if (rig.strokePhase === 1) {
            const fComb = Math.PI * (g.bore / 2) ** 2 * pCombBar * 1e5 * gas
            rig.piston.applyImpulse({ x: 0, y: -Math.min(fComb, 8e4) * 6e-5, z: 0 }, true)
            if (c.pulses) {
              // §4: material exacto de pulso en inyector + bobina y
              // PointLight de alta intensidad durante 15 ms estrictos
              const light = sparkLights.current[i]
              if (light) light.intensity = 70
              sparkTimers.current[i] = 0.015
              const det = detailRef.current
              if (det) {
                const gi = det.glowInjector[i]
                const gc = det.glowCoil[i]
                if (gi) setActuatorPulse(gi, true)
                if (gc) setActuatorPulse(gc, true)
              }
            }
          }
        }
        rig.prevY = y
      }
    }
    for (let i = 0; i < sparkTimers.current.length; i++) {
      if (sparkTimers.current[i]! > 0) {
        sparkTimers.current[i]! -= dt
        if (sparkTimers.current[i]! <= 0) {
          const light = sparkLights.current[i]
          if (light) light.intensity = 0
          const det = detailRef.current
          if (det) {
            const gi = det.glowInjector[i]
            const gc = det.glowCoil[i]
            if (gi) setActuatorPulse(gi, false)
            if (gc) setActuatorPulse(gc, false)
          }
        }
      }
    }

    // ---- fatiga y rotura con ω REAL (§4A) ----
    const material = PHYS_MATERIALS[c.materialId]
    const rodArea = c.rodAreaMm2 * 1e-6
    const rodLen = c.rodLengthMm * 1e-3
    const mPiston = engine.assembly.piston.spec.mass + 0.3 * (rodArea * rodLen * material.density * 1.15)
    const bolts = BOLT_KITS[c.boltKit]
    const stressTdcPower = checkStress({
      mPiston,
      omega: omegaReal,
      r: g.stroke / 2,
      rodLength: rodLen,
      rodArea,
      material,
      pComb: dead || !c.ignition ? 0 : pCombBar * 1e5,
      pistonArea: Math.PI * (g.bore / 2) ** 2,
      throttle: gas,
      theta: 0,
      boltDiameter: bolts.diameter,
      boltYield: bolts.yield
    })
    const stressTdcExhaust = checkStress({
      mPiston,
      omega: omegaReal,
      r: g.stroke / 2,
      rodLength: rodLen,
      rodArea,
      material,
      pComb: 0,
      pistonArea: Math.PI * (g.bore / 2) ** 2,
      throttle: 0,
      theta: 0,
      boltDiameter: bolts.diameter,
      boltYield: bolts.yield
    })
    const worst = stressTdcExhaust.sigma > stressTdcPower.sigma ? stressTdcExhaust : stressTdcPower
    const failure = stressTdcExhaust.failure ?? stressTdcPower.failure
    if (!c.paused && !dead && failure) {
      const victim = rigs.find((rg) => !rg.broken)
      if (victim) {
        const texts: Record<Exclude<FailureMode, null>, string> = {
          traccion: `σ = ${(worst.sigma / 1e6).toFixed(0)} MPa > límite elástico ${(worst.sigmaLimit / 1e6).toFixed(0)} MPa (${material.name}) a ${rpm.toFixed(0)} rpm`,
          pandeo: `compresión ${(stressTdcPower.eulerLoad / 1e3).toFixed(1)} kN > P_crit de Euler ${(stressTdcPower.eulerLimit / 1e3).toFixed(1)} kN (sección ${c.rodAreaMm2} mm²)`,
          pernos: `tracción por perno ${(worst.boltSigma / 1e6).toFixed(0)} MPa > fluencia ${(worst.boltLimit / 1e6).toFixed(0)} MPa (${bolts.label}) en el cruce de escape`
        }
        breakCylinder(victim, failure, texts[failure])
      }
    }

    // ---- térmica, dilatación y gripaje (§4B) ----
    if (!c.paused && !dead && rpm > 100) {
      thermal.current = thermalStep(thermal.current, {
        rpm,
        throttle: Math.max(gas, 0.06),
        pCylBar: pCombBar,
        waterFlow: c.waterFlow,
        oilFlow: c.oilFlow,
        tAmbient: AMBIENT_K,
        heatCapacity: 90000,
        dt
      })
      const seizure = {
        pistonRadius: (g.bore / 2) * PISTON_COLD_FACTOR,
        boreRadius: g.bore / 2,
        tMotor: thermal.current.tMotor,
        tAmbient: AMBIENT_K,
        thermalExpansion: PHYS_MATERIALS.aluminio.thermalExpansion
      }
      if (isSeized(seizure)) {
        statusRef.current = 'seized'
        failureRef.current = {
          mode: null,
          text: `gripaje: el pistón dilatado toca la camisa a ${(thermal.current.tMotor - 273.15).toFixed(0)} °C — fricción infinita en la deslizante`
        }
        const victim = rigs.find((rg) => !rg.broken)
        if (victim) {
          neonRed(victim.pistonMat)
          victim.pistonMat.emissive.set('#ff7a1a')
        }
        audio.clank()
      }
    } else if (rpm < 100) {
      thermal.current = thermalStep(thermal.current, {
        rpm: 0,
        throttle: 0,
        pCylBar: 0,
        waterFlow: Math.max(c.waterFlow, 0.2),
        oilFlow: c.oilFlow,
        tAmbient: AMBIENT_K,
        heatCapacity: 90000,
        dt
      })
    }

    // ---- audio acoplado a la física (§6) ----
    if (c.paused) audio.suspend()
    else {
      audio.resume()
      audio.update(rpm, g.cylinders, gas, pCombBar / 6, boostBar)
    }

    // ---- escalado paramétrico en caliente (§1B): solo matrices ----
    const sc = rodScale({ length: rodLen, area: rodArea }, originalRodLength, originalRodArea)
    for (const rig of rigs) {
      if (!rig.broken) rig.rodMesh.scale.set(sc.x, Math.min(sc.y, 1.15), sc.z)
    }

    // ---- LOD dinámico por distancia (§3): inspección / banco / global ----
    const engineCenter = orbitRef.current?.target ?? new THREE.Vector3(0, sockets.block.deckY * 0.5, 0)
    const camDist = state.camera.position.distanceTo(engineCenter)
    const tier: LodTier = camDist < sockets.spacing * 5 ? 0 : camDist < sockets.spacing * 9.5 ? 1 : 2
    const det = detailRef.current
    if (det) {
      det.update(thetaVisRef.current, tier)
      // pernos de biela instanciados: matrices por frame desde los cuerpos
      if (tier === 0) {
        const off = new THREE.Matrix4()
        const world4 = new THREE.Matrix4()
        for (let i = 0; i < rigs.length; i++) {
          const rig = rigs[i]!
          rig.rodMesh.updateMatrix()
          for (const [b, sSign] of [
            [0, -1],
            [1, 1]
          ] as Array<[number, number]>) {
            off.makeTranslation(sSign * sockets.boreRadius * 0.16, -sockets.rodLength / 2 - sockets.boreRadius * 0.1, 0)
            world4.multiplyMatrices(rig.rodMesh.matrix, off)
            det.rodBolts.setMatrixAt(i * 2 + b, world4)
          }
        }
        det.rodBolts.instanceMatrix.needsUpdate = true
      }
    }
    if (tier !== tierRef.current) {
      tierRef.current = tier
      // segmentos, bulones y semicojinetes de las piezas móviles
      scene.traverse((o) => {
        if (o.name === 'ring-fine') o.visible = tier === 0
      })
    }
    const dbg = window as unknown as Record<string, unknown>
    dbg['__mfTier'] = tier
    dbg['__mfDist'] = camDist

    // ---- focus zoom con lerp + outline (§7) ----
    const focus = focusRef.current
    if (focus) {
      state.camera.position.lerp(focus.camPos, 0.06)
      orbitRef.current?.target.lerp(focus.target, 0.08)
      orbitRef.current?.update()
      if (state.camera.position.distanceTo(focus.camPos) < 0.05) focusRef.current = null
    }
    if (outlineRef.current) {
      outlineRef.current.selectedObjects = focus ? [focus.obj] : []
    }
    composerRef.current?.render()

    // ---- telemetría a ~12 Hz ----
    telemetryClock.current += dt
    if (telemetryClock.current > 0.08) {
      telemetryClock.current = 0
      const clearance =
        (g.bore / 2 -
          hotPistonRadius({
            pistonRadius: (g.bore / 2) * PISTON_COLD_FACTOR,
            boreRadius: g.bore / 2,
            tMotor: thermal.current.tMotor,
            tAmbient: AMBIENT_K,
            thermalExpansion: PHYS_MATERIALS.aluminio.thermalExpansion
          })) *
        1e6
      onTelemetry({
        rpm,
        slowmo,
        sigmaMpa: worst.sigma / 1e6,
        sigmaLimitMpa: worst.sigmaLimit / 1e6,
        eulerPct: stressTdcPower.eulerLimit > 0 ? (stressTdcPower.eulerLoad / stressTdcPower.eulerLimit) * 100 : 0,
        boltPct: (worst.boltSigma / worst.boltLimit) * 100,
        tMotorC: thermal.current.tMotor - 273.15,
        boostBar,
        pistonClearanceUm: clearance,
        status: statusRef.current,
        failure: failureRef.current.mode,
        failureText: failureRef.current.text
      })
    }
  }, 1)

  const handleDoubleClick = (e: { object: THREE.Object3D; point: THREE.Vector3; stopPropagation: () => void }): void => {
    e.stopPropagation()
    let obj: THREE.Object3D = e.object
    while (obj.parent && !obj.userData['part']) obj = obj.parent
    const dir = camera.position.clone().sub(e.point).normalize()
    focusRef.current = {
      target: e.point.clone(),
      camPos: e.point.clone().add(dir.multiplyScalar(sockets.spacing * 1.8)),
      obj
    }
  }

  const floorY = engineFloorY(sockets.crankRadius)

  return (
    <group onDoubleClick={handleDoubleClick}>
      <ambientLight intensity={0.35} />
      <directionalLight
        position={[9, 14, 7]}
        intensity={2.1}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-camera-near={2}
        shadow-camera-far={40}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-7, 5, -6]} intensity={0.55} color="#9db8e8" />
      <spotLight position={[0, sockets.block.deckY * 3.2, 4]} intensity={30} angle={0.7} penumbra={0.7} decay={1.6} />
      {/* suelo de celda: atrapasombras + rejilla técnica */}
      <mesh rotation-x={-Math.PI / 2} position={[0, floorY, 0]} receiveShadow>
        <planeGeometry args={[90, 90]} />
        <shadowMaterial opacity={0.42} />
      </mesh>
      <Grid
        position={[0, floorY + 0.01, 0]}
        args={[90, 90]}
        cellSize={0.62}
        cellThickness={0.6}
        cellColor="#141b26"
        sectionSize={3.1}
        sectionThickness={1}
        sectionColor="#20293a"
        fadeDistance={38}
        fadeStrength={1.6}
      />
      <OrbitControls
        ref={orbitRef}
        target={[0, sockets.block.deckY * 0.5, 0]}
        enableDamping
        dampingFactor={0.12}
        minDistance={sockets.spacing * 1.2}
        maxDistance={sockets.spacing * 12}
      />
    </group>
  )
}

// ---------------------------------------------------------------------------

interface Props {
  engine: ResolvedEngine
}

export default function PhysicsLab({ engine }: Props): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [sceneKey, setSceneKey] = useState(0)
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null)
  const [sandbox, setSandbox] = useState(false)
  const [glbFile, setGlbFile] = useState<{ name: string; data: ArrayBuffer } | null>(null)
  const [customRod, setCustomRod] = useState<THREE.Group | null>(null)
  const [customSockets, setCustomSockets] = useState<CustomSockets | null>(null)
  const audio = useMemo(() => new EngineAudio(), [])
  const fileInput = useRef<HTMLInputElement>(null)

  const controls = useRef<LabControls>({
    throttle: 0,
    pedal: 0,
    ignition: false,
    pulses: true,
    revLimit: 7200,
    waterFlow: 1,
    oilFlow: 1,
    rodLengthMm: engine.geometry.rodLength * 1000,
    rodAreaMm2: 300,
    materialId: 'acero',
    boltKit: 'arp',
    paused: false
  })
  // estado espejo para re-render de la UI (la escena lee el ref)
  const [ui, setUi] = useState({ ...controls.current })
  const setControl = <K extends keyof LabControls>(key: K, value: LabControls[K]): void => {
    controls.current[key] = value
    setUi({ ...controls.current })
  }

  useEffect(() => {
    void RAPIER.init().then(() => setReady(true))
  }, [])

  // Pedal momentáneo: mantener pulsado abre gas con rampa mecánica;
  // al soltar, el muelle lo devuelve (más rápido) a la posición de palanca.
  const pedalHeld = useRef(false)
  const [pedalPct, setPedalPct] = useState(0)
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const loop = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      const cur = controls.current.pedal
      const target = pedalHeld.current ? 1 : 0
      const rate = pedalHeld.current ? 2.4 : 4.5
      const next = cur + Math.sign(target - cur) * Math.min(Math.abs(target - cur), rate * dt)
      if (next !== cur) {
        controls.current.pedal = next
        setPedalPct(next)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const pedalDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* eventos sintéticos sin puntero activo */
    }
    pedalHeld.current = true
    audio.start()
  }
  const pedalUp = (): void => {
    pedalHeld.current = false
  }

  useEffect(() => () => audio.dispose(), [audio])

  const toggleSandbox = (): void => {
    const next = !sandbox
    setSandbox(next)
    setControl('paused', next) // §2A: physicsPaused + parada del bucle de sonido
    if (next) {
      setControl('ignition', false)
      audio.suspend()
    } else {
      audio.resume()
    }
  }

  const pickGlb = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return
    void file.arrayBuffer().then((data) => setGlbFile({ name: file.name, data }))
    e.target.value = ''
  }

  const rebuild = (): void => {
    audio.revive()
    setTelemetry(null)
    setSceneKey((k) => k + 1)
  }

  const startIgnition = (): void => {
    audio.start() // el AudioContext requiere gesto de usuario
    setControl('ignition', !ui.ignition)
  }

  const t = telemetry
  const sigmaPct = t ? Math.min((t.sigmaMpa / Math.max(t.sigmaLimitMpa, 1)) * 100, 100) : 0
  const tempPct = ((t?.tMotorC ?? 25) - 25) / 1.3
  const statusLabel: Record<Telemetry['status'], string> = {
    off: 'PARADO',
    cranking: 'ARRANQUE',
    running: 'EN MARCHA',
    broken: 'ROTURA',
    seized: 'GRIPADO'
  }
  const dead = t?.status === 'broken' || t?.status === 'seized'

  const bar = (pct: number): string => `${Math.min(Math.max(pct, 0), 100).toFixed(1)}%`
  const barClass = (pct: number): string =>
    pct > 90 ? 'phys-bar-fill danger' : pct > 70 ? 'phys-bar-fill warn' : 'phys-bar-fill'

  const led = (on: boolean, alert = false): string => `phys-led${alert ? ' alert' : on ? ' on' : ''}`

  const gauge = (
    label: string,
    value: string,
    pct: number,
    plain = false
  ): React.JSX.Element => (
    <div className="phys-gauge">
      <div className="phys-gauge-head">
        <span className="phys-gauge-label">{label}</span>
        <span className="phys-gauge-value">{value}</span>
      </div>
      <div className="phys-bar">
        <div className={plain ? 'phys-bar-fill' : barClass(pct)} style={{ width: bar(pct) }} />
        {!plain && <span className="phys-bar-mark" />}
      </div>
    </div>
  )

  return (
    <div className="phys-lab">
      <div className="phys-canvas">
        {ready ? (
          <Canvas key={sceneKey} shadows dpr={[1, 1.75]} camera={{ position: [5.2, 5.2, 6.2], fov: 40 }} gl={{ antialias: true }}>
            <PhysicsScene
              engine={engine}
              controls={controls}
              onTelemetry={setTelemetry}
              audio={audio}
              customRod={customRod}
            />
          </Canvas>
        ) : (
          <p className="empty-note">Inicializando motor de físicas (Rapier WASM)…</p>
        )}

        {/* HUD de visor: esquinas + lectura de cámara lenta */}
        <span className="phys-corner tl" />
        <span className="phys-corner tr" />
        <span className="phys-corner bl" />
        <span className="phys-corner br" />
        <div className="phys-hud">
          <span>ω REAL {(((t?.rpm ?? 0) * 2 * Math.PI) / 60).toFixed(0)} rad/s</span>
          <span>REPRODUCCIÓN ×{(t?.slowmo ?? 1).toFixed(t && t.slowmo < 0.1 ? 3 : 2)}</span>
          <span>SUBPASOS FÍSICA ACTIVOS</span>
        </div>

        {sandbox && <div className="phys-sandbox-banner">CUSTOM SANDBOX · FÍSICA EN PAUSA</div>}
        {t?.failureText && (
          <div className="phys-failure-banner">
            <span className="phys-failure-title">INFORME DE FALLO — {t.status === 'seized' ? 'GRIPADO' : 'ROTURA'}</span>
            {t.failureText}
          </div>
        )}
        <div className="canvas-hint">doble clic: focus zoom · rueda: zoom · arrastrar: girar</div>
      </div>

      <aside className="phys-panel">
        <header className="phys-head">
          <div>
            <span className="phys-head-title">CELDA DE ENSAYO 02</span>
            <span className="phys-head-sub">TREN ALTERNATIVO · {engine.geometry.cylinders} CIL · {(engine.geometry.displacement * 1e3).toFixed(1)} L</span>
          </div>
          <div className="phys-leds">
            <span className="phys-led-item"><i className={led(ui.ignition, dead)} />IGN</span>
            <span className="phys-led-item"><i className={led((t?.rpm ?? 0) > 400)} />ECU</span>
            <span className="phys-led-item"><i className={led(ui.waterFlow > 0.3, tempPct > 90)} />WTR</span>
            <span className="phys-led-item"><i className={led(ui.oilFlow > 0.3)} />OIL</span>
          </div>
        </header>

        <div className="phys-tach-block">
          <Tachometer rpm={t?.rpm ?? 0} redline={ui.revLimit} />
          <div className="phys-tach-digits">
            <span className={`phys-status-tag ${t?.status ?? 'off'}`}>{statusLabel[t?.status ?? 'off']}</span>
            <span className="phys-rpm">{(t?.rpm ?? 0).toFixed(0).padStart(5, '0')}</span>
            <span className="phys-rpm-unit">RPM</span>
          </div>
        </div>

        <section className="phys-section">
          <h3 className="phys-section-title"><em>01</em> TELEMETRÍA</h3>
          {gauge('σ BIELA', `${(t?.sigmaMpa ?? 0).toFixed(0)} / ${(t?.sigmaLimitMpa ?? 0).toFixed(0)} MPa`, sigmaPct)}
          {gauge('PANDEO EULER', `${(t?.eulerPct ?? 0).toFixed(0)} %`, t?.eulerPct ?? 0)}
          {gauge('PERNOS SOMBRERETE', `${(t?.boltPct ?? 0).toFixed(0)} %`, t?.boltPct ?? 0)}
          {gauge('T MOTOR', `${(t?.tMotorC ?? 25).toFixed(0)} °C · ${(t?.pistonClearanceUm ?? 60).toFixed(0)} µm`, tempPct)}
          {gauge('BOOST', `${(t?.boostBar ?? 0).toFixed(2)} bar`, ((t?.boostBar ?? 0) / 1.5) * 100, true)}
        </section>

        <div className="phys-mid">
          <section className="phys-section phys-throttle-block">
            <h3 className="phys-section-title"><em>02</em> MANDO</h3>
            <div className="phys-throttle-wrap">
              <span className="phys-throttle-scale"><i>100</i><i>75</i><i>50</i><i>25</i><i>0</i></span>
              <input
                id="phys-throttle"
                className="phys-throttle"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={ui.throttle}
                onChange={(e) => setControl('throttle', Number(e.target.value))}
                aria-label="Acelerador (palanca)"
              />
            </div>
            <span className="phys-throttle-readout">
              {(Math.max(ui.throttle, pedalPct) * 100).toFixed(0)}<i>%</i>
            </span>
            <button
              type="button"
              className={`phys-pedal ${pedalPct > 0.02 ? 'pressed' : ''}`}
              onPointerDown={pedalDown}
              onPointerUp={pedalUp}
              onPointerCancel={pedalUp}
              disabled={sandbox}
              aria-label="Pedal de acelerador: mantener pulsado"
            >
              <i
                className="phys-pedal-face"
                style={{ transform: `rotateX(${14 + pedalPct * 26}deg)` }}
              />
              <span>PEDAL</span>
            </button>
          </section>

          <section className="phys-section">
            <h3 className="phys-section-title"><em>03</em> CONTROL</h3>
            <div className="phys-buttons">
              <button className={`pbtn ${ui.ignition ? 'armed' : ''}`} onClick={startIgnition} disabled={sandbox}>
                {ui.ignition ? 'CORTAR' : 'IGNITION'}
              </button>
              <button className="pbtn" onClick={rebuild}>RECONSTRUIR</button>
              <button className={`pbtn ${sandbox ? 'armed' : ''}`} onClick={toggleSandbox}>
                {sandbox ? 'SELLAR ENSAMBLAJE' : 'CUSTOM SANDBOX'}
              </button>
              {sandbox && (
                <>
                  <button className="pbtn" onClick={() => fileInput.current?.click()}>IMPORTAR .GLB…</button>
                  <input ref={fileInput} type="file" accept=".glb,.gltf" hidden onChange={pickGlb} />
                </>
              )}
              <label className="phys-toggle">
                <input
                  type="checkbox"
                  checked={ui.pulses}
                  onChange={(e) => setControl('pulses', e.target.checked)}
                />
                PULSOS ELECTRÓNICOS
              </label>
            </div>
          </section>
        </div>

        <section className="phys-section">
          <h3 className="phys-section-title"><em>04</em> REGLAJE</h3>
          <div className="phys-field">
            <label htmlFor="phys-material">MATERIAL BIELA</label>
            <select id="phys-material" value={ui.materialId} onChange={(e) => setControl('materialId', e.target.value as PhysMaterial['id'])}>
              {Object.values(PHYS_MATERIALS).map((m) => (
                <option key={m.id} value={m.id}>{m.name} · E {m.youngModulus / 1e9} GPa</option>
              ))}
            </select>
          </div>
          <div className="phys-field">
            <label htmlFor="phys-bolts">PERNOS SOMBRERETE</label>
            <select id="phys-bolts" value={ui.boltKit} onChange={(e) => setControl('boltKit', e.target.value as 'serie' | 'arp')}>
              <option value="serie">{BOLT_KITS.serie.label}</option>
              <option value="arp">{BOLT_KITS.arp.label}</option>
            </select>
          </div>
          <div className="phys-field">
            <label htmlFor="phys-rodlen">L BIELA <b>{ui.rodLengthMm.toFixed(0)} mm</b></label>
            <input id="phys-rodlen" type="range" min="120" max="180" step="1" value={ui.rodLengthMm}
              onChange={(e) => setControl('rodLengthMm', Number(e.target.value))} />
          </div>
          <div className="phys-field">
            <label htmlFor="phys-rodarea">SECCIÓN BIELA <b>{ui.rodAreaMm2} mm²</b></label>
            <input id="phys-rodarea" type="range" min="110" max="650" step="10" value={ui.rodAreaMm2}
              onChange={(e) => setControl('rodAreaMm2', Number(e.target.value))} />
          </div>
          <div className="phys-field">
            <label htmlFor="phys-revlimit">
              CORTE ECU <b className={ui.revLimit > 9000 ? 'danger-text' : ''}>{ui.revLimit} rpm{ui.revLimit > 9000 ? ' · SIN PROTECCIÓN' : ''}</b>
            </label>
            <input id="phys-revlimit" type="range" min="6000" max="12500" step="100" value={ui.revLimit}
              onChange={(e) => setControl('revLimit', Number(e.target.value))} />
          </div>
          <div className="phys-field">
            <label htmlFor="phys-water">CAUDAL AGUA <b>{(ui.waterFlow * 100).toFixed(0)} %</b></label>
            <input id="phys-water" type="range" min="0" max="1" step="0.05" value={ui.waterFlow}
              onChange={(e) => setControl('waterFlow', Number(e.target.value))} />
          </div>
          <div className="phys-field">
            <label htmlFor="phys-oil">CAUDAL ACEITE <b>{(ui.oilFlow * 100).toFixed(0)} %</b></label>
            <input id="phys-oil" type="range" min="0" max="1" step="0.05" value={ui.oilFlow}
              onChange={(e) => setControl('oilFlow', Number(e.target.value))} />
          </div>
          {customSockets && (
            <p className="phys-note">
              SOCKETS PIEZA IMPORTADA — bulón ({customSockets.primary.x.toFixed(2)},{' '}
              {customSockets.primary.y.toFixed(2)}, {customSockets.primary.z.toFixed(2)}) · muñequilla (
              {customSockets.secondary.x.toFixed(2)}, {customSockets.secondary.y.toFixed(2)},{' '}
              {customSockets.secondary.z.toFixed(2)})
            </p>
          )}
        </section>
      </aside>

      {glbFile && (
        <SocketEditor
          file={glbFile}
          onCancel={() => setGlbFile(null)}
          onSave={(mesh, sockets) => {
            // §2C: distancia vectorial + orientación entre sockets → se
            // modifica .position/.quaternion (y escala) de la malla para que
            // su "Small End" se superponga EXACTAMENTE al socket del rig.
            const l = engine.geometry.rodLength * S
            const axis = sockets.primary.clone().sub(sockets.secondary)
            const k = axis.length() > 1e-6 ? l / axis.length() : 1
            const holder = new THREE.Group()
            holder.add(mesh)
            holder.quaternion.setFromUnitVectors(axis.clone().normalize(), new THREE.Vector3(0, 1, 0))
            holder.scale.setScalar(k)
            const worldPrimary = sockets.primary
              .clone()
              .multiplyScalar(k)
              .applyQuaternion(holder.quaternion)
            holder.position.copy(new THREE.Vector3(0, l / 2, 0).sub(worldPrimary))
            setCustomRod(holder)
            setCustomSockets(sockets)
            setGlbFile(null)
          }}
        />
      )}
    </div>
  )
}
