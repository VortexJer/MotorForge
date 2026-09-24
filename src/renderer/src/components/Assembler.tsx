import { useCallback, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import { parseCadFile } from '../lib/geometryClient'
import {
  newProject, nextId, clonePart, cloneSeries, copyConfig, glue, movePart,
  serializeProject, parseProject, toScene
} from '@sim/assemble/project'
import type { AssemblyProject, ProjectPart } from '@sim/assemble/project'
import { MARKER } from '@sim/assemble/scene'
import type { PartRole, Vec3 } from '@sim/assemble/scene'
import { measureEngine } from '@sim/assemble/measure'
import { assembleEngine, toRunnable, toAssembly } from '@sim/assemble/toEngine'
import { SimLoop } from '@sim/hil/simLoop'
import { TICK_DT, defaultHarness } from '@sim/hil/types'
import { FUELS } from '@sim/index'
import type { AssembledEngine } from '@sim/assemble/toEngine'

/**
 * Montador 3D: traes tus modelos, dices qué es cada uno y les clavas los puntos
 * que definen su cinemática. De ahí sale el motor, sin catálogo.
 *
 * Las mallas viven fuera del proyecto (en un Map por id): el .json guarda solo
 * la receta. Ver la cabecera de `@sim/assemble/project` para el porqué.
 */

type Mallas = Map<string, Float32Array>

const ROLES: Array<[PartRole, string]> = [
  ['block', 'Bloque'], ['crank', 'Cigüeñal'], ['rod', 'Biela'], ['piston', 'Pistón'],
  ['head', 'Culata'], ['injector', 'Inyector'], ['sparkPlug', 'Bujía'],
  ['starter', 'Motor de arranque'], ['sensor', 'Sensor'], ['decor', 'Decorativa']
]

const COLOR: Record<PartRole, string> = {
  block: '#7b8794', crank: '#d08a3e', rod: '#9aa5b1', piston: '#cfd6dd',
  head: '#8c6f9e', injector: '#3fa7d6', sparkPlug: '#e0c341', starter: '#5fbf7a',
  sensor: '#d05a5a', decor: '#4a525c'
}

/** Qué marcadores tiene sentido poner en cada rol. */
const MARCADORES: Partial<Record<PartRole, Array<[string, string]>>> = {
  crank: [
    [MARKER.crankAxisA, 'Eje (extremo A)'],
    [MARKER.crankAxisB, 'Eje (extremo B)'],
    [MARKER.crankPin(0), 'Muñequilla cil. 1'], [MARKER.crankPin(1), 'Muñequilla cil. 2'],
    [MARKER.crankPin(2), 'Muñequilla cil. 3'], [MARKER.crankPin(3), 'Muñequilla cil. 4'],
    [MARKER.crankPin(4), 'Muñequilla cil. 5'], [MARKER.crankPin(5), 'Muñequilla cil. 6'],
    [MARKER.crankPin(6), 'Muñequilla cil. 7'], [MARKER.crankPin(7), 'Muñequilla cil. 8']
  ],
  rod: [[MARKER.rodSmallEnd, 'Ojo del bulón'], [MARKER.rodBigEnd, 'Ojo de muñequilla']],
  piston: [[MARKER.pistonPin, 'Eje del bulón'], [MARKER.pistonCrown, 'Centro de la corona']],
  head: [[MARKER.headDeck, 'Plano de junta']],
  injector: [[MARKER.injectorTip, 'Punta / salida del chorro']],
  sparkPlug: [[MARKER.sparkGap, 'Punto de chispa']],
  starter: [[MARKER.starterDrive, 'Punto de engrane']]
}

function bboxCentro(pos: Float32Array): Vec3 {
  let mnx = Infinity, mny = Infinity, mnz = Infinity
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity
  for (let i = 0; i < pos.length; i += 3) {
    mnx = Math.min(mnx, pos[i]!); mxx = Math.max(mxx, pos[i]!)
    mny = Math.min(mny, pos[i + 1]!); mxy = Math.max(mxy, pos[i + 1]!)
    mnz = Math.min(mnz, pos[i + 2]!); mxz = Math.max(mxz, pos[i + 2]!)
  }
  if (!Number.isFinite(mnx)) return [0, 0, 0]
  return [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2]
}

function PiezaMesh({
  part, positions, seleccionada, onClick
}: {
  part: ProjectPart; positions: Float32Array; seleccionada: boolean; onClick: () => void
}): React.JSX.Element {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.computeVertexNormals()
    return g
  }, [positions])
  return (
    <mesh
      geometry={geo}
      position={part.position as unknown as [number, number, number]}
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      <meshStandardMaterial
        color={COLOR[part.role]}
        roughness={0.55}
        metalness={0.25}
        emissive={seleccionada ? '#e10600' : '#000000'}
        emissiveIntensity={seleccionada ? 0.25 : 0}
      />
    </mesh>
  )
}

/** Gizmo que mueve lo seleccionado y avisa del desplazamiento acumulado. */
function Gizmo({
  target, onMove
}: { target: Vec3; onMove: (delta: Vec3) => void }): React.JSX.Element {
  const obj = useRef<THREE.Object3D>(new THREE.Object3D())
  const previo = useRef<Vec3>(target)
  const { camera, gl } = useThree()
  obj.current.position.set(target[0], target[1], target[2])
  previo.current = target
  return (
    <TransformControls
      camera={camera}
      domElement={gl.domElement}
      object={obj.current}
      mode="translate"
      onObjectChange={() => {
        const p = obj.current.position
        const d: Vec3 = [
          p.x - previo.current[0], p.y - previo.current[1], p.z - previo.current[2]
        ]
        if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 1e-9) {
          previo.current = [p.x, p.y, p.z]
          onMove(d)
        }
      }}
    />
  )
}

interface Props {
  project: AssemblyProject
  onChange: (p: AssemblyProject) => void
  onSalir: () => void
  /** Manda el motor montado al banco de potencia. */
  onAlBanco?: (parts: import('@sim/types').Part[], nombre: string) => void
}

export function Assembler({ project, onChange, onSalir, onAlBanco }: Props): React.JSX.Element {
  const [mallas, setMallas] = useState<Mallas>(new Map())
  const [selPieza, setSelPieza] = useState<string | null>(null)
  const [selMarcador, setSelMarcador] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)
  /** Resultado de "comprobar motor". Aparte de la medicion en vivo porque
   *  voxelizar la camara tarda segundos: en cada tecla congelaria la vista. */
  const [motor, setMotor] = useState<AssembledEngine | null>(null)
  const [comprobando, setComprobando] = useState(false)
  const [arranque, setArranque] = useState<{ rpm: number; supuestos: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  const parts = project.parts
  const pieza = parts.find((p) => p.id === selPieza) ?? null

  const setParts = useCallback(
    (ps: ProjectPart[]) => onChange({ ...project, parts: ps }),
    [project, onChange]
  )

  const importar = async (): Promise<void> => {
    setError(null)
    const file = await window.motorforge.pickCadFile()
    if (!file) return
    setCargando(true)
    try {
      const parsed = await parseCadFile(file.name, file.data)
      // El CAD casi siempre viene en MILÍMETROS y el núcleo trabaja en metros.
      // Se convierte al importar: si se dejara para después, cada medida
      // posterior tendría que acordarse de la escala y alguna se olvidaría.
      const pos = new Float32Array(parsed.positions.length)
      for (let i = 0; i < pos.length; i++) pos[i] = parsed.positions[i]! * 0.001
      const id = nextId(parts, 'decor')
      setMallas((m) => new Map(m).set(id, pos))
      setParts([...parts, {
        id, name: file.name, role: 'decor',
        position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, markers: []
      }])
      setSelPieza(id)
    } catch (e) {
      setError(`No pude leer "${file.name}": ${(e as Error).message}`)
    } finally {
      setCargando(false)
    }
  }

  const clonar = (veces: number): void => {
    if (!pieza) return
    const malla = mallas.get(pieza.id)
    // Paso por defecto: el ancho de la propia pieza en X. Es lo que hace que
    // "clonar 3" coloque cuatro cilindros en fila sin tener que medir nada.
    const paso: Vec3 = [0.094, 0, 0]
    const nuevos = veces === 1
      ? [clonePart(parts, pieza.id, paso)!].filter(Boolean)
      : cloneSeries(parts, pieza.id, paso, veces)
    if (malla) setMallas((m) => {
      const n = new Map(m)
      for (const c of nuevos) n.set(c.id, malla)
      return n
    })
    setParts([...parts, ...nuevos])
  }

  const ponerMarcador = (markerId: string): void => {
    if (!pieza) return
    const malla = mallas.get(pieza.id)
    const c = malla ? bboxCentro(malla) : [0, 0, 0] as Vec3
    const pos: Vec3 = [
      c[0] + pieza.position[0], c[1] + pieza.position[1], c[2] + pieza.position[2]
    ]
    const sinRepetir = pieza.markers.filter((m) => m.id !== markerId)
    setParts(parts.map((p) => p.id === pieza.id
      ? { ...p, markers: [...sinRepetir, { id: markerId, position: pos }] }
      : p))
    setSelMarcador(markerId)
  }

  const moverSeleccion = (d: Vec3): void => {
    if (!pieza) return
    if (selMarcador) {
      setParts(parts.map((p) => p.id === pieza.id
        ? {
            ...p,
            markers: p.markers.map((m) => m.id === selMarcador
              ? { ...m, position: [m.position[0] + d[0], m.position[1] + d[1], m.position[2] + d[2]] as Vec3 }
              : m)
          }
        : p))
    } else {
      setParts(movePart(parts, pieza.id, d))
    }
  }

  // Medición en vivo: cada cambio recalcula qué se puede sacar ya del montaje.
  const medicion = useMemo(() => {
    const conMalla = new Map<string, { positions: Float32Array }>()
    for (const [id, pos] of mallas) conMalla.set(id, { positions: pos })
    return measureEngine(toScene(project, conMalla))
  }, [project, mallas])

  const objetivoGizmo: Vec3 | null = pieza
    ? (selMarcador
        ? pieza.markers.find((m) => m.id === selMarcador)?.position ?? null
        : pieza.position)
    : null

  return (
    <div className="asm">
      <div className="asm-piezas">
        <div className="field">
          <label>Proyecto</label>
          <input
            type="text" value={project.name}
            onChange={(e) => onChange({ ...project, name: e.target.value })}
          />
        </div>
        <button
          className="btn"
          onClick={() => void (async () => {
            // Se guarda la RECETA (rutas, posiciones, roles, marcadores), no las
            // mallas: ver la cabecera de @sim/assemble/project.
            const guardado = await window.motorforge.saveProject(
              serializeProject(project), project.name || 'montaje'
            )
            if (guardado) setAviso(`Guardado como ${guardado}`)
          })()}
        >
          Guardar proyecto…
        </button>
        {aviso && <div className="status-chip good">{aviso}</div>}

        <div className="section-title">Piezas</div>
        <button className="btn" onClick={() => void importar()} disabled={cargando}>
          {cargando ? 'Leyendo…' : 'Importar modelo 3D…'}
        </button>
        {error && <div className="status-chip critical">{error}</div>}
        {parts.length === 0 && (
          <p className="empty-note">
            Aún no hay nada. Importa tus modelos (STEP, IGES o STL) y ve diciendo qué es cada uno.
          </p>
        )}
        <div className="asm-lista">
          {parts.map((p) => (
            <div
              key={p.id}
              className={p.id === selPieza ? 'asm-item sel' : 'asm-item'}
              onClick={() => { setSelPieza(p.id); setSelMarcador(null) }}
            >
              <div className="asm-item-cab">
                <span className="asm-punto" style={{ background: COLOR[p.role] }} />
                <span className="asm-nombre">{p.name}</span>
                {p.markers.length > 0 && <span className="ref-chip">{p.markers.length}</span>}
              </div>
              <select
                value={p.role}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setParts(parts.map((q) => q.id === p.id
                  ? { ...q, role: e.target.value as PartRole } : q))}
              >
                {ROLES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="asm-vista">
        <Canvas camera={{ position: [0.6, 0.4, 0.6], fov: 45 }} onPointerMissed={() => setSelPieza(null)}>
          <color attach="background" args={['#0b0d11']} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[1, 2, 1]} intensity={1.6} />
          <Grid args={[2, 2]} cellSize={0.05} sectionSize={0.25} infiniteGrid fadeDistance={4} sectionColor="#2b303a" cellColor="#1a1e25" />
          {parts.map((p) => {
            const m = mallas.get(p.id)
            return m
              ? <PiezaMesh key={p.id} part={p} positions={m} seleccionada={p.id === selPieza}
                  onClick={() => { setSelPieza(p.id); setSelMarcador(null) }} />
              : null
          })}
          {parts.flatMap((p) => p.markers.map((mk) => (
            <mesh
              key={`${p.id}:${mk.id}`}
              position={mk.position as unknown as [number, number, number]}
              onClick={(e) => { e.stopPropagation(); setSelPieza(p.id); setSelMarcador(mk.id) }}
            >
              <sphereGeometry args={[0.006, 16, 16]} />
              <meshBasicMaterial color={selMarcador === mk.id && selPieza === p.id ? '#ffffff' : '#e10600'} />
            </mesh>
          )))}
          {objetivoGizmo && <Gizmo target={objetivoGizmo} onMove={moverSeleccion} />}
          <OrbitControls makeDefault enableDamping={false} />
        </Canvas>
      </div>

      <div className="asm-panel">
        {!pieza ? (
          <p className="empty-note">Elige una pieza para marcarla.</p>
        ) : (
          <>
            <div className="section-title">{pieza.name}</div>

            <div className="field">
              <label>Cilindro</label>
              <input
                type="number" min={1} max={16}
                value={pieza.cylinder === undefined ? '' : pieza.cylinder + 1}
                placeholder="—"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setParts(parts.map((q) => q.id === pieza.id
                    ? { ...q, cylinder: Number.isFinite(v) && v >= 1 ? v - 1 : undefined } : q))
                }}
              />
            </div>

            <div className="field">
              <label>Pegada a</label>
              <select
                value={pieza.gluedTo ?? ''}
                onChange={(e) => setParts(glue(parts, pieza.id, e.target.value || null))}
              >
                <option value="">— suelta —</option>
                {parts.filter((q) => q.id !== pieza.id).map((q) => (
                  <option key={q.id} value={q.id}>{q.name}</option>
                ))}
              </select>
            </div>

            <div className="asm-botones">
              <button className="btn" onClick={() => clonar(1)}>Clonar</button>
              <button className="btn" onClick={() => clonar(3)}>Clonar ×3 en fila</button>
              <button
                className="btn"
                onClick={() => setParts(copyConfig(
                  parts, pieza.id, parts.filter((q) => q.role === pieza.role && q.id !== pieza.id).map((q) => q.id)
                ))}
              >
                Copiar config. a las demás {ROLES.find(([r]) => r === pieza.role)?.[1].toLowerCase()}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setParts(parts.filter((q) => q.id !== pieza.id))
                  setSelPieza(null)
                }}
              >
                Quitar
              </button>
            </div>

            <div className="section-title">Marcadores</div>
            {(MARCADORES[pieza.role] ?? []).length === 0 ? (
              <p className="empty-note">Este rol no necesita marcadores.</p>
            ) : (
              <div className="asm-marcadores">
                {(MARCADORES[pieza.role] ?? []).map(([id, texto]) => {
                  const puesto = pieza.markers.some((m) => m.id === id)
                  return (
                    <button
                      key={id}
                      className={puesto ? 'seg-btn active' : 'seg-btn'}
                      onClick={() => (puesto ? setSelMarcador(id) : ponerMarcador(id))}
                    >
                      {puesto ? '● ' : '○ '}{texto}
                    </button>
                  )
                })}
              </div>
            )}
            {selMarcador && (
              <p className="empty-note">
                Arrastra el marcador con las flechas hasta su sitio exacto.
              </p>
            )}
          </>
        )}

        <div className="section-title">Lo que se puede medir ya</div>
        <div className="asm-medicion">
          {medicion.mediciones.map((m) => (
            <div key={m.campo} className="asm-med">
              <span>{m.campo}</span>
              <strong>{m.unidad === 'm' ? `${(m.valor * 1000).toFixed(2)} mm` : `${m.valor.toFixed(3)} ${m.unidad}`}</strong>
            </div>
          ))}
          {medicion.fallos.map((f) => (
            <div key={f.campo} className="asm-falta">
              <strong>{f.campo}</strong>
              <span>{f.motivo}</span>
              <em>{f.arregla}</em>
            </div>
          ))}
          {medicion.avisos.map((a, i) => <div key={i} className="empty-note">{a}</div>)}
        </div>

        <div className="section-title">Motor</div>
        <button
          className="btn"
          disabled={comprobando}
          onClick={() => {
            setComprobando(true)
            // Cede un frame para que el boton se pinte como "midiendo" antes
            // de bloquear el hilo con la voxelizacion.
            setTimeout(() => {
              const conMalla = new Map<string, { positions: Float32Array }>()
              for (const [id, pos] of mallas) conMalla.set(id, { positions: pos })
              setMotor(assembleEngine(toScene(project, conMalla)))
              setComprobando(false)
            }, 30)
          }}
        >
          {comprobando ? 'Midiendo la camara...' : 'Comprobar motor'}
        </button>
        {motor && (
          <div className="asm-medicion">
            <div className="asm-med">
              <span>cilindrada</span>
              <strong>{(motor.geometry.displacement * 1e6).toFixed(0)} cc</strong>
            </div>
            <div className="asm-med">
              <span>camara</span>
              <strong>
                {Number.isFinite(motor.chamberVolume)
                  ? `${(motor.chamberVolume * 1e6).toFixed(1)} cc`
                  : 'sin medir'}
              </strong>
            </div>
            <div className="asm-med">
              <span>compresion</span>
              <strong>
                {Number.isFinite(motor.geometry.compressionRatio)
                  ? `${motor.geometry.compressionRatio.toFixed(2)}:1`
                  : '—'}
              </strong>
            </div>
            <div className={motor.listo ? 'status-chip good' : 'status-chip critical'}>
              {motor.listo ? 'Listo para arrancar' : `${motor.problemas.length} cosa(s) por resolver`}
            </div>
            {motor.problemas.map((p, i) => (
              <div key={i} className="asm-falta"><span>{p}</span></div>
            ))}
          </div>
        )}

        {motor?.listo && (
          <>
            {onAlBanco && (
              <button
                className="btn"
                onClick={() => {
                  const { assembly } = toAssembly(motor)
                  onAlBanco(
                    [assembly.block, assembly.crank, assembly.rod, assembly.piston, assembly.head],
                    project.name
                  )
                }}
              >
                Llevar al banco de potencia
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                const g95 = FUELS.gasolina95!
                const r = toRunnable(motor, { stoichAFR: g95.stoichAFR, lhv: g95.lhv })
                const loop = new SimLoop(r.core, defaultHarness(9), r.calib)
                loop.physical.ignitionKey = true
                // 4 segundos de simulacion: lo justo para que arranque y se
                // estabilice. Corre en el hilo de UI porque son ~1000 ticks.
                for (let t = 0; t < Math.round(4 / TICK_DT); t++) {
                  loop.physical.throttle = 0.4
                  loop.tick(TICK_DT)
                }
                setArranque({ rpm: loop.core.rpm, supuestos: r.supuestos })
              }}
            >
              Arrancar
            </button>
            {arranque && (
              <div className="asm-medicion">
                <div className="asm-med">
                  <span>regimen tras 4 s</span>
                  <strong>{arranque.rpm.toFixed(0)} rpm</strong>
                </div>
                {/* Lo estimado se marca SIEMPRE: un motor que arranca con
                    supuestos ocultos es justo la trampa que evita este proyecto. */}
                {arranque.supuestos.map((x, i) => (
                  <div key={i} className="asm-falta"><em>Estimado: {x}</em></div>
                ))}
              </div>
            )}
          </>
        )}

        <button className="btn" onClick={onSalir}>Volver</button>
      </div>
    </div>
  )
}

/** Pantalla de entrada: nuevo o abrir. */
export function ProjectGate({
  onNuevo, onAbrir
}: { onNuevo: (p: AssemblyProject) => void; onAbrir: (p: AssemblyProject) => void }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  return (
    <div className="gate">
      <div className="gate-caja">
        <h1>MotorForge</h1>
        <p className="sub">
          Trae tus modelos, di qué es cada pieza y simula el motor que salga. Aunque no exista.
        </p>
        <div className="gate-botones">
          <button className="btn" onClick={() => onNuevo(newProject())}>Nuevo proyecto</button>
          <button
            className="btn"
            onClick={() => void (async () => {
              setError(null)
              const f = await window.motorforge.openProject()
              if (!f) return
              const r = parseProject(f.json)
              if ('error' in r) setError(r.error)
              else onAbrir(r.project)
            })()}
          >
            Abrir proyecto…
          </button>
        </div>
        {error && <div className="status-chip critical">{error}</div>}
      </div>
    </div>
  )
}

export { serializeProject }
