import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { MATERIALS, materialById } from '@sim/materials'
import {
  buildImportedInjector,
  buildImportedPiston,
  buildImportedRod,
  deriveInjectorLimits,
  derivePistonLimits,
  deriveRodLimits,
  proposeParams
} from '@sim/import/derive'
import type { ImportKind, InjectorParams, PistonParams, RodParams } from '@sim/import/derive'
import { refinePistonLimitsWithFea, refineRodLimitsWithFea } from '@sim/import/fea'
import type { FeaCase, FeaSummary } from '@sim/import/fea'
import type { DerivedLimit, LimitVariable, Part } from '@sim/types'
import { parseCadFile, runFea } from '../lib/geometryClient'
import type { ParsedCad } from '../lib/geometryClient'

/** Densidad de la gasolina para convertir cc/min ↔ kg/s en la UI. */
const FUEL_DENSITY = 745

const KIND_LABELS: Record<ImportKind, string> = {
  rod: 'Biela',
  piston: 'Pistón',
  injector: 'Inyector'
}

const DEFAULT_MATERIAL: Record<ImportKind, string> = {
  rod: 'steel-4340',
  piston: 'alu-2618',
  injector: 'steel-17-4ph'
}

interface FieldDef {
  key: string
  label: string
  unit: string
  step: number
  decimals: number
}

const FIELD_DEFS: Record<ImportKind, FieldDef[]> = {
  rod: [{ key: 'centerDistance', label: 'Distancia entre centros', unit: 'mm', step: 0.5, decimals: 1 }],
  piston: [
    { key: 'bore', label: 'Diámetro nominal', unit: 'mm', step: 0.5, decimals: 1 },
    { key: 'compressionHeight', label: 'Altura de compresión', unit: 'mm', step: 0.5, decimals: 1 }
  ],
  injector: [
    { key: 'channelDiameter', label: 'Ø conducto interno', unit: 'mm', step: 0.1, decimals: 1 },
    { key: 'staticFlow', label: 'Caudal estático', unit: 'cc/min', step: 10, decimals: 0 }
  ]
}

/** Params SI → campos de formulario en unidades de taller. */
function toFields(kind: ImportKind, p: RodParams | PistonParams | InjectorParams): Record<string, number> {
  switch (kind) {
    case 'rod': {
      const rp = p as RodParams
      return { centerDistance: rp.centerDistance * 1000 }
    }
    case 'piston': {
      const pp = p as PistonParams
      return { bore: pp.bore * 1000, compressionHeight: pp.compressionHeight * 1000 }
    }
    case 'injector': {
      const ip = p as InjectorParams
      return {
        channelDiameter: ip.channelDiameter * 1000,
        staticFlow: (ip.staticFlow / FUEL_DENSITY) * 6e7
      }
    }
  }
}

/** Campos de formulario → params SI. */
function toParams(kind: ImportKind, f: Record<string, number>): RodParams | PistonParams | InjectorParams {
  switch (kind) {
    case 'rod':
      return { centerDistance: (f['centerDistance'] ?? 0) / 1000 }
    case 'piston':
      return { bore: (f['bore'] ?? 0) / 1000, compressionHeight: (f['compressionHeight'] ?? 0) / 1000 }
    case 'injector':
      return {
        channelDiameter: (f['channelDiameter'] ?? 0) / 1000,
        staticFlow: ((f['staticFlow'] ?? 0) / 6e7) * FUEL_DENSITY
      }
  }
}

const LIMIT_LABELS: Record<LimitVariable, string> = {
  peakCylinderPressure: 'Presión pico admisible',
  rodCompression: 'Compresión máxima',
  rodTension: 'Tracción máxima',
  crownTemp: 'Temperatura de corona',
  exhaustTemp: 'Temperatura de escape',
  rpm: 'Régimen máximo',
  boost: 'Boost máximo',
  injectorDuty: 'Duty máximo',
  railPressure: 'Presión de raíl máxima',
  knockIndex: 'Tolerancia a picado'
}

function formatLimit(l: DerivedLimit): string {
  switch (l.variable) {
    case 'peakCylinderPressure':
    case 'railPressure':
    case 'boost':
      return `${(l.value / 1e5).toFixed(0)} bar`
    case 'rodCompression':
    case 'rodTension':
      return `${(l.value / 1e3).toFixed(0)} kN`
    case 'crownTemp':
    case 'exhaustTemp':
      return `${(l.value - 273.15).toFixed(0)} °C`
    case 'rpm':
      return `${l.value.toFixed(0)} rpm`
    case 'injectorDuty':
      return `${(l.value * 100).toFixed(0)} %`
    case 'knockIndex':
      return `índice ${l.value.toFixed(2)}`
  }
}

function MeshPreview({ positions }: { positions: Float32Array }): React.JSX.Element {
  const { geo, scale } = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.computeVertexNormals()
    g.center()
    g.computeBoundingSphere()
    const r = g.boundingSphere?.radius ?? 1
    return { geo: g, scale: 1.6 / Math.max(r, 1e-9) }
  }, [positions])

  useEffect(() => () => geo.dispose(), [geo])

  return (
    <Canvas camera={{ position: [2.4, 1.7, 2.4], fov: 38 }} dpr={[1, 2]}>
      <hemisphereLight args={['#cfd8e6', '#252a34', 1.2]} />
      <directionalLight position={[3, 4, 2]} intensity={1.5} />
      <directionalLight position={[-3, -1, -2]} intensity={0.4} />
      <mesh geometry={geo} scale={scale}>
        <meshStandardMaterial color="#9db1c9" metalness={0.4} roughness={0.42} flatShading side={THREE.DoubleSide} />
      </mesh>
      <OrbitControls enablePan={false} autoRotate autoRotateSpeed={1.4} />
    </Canvas>
  )
}

export interface ImportDialogProps {
  file: { name: string; data: ArrayBuffer }
  onCancel: () => void
  onSave: (part: Part) => void
}

export default function ImportDialog({ file, onCancel, onSave }: ImportDialogProps): React.JSX.Element {
  const [parsed, setParsed] = useState<ParsedCad | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [kind, setKind] = useState<ImportKind>('rod')
  const [materialId, setMaterialId] = useState(DEFAULT_MATERIAL.rod)
  const [partName, setPartName] = useState(file.name.replace(/\.[^.]+$/, ''))
  const [fields, setFields] = useState<Record<string, number>>({})
  // El resultado FEA solo depende de la geometría y del caso de carga
  // (E se cancela y ν es fijo), así que se cachea por caso.
  const [fea, setFea] = useState<Partial<Record<FeaCase, FeaSummary>>>({})
  const [feaBusy, setFeaBusy] = useState(false)
  const [feaError, setFeaError] = useState<string | null>(null)

  const feaCase: FeaCase | null = kind === 'rod' ? 'rod-axial' : kind === 'piston' ? 'piston-crown' : null
  const feaSummary = feaCase ? (fea[feaCase] ?? null) : null

  useEffect(() => {
    let cancelled = false
    parseCadFile(file.name, file.data)
      .then((r) => {
        if (cancelled) return
        setParsed(r)
        setFields(toFields('rod', proposeParams('rod', r.metrics)))
      })
      .catch((e: Error) => {
        if (!cancelled) setParseError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [file])

  const changeKind = (k: ImportKind): void => {
    setKind(k)
    setMaterialId(DEFAULT_MATERIAL[k])
    if (parsed) setFields(toFields(k, proposeParams(k, parsed.metrics)))
  }

  const material = materialById(materialId)

  const limits: DerivedLimit[] | null = useMemo(() => {
    if (!parsed) return null
    const input = { name: partName, metrics: parsed.metrics, material }
    try {
      switch (kind) {
        case 'rod': {
          const params = toParams('rod', fields) as RodParams
          const analytic = deriveRodLimits(input, params)
          return feaSummary ? refineRodLimitsWithFea(analytic, input, params, feaSummary) : analytic
        }
        case 'piston': {
          const params = toParams('piston', fields) as PistonParams
          const analytic = derivePistonLimits(input, params)
          return feaSummary ? refinePistonLimitsWithFea(analytic, input, params, feaSummary) : analytic
        }
        case 'injector':
          return deriveInjectorLimits(input, toParams('injector', fields) as InjectorParams)
      }
    } catch {
      return null
    }
  }, [parsed, kind, material, fields, partName, feaSummary])

  const launchFea = (): void => {
    if (!parsed || !feaCase || feaBusy) return
    setFeaBusy(true)
    setFeaError(null)
    runFea(parsed.positions, feaCase)
      .then((summary) => setFea((f) => ({ ...f, [feaCase]: summary })))
      .catch((e: Error) => setFeaError(e.message))
      .finally(() => setFeaBusy(false))
  }

  const save = (): void => {
    if (!parsed || limits === null) return
    const input = { name: partName || 'Pieza importada', metrics: parsed.metrics, material }
    const part: Part =
      kind === 'rod'
        ? buildImportedRod(input, toParams('rod', fields) as RodParams)
        : kind === 'piston'
          ? buildImportedPiston(input, toParams('piston', fields) as PistonParams)
          : buildImportedInjector(input, toParams('injector', fields) as InjectorParams)
    // los límites mostrados (posiblemente refinados con FEA) son los que se guardan
    onSave({ ...part, limits })
  }

  const m = parsed?.metrics
  const categories = [...new Set(MATERIALS.map((mat) => mat.category))]

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Importar pieza CAD">
      <div className="modal">
        <header className="modal-head">
          <h2>Importar pieza</h2>
          <span className="modal-file">{file.name}</span>
        </header>

        {parseError && (
          <div className="modal-body">
            <div className="issue error">
              <span>✕</span>
              <span>{parseError}</span>
            </div>
          </div>
        )}

        {!parsed && !parseError && (
          <div className="modal-body">
            <p className="empty-note">Teselando y midiendo la geometría…</p>
          </div>
        )}

        {parsed && m && (
          <div className="modal-body modal-grid">
            <div className="modal-left">
              <div className="preview-wrap">
                <MeshPreview positions={parsed.positions} />
              </div>
              <dl className="metrics-list">
                <dt>Triángulos</dt>
                <dd>{parsed.triangleCount.toLocaleString('es-ES')}</dd>
                <dt>Volumen</dt>
                <dd>{(m.volume * 1e6).toFixed(1)} cm³</dd>
                <dt>Masa ({material.name.split(' ')[0]})</dt>
                <dd>{(m.volume * material.density * 1000).toFixed(0)} g</dd>
                <dt>Caja envolvente</dt>
                <dd>
                  {(m.bbox.x * 1000).toFixed(0)} × {(m.bbox.y * 1000).toFixed(0)} ×{' '}
                  {(m.bbox.z * 1000).toFixed(0)} mm
                </dd>
                <dt>Pared mínima</dt>
                <dd>{(m.minWallThickness * 1000).toFixed(1)} mm</dd>
                <dt>Sección mínima</dt>
                <dd>{(m.minSectionArea * 1e6).toFixed(0)} mm²</dd>
              </dl>
            </div>

            <div className="modal-right">
              <div className="field">
                <label htmlFor="imp-name">Nombre</label>
                <input
                  id="imp-name"
                  type="text"
                  value={partName}
                  onChange={(e) => setPartName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="imp-kind">Tipo de pieza</label>
                <select id="imp-kind" value={kind} onChange={(e) => changeKind(e.target.value as ImportKind)}>
                  {(Object.keys(KIND_LABELS) as ImportKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="imp-material">Material</label>
                <select id="imp-material" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
                  {categories.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {MATERIALS.filter((mat) => mat.category === cat).map((mat) => (
                        <option key={mat.id} value={mat.id}>
                          {mat.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              {FIELD_DEFS[kind].map((fd) => (
                <div className="field" key={fd.key}>
                  <label htmlFor={`imp-${fd.key}`}>
                    {fd.label} ({fd.unit})
                  </label>
                  <input
                    id={`imp-${fd.key}`}
                    type="number"
                    step={fd.step}
                    value={Number((fields[fd.key] ?? 0).toFixed(fd.decimals))}
                    onChange={(e) => setFields((f) => ({ ...f, [fd.key]: Number(e.target.value) }))}
                  />
                </div>
              ))}

              <h3 className="section-title">Límites derivados</h3>
              {feaCase && (
                <div className="fea-row">
                  {feaSummary ? (
                    <span className="fea-badge">
                      ✓ FEA {feaSummary.grid.join('×')} · {feaSummary.elements.toLocaleString('es-ES')} elementos
                    </span>
                  ) : (
                    <button className="btn" onClick={launchFea} disabled={feaBusy || !parsed}>
                      {feaBusy ? 'Calculando FEA…' : 'Refinar con FEA (nivel B)'}
                    </button>
                  )}
                  {feaError && <span className="fea-error">✕ {feaError}</span>}
                </div>
              )}
              {limits === null && <p className="empty-note">Parámetros no válidos.</p>}
              {limits?.map((l) => (
                <div className="limit-card" key={l.variable}>
                  <div className="limit-head">
                    <span className="limit-name">{LIMIT_LABELS[l.variable]}</span>
                    <span className="limit-value">{formatLimit(l)}</span>
                  </div>
                  <div className="limit-explanation">{l.explanation}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <footer className="modal-foot">
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save} disabled={!parsed || limits === null}>
            Guardar pieza
          </button>
        </footer>
      </div>
    </div>
  )
}
