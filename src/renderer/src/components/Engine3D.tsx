import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { PartKind, ResolvedGeometry } from '@sim/types'

/**
 * Vista técnica del motor, construida paramétricamente con la geometría REAL
 * del ensamblaje (diámetro, carrera, longitud de biela, altura de compresión).
 *
 * - Zoom lejos: motor "vestido" (bloque, tapa, cárter, polea, volante).
 * - Zoom cerca: la carcasa se desvanece y se ve el tren alternativo en marcha
 *   con cinemática biela-manivela exacta.
 * - La pieza que ha roto late en rojo.
 */

const S = 10 // escala de escena: 1 m → 10 unidades
const VISUAL_RPM = 160 // velocidad de animación (legible, no realista)
const FAIL_COLOR = '#d03b3b'

// I4 de plano de 180°: pistones 1-4 y 2-3 en fase opuesta
const PHASE = [0, Math.PI, Math.PI, 0]

interface Props {
  geometry: ResolvedGeometry
  failedKind: PartKind | null
}

interface Kinematics {
  boreR: number
  r: number
  l: number
  ch: number
  spacing: number
  deckY: number
  cylinders: number
  crankLen: number
  /** Distancias de cámara entre las que la carcasa pasa de sólida a invisible. */
  fadeNear: number
  fadeFar: number
  target: THREE.Vector3
}

function useKinematics(g: ResolvedGeometry): Kinematics {
  return useMemo(() => {
    const boreR = (g.bore / 2) * S
    const r = (g.stroke / 2) * S
    const l = g.rodLength * S
    const ch = 0.03 * S
    const spacing = g.bore * 1.3 * S
    const deckY = r + l + ch
    return {
      boreR,
      r,
      l,
      ch,
      spacing,
      deckY,
      cylinders: g.cylinders,
      crankLen: spacing * g.cylinders,
      fadeNear: spacing * 3.1,
      fadeFar: spacing * 5.4,
      target: new THREE.Vector3(0, deckY * 0.55, 0)
    }
  }, [g])
}

/** Mapa de entorno procedural (offline): imprescindible para que los metales no salgan negros. */
function Env(): null {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = envMap
    scene.environmentIntensity = 0.55
    return () => {
      scene.environment = null
      envMap.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

function metal(color: string, failed: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: failed ? FAIL_COLOR : color,
    metalness: failed ? 0.4 : 0.85,
    roughness: 0.35,
    emissive: new THREE.Color(failed ? FAIL_COLOR : '#000000'),
    emissiveIntensity: failed ? 0.45 : 0
  })
}

/** Latido rojo de la pieza rota. */
function pulse(mat: THREE.MeshStandardMaterial, t: number): void {
  mat.emissiveIntensity = 0.35 + 0.3 * Math.sin(t * 4.5)
}

const xPos = (i: number, k: Kinematics): number => (i - (k.cylinders - 1) / 2) * k.spacing

function CrankTrain({ k, failedKind }: { k: Kinematics; failedKind: PartKind | null }): React.JSX.Element {
  const theta = useRef(0)
  const pistonRefs = useRef<Array<THREE.Mesh | null>>([])
  const rodRefs = useRef<Array<THREE.Mesh | null>>([])
  const crankGroup = useRef<THREE.Group>(null)

  const { boreR, r, l, ch, spacing, cylinders, crankLen } = k
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const tmpDir = useMemo(() => new THREE.Vector3(), [])

  const pistonMat = useMemo(() => metal('#cdd3dd', failedKind === 'piston'), [failedKind])
  const rodMat = useMemo(() => metal('#98a2b3', failedKind === 'rod'), [failedKind])
  const crankMat = useMemo(() => metal('#717c8f', failedKind === 'crank'), [failedKind])

  const pistonH = ch * 1.8

  useFrame(({ clock }, dt) => {
    theta.current += (VISUAL_RPM / 60) * 2 * Math.PI * Math.min(dt, 0.05)
    const th = theta.current

    for (let i = 0; i < cylinders; i++) {
      const a = th + (PHASE[i] ?? 0)
      const sin = Math.sin(a)
      const cos = Math.cos(a)
      const pinY = r * cos + Math.sqrt(Math.max(l * l - r * r * sin * sin, 1e-6))

      const piston = pistonRefs.current[i]
      if (piston) piston.position.y = pinY + ch - pistonH / 2

      const rod = rodRefs.current[i]
      if (rod) {
        const midY = (r * cos + pinY) / 2
        const midZ = (r * sin) / 2
        rod.position.set(rod.position.x, midY, midZ)
        tmpDir.set(0, pinY - r * cos, -r * sin).normalize()
        rod.quaternion.setFromUnitVectors(up, tmpDir)
      }
    }
    if (crankGroup.current) crankGroup.current.rotation.x = th

    const t = clock.elapsedTime
    if (failedKind === 'piston') pulse(pistonMat, t)
    if (failedKind === 'rod') pulse(rodMat, t)
    if (failedKind === 'crank') pulse(crankMat, t)
  })

  return (
    <group>
      {Array.from({ length: cylinders }, (_, i) => (
        <group key={i} position={[xPos(i, k), 0, 0]}>
          <mesh ref={(m) => void (pistonRefs.current[i] = m)} material={pistonMat}>
            <cylinderGeometry args={[boreR * 0.955, boreR * 0.955, pistonH, 28]} />
          </mesh>
          <mesh ref={(m) => void (rodRefs.current[i] = m)} material={rodMat} position={[0, l / 2, 0]}>
            <cylinderGeometry args={[boreR * 0.14, boreR * 0.18, l, 12]} />
          </mesh>
        </group>
      ))}

      <group ref={crankGroup}>
        <mesh material={crankMat} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[boreR * 0.16, boreR * 0.16, crankLen + spacing * 0.6, 16]} />
        </mesh>
        {Array.from({ length: cylinders }, (_, i) => {
          const phase = PHASE[i] ?? 0
          return (
            <group key={i} position={[xPos(i, k), 0, 0]} rotation={[phase, 0, 0]}>
              <mesh material={crankMat} position={[0, r, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[boreR * 0.14, boreR * 0.14, spacing * 0.42, 14]} />
              </mesh>
              {[-1, 1].map((s) => (
                <group key={s} position={[s * spacing * 0.24, 0, 0]}>
                  <mesh material={crankMat} position={[0, r / 2, 0]}>
                    <boxGeometry args={[spacing * 0.1, r * 1.15, boreR * 0.42]} />
                  </mesh>
                  <mesh material={crankMat} position={[0, -r * 0.55, 0]}>
                    <cylinderGeometry
                      args={[r * 0.95, r * 0.95, spacing * 0.1, 20, 1, false, Math.PI / 2, Math.PI]}
                    />
                  </mesh>
                </group>
              ))}
            </group>
          )
        })}
      </group>
    </group>
  )
}

function Internals({ k, failedKind }: { k: Kinematics; failedKind: PartKind | null }): React.JSX.Element {
  const { boreR, spacing, deckY, cylinders } = k
  const linerLen = k.r * 2 * 1.45
  const blockFailed = failedKind === 'block'

  return (
    <group>
      {Array.from({ length: cylinders }, (_, i) => (
        <mesh key={i} position={[xPos(i, k), deckY - linerLen / 2, 0]}>
          <cylinderGeometry args={[boreR, boreR, linerLen, 36, 1, true]} />
          <meshPhysicalMaterial
            color={blockFailed ? FAIL_COLOR : '#9fb4cc'}
            metalness={0.1}
            roughness={0.15}
            transparent
            opacity={blockFailed ? 0.4 : 0.15}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
      <mesh position={[0, deckY + 0.01, 0]}>
        <boxGeometry args={[spacing * (cylinders + 0.6), 0.02, boreR * 3.2]} />
        <meshStandardMaterial
          color={blockFailed ? FAIL_COLOR : '#39404d'}
          metalness={0.6}
          roughness={0.5}
          transparent
          opacity={0.55}
        />
      </mesh>
    </group>
  )
}

/**
 * Carcasa exterior: sólida de lejos, se desvanece al acercar la cámara.
 */
function Exterior({ k, failedKind }: { k: Kinematics; failedKind: PartKind | null }): React.JSX.Element {
  const { boreR, r, spacing, deckY, cylinders, crankLen } = k
  const blockFailed = failedKind === 'block'
  const headFailed = failedKind === 'head'

  const casingMat = useMemo(() => {
    const m = metal(blockFailed ? FAIL_COLOR : '#525b69', blockFailed)
    m.transparent = true
    m.roughness = 0.5
    m.metalness = 0.7
    return m
  }, [blockFailed])
  const coverMat = useMemo(() => {
    const m = metal(headFailed ? FAIL_COLOR : '#3e4654', headFailed)
    m.transparent = true
    m.roughness = 0.45
    m.metalness = 0.65
    return m
  }, [headFailed])
  const panMat = useMemo(() => {
    const m = metal('#454d5a', false)
    m.transparent = true
    m.roughness = 0.55
    return m
  }, [])
  const mats = useMemo(() => [casingMat, coverMat, panMat], [casingMat, coverMat, panMat])

  useFrame(({ camera, clock }) => {
    const d = camera.position.distanceTo(k.target)
    const t = Math.min(1, Math.max(0, (d - k.fadeNear) / (k.fadeFar - k.fadeNear)))
    const opacity = t * 0.97
    for (const m of mats) {
      m.opacity = opacity
      m.depthWrite = opacity > 0.55
      m.visible = opacity > 0.02
    }
    const tt = clock.elapsedTime
    if (blockFailed) pulse(casingMat, tt)
    if (headFailed) pulse(coverMat, tt)
  })

  const casingW = spacing * (cylinders + 0.7)
  const casingD = boreR * 3.6
  const casingBottom = -r * 0.9
  const coverH = boreR * 1.5

  return (
    <group>
      {/* Bloque */}
      <mesh material={casingMat} position={[0, (deckY + casingBottom) / 2, 0]}>
        <boxGeometry args={[casingW, deckY - casingBottom, casingD]} />
      </mesh>
      {/* Tapa de balancines */}
      <mesh material={coverMat} position={[0, deckY + coverH / 2, 0]}>
        <boxGeometry args={[casingW, coverH, casingD * 0.92]} />
      </mesh>
      {/* Bobinas */}
      {Array.from({ length: cylinders }, (_, i) => (
        <mesh key={i} material={coverMat} position={[xPos(i, k), deckY + coverH + boreR * 0.22, 0]}>
          <cylinderGeometry args={[boreR * 0.18, boreR * 0.18, boreR * 0.45, 12]} />
        </mesh>
      ))}
      {/* Cárter */}
      <mesh material={panMat} position={[0, casingBottom - r * 0.65, 0]}>
        <boxGeometry args={[casingW * 0.86, r * 1.3, casingD * 0.8]} />
      </mesh>
      {/* Polea y volante */}
      <mesh material={panMat} position={[-crankLen / 2 - spacing * 0.35, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[r * 0.75, r * 0.75, spacing * 0.18, 24]} />
      </mesh>
      <mesh material={panMat} position={[crankLen / 2 + spacing * 0.35, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[r * 1.35, r * 1.35, spacing * 0.14, 28]} />
      </mesh>
    </group>
  )
}

export default function Engine3D({ geometry, failedKind }: Props): React.JSX.Element {
  const k = useKinematics(geometry)

  return (
    <div className="canvas-wrap">
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [k.spacing * 4.4, k.deckY * 1.9, k.spacing * 5], fov: 38 }}
        gl={{ antialias: true, alpha: true }}
      >
        <Env />
        <ambientLight intensity={0.8} />
        <directionalLight position={[6, 9, 5]} intensity={2.2} />
        <directionalLight position={[-7, 4, -5]} intensity={0.9} color="#8fb4ff" />
        <pointLight position={[0, k.deckY * 0.4, k.spacing * 2.5]} intensity={4} distance={12} />
        <CrankTrain k={k} failedKind={failedKind} />
        <Internals k={k} failedKind={failedKind} />
        <Exterior k={k} failedKind={failedKind} />
        <OrbitControls
          target={[k.target.x, k.target.y, k.target.z]}
          enableDamping
          dampingFactor={0.1}
          minDistance={k.spacing * 1.6}
          maxDistance={k.spacing * 9}
        />
      </Canvas>
      <div className="canvas-hint">rueda: zoom (lejos = motor completo, cerca = interior) · arrastrar: girar</div>
    </div>
  )
}
