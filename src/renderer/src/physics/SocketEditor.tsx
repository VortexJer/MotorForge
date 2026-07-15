import { useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { CustomSockets } from './sockets'

/**
 * Asistente de Sockets (pliego §2B): lienzo dedicado con la pieza importada
 * aislada en el centro. El usuario instancia esferas guía y las arrastra con
 * el gizmo hasta los puntos de unión reales:
 *  - "Ubicar Bulón" → esfera AMARILLA en el ojo superior.
 *  - "Ubicar Muñequilla" → esfera ROJA en el ojo inferior.
 * Al guardar, las coordenadas locales viajan como CustomSockets.
 */

interface Props {
  file: { name: string; data: ArrayBuffer }
  onCancel: () => void
  onSave: (mesh: THREE.Group, sockets: CustomSockets) => void
}

type SocketKey = 'primary' | 'secondary'

const SOCKET_META: Record<SocketKey, { label: string; color: string }> = {
  primary: { label: 'Bulón', color: '#ffd21f' },
  secondary: { label: 'Muñequilla', color: '#ff3b30' }
}

export default function SocketEditor({ file, onCancel, onSave }: Props): React.JSX.Element {
  const [mesh, setMesh] = useState<THREE.Group | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [placed, setPlaced] = useState<Partial<Record<SocketKey, THREE.Vector3>>>({})
  const [active, setActive] = useState<SocketKey | null>(null)
  const [spheres, setSpheres] = useState<Partial<Record<SocketKey, THREE.Mesh>>>({})

  // parseo del .glb/.gltf y normalización al centro del lienzo
  useEffect(() => {
    let cancelled = false
    const loader = new GLTFLoader()
    loader.parse(
      file.data,
      '',
      (gltf) => {
        if (cancelled) return
        const group = new THREE.Group()
        group.add(gltf.scene)
        const box = new THREE.Box3().setFromObject(gltf.scene)
        const center = box.getCenter(new THREE.Vector3())
        const sizeV = box.getSize(new THREE.Vector3())
        const scale = 2.4 / Math.max(sizeV.x, sizeV.y, sizeV.z, 1e-6)
        gltf.scene.position.sub(center)
        group.scale.setScalar(scale)
        group.traverse((o) => {
          if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
            o.material.metalness = 0.05
            o.material.roughness = 0.9
          }
        })
        setMesh(group)
      },
      (e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudo parsear el .glb')
      }
    )
    return () => {
      cancelled = true
    }
  }, [file])

  const addSocket = (key: SocketKey): void => {
    if (!spheres[key]) {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 20, 20),
        new THREE.MeshStandardMaterial({
          color: SOCKET_META[key].color,
          emissive: SOCKET_META[key].color,
          emissiveIntensity: 0.55,
          roughness: 0.4
        })
      )
      s.position.set(0, key === 'primary' ? 0.8 : -0.8, 0)
      setSpheres((p) => ({ ...p, [key]: s }))
      setPlaced((p) => ({ ...p, [key]: s.position.clone() }))
    }
    setActive(key)
  }

  const commit = (): void => {
    const primary = spheres.primary?.position.clone()
    const secondary = spheres.secondary?.position.clone()
    if (!mesh || !primary || !secondary) return
    onSave(mesh, { kind: 'rod', primary, secondary })
  }

  const ready = useMemo(() => Boolean(spheres.primary && spheres.secondary), [spheres])

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Asistente de sockets">
      <div className="modal socket-modal">
        <header className="modal-head">
          <h2>Asistente de sockets — {file.name}</h2>
          <span className="modal-file">coloca los puntos de unión sobre la pieza</span>
        </header>

        <div className="socket-body">
          <div className="socket-canvas">
            {error && <div className="issue error"><span>✕</span><span>{error}</span></div>}
            {!mesh && !error && <p className="empty-note">Cargando malla…</p>}
            {mesh && (
              <Canvas camera={{ position: [2.6, 1.8, 2.6], fov: 40 }} dpr={[1, 2]}>
                <hemisphereLight args={['#dfe6f2', '#20242e', 1.3]} />
                <directionalLight position={[4, 5, 3]} intensity={1.4} />
                <primitive object={mesh} />
                {(Object.keys(spheres) as SocketKey[]).map((key) => {
                  const s = spheres[key]
                  if (!s) return null
                  return active === key ? (
                    <TransformControls
                      key={key}
                      object={s}
                      mode="translate"
                      size={0.7}
                      onObjectChange={() => setPlaced((p) => ({ ...p, [key]: s.position.clone() }))}
                    />
                  ) : (
                    <primitive key={key} object={s} onClick={() => setActive(key)} />
                  )
                })}
                <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
              </Canvas>
            )}
          </div>

          <div className="socket-side">
            {(Object.keys(SOCKET_META) as SocketKey[]).map((key) => (
              <div key={key} className="socket-item">
                <button
                  className={`btn ${active === key ? 'primary' : ''}`}
                  onClick={() => addSocket(key)}
                  disabled={!mesh}
                >
                  <span className="socket-dot" style={{ background: SOCKET_META[key].color }} /> Ubicar{' '}
                  {SOCKET_META[key].label}
                </button>
                {placed[key] && (
                  <code className="socket-coord">
                    ({placed[key]!.x.toFixed(2)}, {placed[key]!.y.toFixed(2)}, {placed[key]!.z.toFixed(2)})
                  </code>
                )}
              </div>
            ))}
            <p className="phys-note">
              Arrastra la esfera con el gizmo hasta centrarla en el agujero. La amarilla al ojo del
              bulón, la roja al de la muñequilla. Sus coordenadas locales se guardan con la pieza.
            </p>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onCancel}>Cancelar</button>
          <button className="btn primary" onClick={commit} disabled={!ready}>
            Guardar sockets
          </button>
        </footer>
      </div>
    </div>
  )
}
