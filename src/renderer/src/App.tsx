import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ASPIRATIONS,
  BLOCKS,
  COOLING,
  CRANKS,
  FUELS,
  FUEL_PUMPS,
  HEADS,
  INJECTORS,
  PISTONS,
  RODS,
  computeUtilization,
  defaultTune,
  partById,
  resolveEngine,
  runDyno
} from '@sim/index'
import type { OverlayCategory, WearState } from '@sim/index'
import { freshWear } from '@sim/index'
import type {
  AspirationPart,
  DynoResult,
  EngineAssembly,
  Part,
  Tune
} from '@sim/types'
import DynoChart from './components/DynoChart'
import Engine3D from './components/Engine3D'
import EndurancePanel from './components/EndurancePanel'
import EventCard from './components/EventCard'
import ImportDialog from './components/ImportDialog'
import MapEditor from './components/MapEditor'
import TransientPanel from './components/TransientPanel'

const PhysicsLab = lazy(() => import('./physics/PhysicsLab'))

const CV = 735.5

interface Selection {
  block: string
  crank: string
  rod: string
  piston: string
  head: string
  injector: string
  fuelPump: string
  aspiration: string
  cooling: string
}

const CATALOG_SLOTS: Array<{ key: keyof Selection; label: string; options: Part[] }> = [
  { key: 'block', label: 'Bloque', options: BLOCKS },
  { key: 'crank', label: 'Cigüeñal', options: CRANKS },
  { key: 'rod', label: 'Bielas', options: RODS },
  { key: 'piston', label: 'Pistones', options: PISTONS },
  { key: 'head', label: 'Culata', options: HEADS },
  { key: 'injector', label: 'Inyectores', options: INJECTORS },
  { key: 'fuelPump', label: 'Bomba de combustible', options: FUEL_PUMPS },
  { key: 'aspiration', label: 'Admisión', options: ASPIRATIONS },
  { key: 'cooling', label: 'Refrigeración y aceite', options: COOLING }
]

const DEFAULT_SELECTION: Selection = {
  block: 'block-alu-2.0',
  crank: 'crank-cast-86',
  rod: 'rod-stock-139',
  piston: 'piston-cast-86',
  head: 'head-sport-42',
  injector: 'inj-310',
  fuelPump: 'pump-stock-110',
  aspiration: 'asp-na',
  cooling: 'cool-stock'
}

/** Fichero de proyecto / sesión: todo lo que define el estado del taller. */
interface ProjectData {
  version: 1
  name?: string
  selection: Selection
  tune: Tune
  fuelId: string
  wear: WearState
  imported: Part[]
}

export default function App(): React.JSX.Element {
  const [sel, setSel] = useState<Selection>(DEFAULT_SELECTION)
  const [tune, setTune] = useState<Tune>(() => defaultTune())
  const [fuelId, setFuelId] = useState('gasolina95')
  const [hoverRpm, setHoverRpm] = useState<number | null>(null)
  const fuel = FUELS[fuelId] ?? FUELS.gasolina95!
  const [imported, setImported] = useState<Part[]>([])
  const [importFile, setImportFile] = useState<{ name: string; data: ArrayBuffer } | null>(null)
  /** Desgaste acumulado del motor montado: sobrevive entre tandas y sesiones. */
  const [wear, setWear] = useState<WearState>(() => freshWear())
  const [projectName, setProjectName] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  /** Vista activa: banco (dyno/tandas) o laboratorio físico (Rapier). */
  const [view, setView] = useState<'banco' | 'fisica'>('banco')

  /** Aplica un proyecto/sesión validando que cada id de pieza exista. */
  const applyProject = useCallback((data: ProjectData, parts: Part[]): void => {
    const known = (id: string): boolean =>
      parts.some((p) => p.id === id) || CATALOG_SLOTS.some((s) => s.options.some((p) => p.id === id))
    const selection = { ...DEFAULT_SELECTION }
    for (const key of Object.keys(selection) as Array<keyof Selection>) {
      const id = data.selection?.[key]
      if (typeof id === 'string' && known(id)) selection[key] = id
    }
    setSel(selection)
    if (data.tune?.fuelMap && data.tune?.sparkMap) setTune(data.tune)
    if (typeof data.fuelId === 'string' && FUELS[data.fuelId]) setFuelId(data.fuelId)
    setWear(data.wear ? { ...freshWear(), ...data.wear } : freshWear())
  }, [])

  useEffect(() => {
    void (async () => {
      let parts: Part[] = []
      try {
        const json = await window.motorforge.loadImportedParts()
        const parsed: unknown = json ? JSON.parse(json) : null
        if (Array.isArray(parsed)) parts = parsed as Part[]
      } catch {
        /* fichero corrupto: se ignora y se parte de cero */
      }
      setImported(parts)
      try {
        const session = await window.motorforge.loadSession()
        if (session) applyProject(JSON.parse(session) as ProjectData, parts)
      } catch {
        /* sesión corrupta: se parte del motor por defecto */
      }
      setRestored(true)
    })()
  }, [applyProject])

  // Autosave de sesión: el taller queda como lo dejaste
  useEffect(() => {
    if (!restored) return
    const data: ProjectData = { version: 1, selection: sel, tune, fuelId, wear, imported }
    const t = setTimeout(() => void window.motorforge.saveSession(JSON.stringify(data)), 600)
    return () => clearTimeout(t)
  }, [restored, sel, tune, fuelId, wear, imported])

  const saveProjectAs = async (): Promise<void> => {
    const data: ProjectData = {
      version: 1,
      name: projectName ?? undefined,
      selection: sel,
      tune,
      fuelId,
      wear,
      imported
    }
    const saved = await window.motorforge.saveProject(
      JSON.stringify(data, null, 2),
      projectName ?? 'motor'
    )
    if (saved) setProjectName(saved.replace(/\.mforge\.json$|\.json$/i, ''))
  }

  const openProjectFile = async (): Promise<void> => {
    const file = await window.motorforge.openProject()
    if (!file) return
    try {
      const data = JSON.parse(file.json) as ProjectData
      const parts = Array.isArray(data.imported) ? data.imported : []
      const merged = [...imported]
      for (const p of parts) if (!merged.some((m) => m.id === p.id)) merged.push(p)
      if (merged.length !== imported.length) {
        setImported(merged)
        void window.motorforge.saveImportedParts(JSON.stringify(merged))
      }
      applyProject(data, merged)
      setProjectName(file.name.replace(/\.mforge\.json$|\.json$/i, ''))
    } catch {
      window.alert('El fichero no es un proyecto MotorForge válido.')
    }
  }

  const findPart = useCallback(
    <T extends Part>(id: string): T => {
      const imp = imported.find((p) => p.id === id)
      return (imp as T | undefined) ?? partById<T>(id)
    },
    [imported]
  )

  const slots = useMemo(
    () =>
      CATALOG_SLOTS.map((s) => ({
        ...s,
        options: [...s.options, ...imported.filter((p) => p.kind === s.key)]
      })),
    [imported]
  )

  const engine = useMemo(() => {
    const assembly: EngineAssembly = {
      block: findPart(sel.block),
      crank: findPart(sel.crank),
      rod: findPart(sel.rod),
      piston: findPart(sel.piston),
      head: findPart(sel.head),
      injector: findPart(sel.injector),
      fuelPump: findPart(sel.fuelPump),
      aspiration: findPart(sel.aspiration),
      cooling: findPart(sel.cooling)
    }
    return resolveEngine(assembly)
  }, [sel, findPart])

  const hasErrors = engine.issues.some((i) => i.severity === 'error')
  const isTurbo = engine.assembly.aspiration.spec.type === 'turbo'

  const dyno: DynoResult | null = useMemo(() => {
    if (hasErrors) return null
    return runDyno(engine, tune, fuel)
  }, [engine, tune, fuel, hasErrors])

  /** Comparador A/B: snapshot de las curvas actuales como referencia discontinua. */
  const [reference, setReference] = useState<{
    label: string
    peakPower: number
    power: Array<{ rpm: number; value: number }>
    torque: Array<{ rpm: number; value: number }>
  } | null>(null)

  const pinReference = (): void => {
    if (!dyno) return
    setReference({
      label: `${(dyno.peakPower.power / CV).toFixed(0)} CV · ${fuel.name}${isTurbo ? ` · ${(tune.boostTarget / 1e5).toFixed(1)} bar` : ''}`,
      peakPower: dyno.peakPower.power,
      power: dyno.points.map((p) => ({ rpm: p.rpm, value: p.power / CV })),
      torque: dyno.points.map((p) => ({ rpm: p.rpm, value: p.torque }))
    })
  }

  const exportCsv = async (): Promise<void> => {
    if (!dyno) return
    const header = 'rpm,potencia_cv,par_nm,boost_bar,lambda_real,avance_deg,rail_bar,picado,corona_c,escape_c'
    const rows = dyno.points.map((p) =>
      [
        p.rpm,
        (p.power / CV).toFixed(1),
        p.torque.toFixed(1),
        (p.boost / 1e5).toFixed(2),
        p.lambdaActual.toFixed(3),
        p.sparkAdvance.toFixed(1),
        (p.railPressure / 1e5).toFixed(2),
        p.knockIndex.toFixed(3),
        (p.crownTemp - 273.15).toFixed(0),
        (p.exhaustTemp - 273.15).toFixed(0)
      ].join(',')
    )
    await window.motorforge.exportText('dyno-motorforge.csv', [header, ...rows].join('\n'))
  }

  const [overlayMode, setOverlayMode] = useState<'normal' | OverlayCategory>('normal')
  const overlay = useMemo(
    () =>
      dyno && overlayMode !== 'normal' ? computeUtilization(engine, dyno.points, overlayMode) : null,
    [dyno, engine, overlayMode]
  )

  const selectPart = (key: keyof Selection, id: string): void => {
    setSel((s) => ({ ...s, [key]: id }))
    if (key === 'aspiration') {
      const asp = findPart<AspirationPart>(id)
      setTune((t) => ({ ...t, boostTarget: asp.spec.defaultBoost }))
    }
  }

  const startImport = async (): Promise<void> => {
    const file = await window.motorforge.pickCadFile()
    if (file) setImportFile(file)
  }

  const saveImported = (part: Part): void => {
    const next = [...imported, part]
    setImported(next)
    setSel((s) => ({ ...s, [part.kind]: part.id }))
    setImportFile(null)
    void window.motorforge.saveImportedParts(JSON.stringify(next))
  }

  const g = engine.geometry
  const failure = dyno?.events.find((e) => e.severity === 'failure') ?? null
  const failedKind =
    failure === null
      ? null
      : (Object.values(engine.assembly).find((p) => p.id === failure.partId)?.kind ?? null)

  return (
    <>
      <header className="topbar">
        <h1>MotorForge</h1>
        <span className="sub">
          Simulador estructural y térmico · {projectName ?? 'proyecto sin guardar'}
        </span>
        <div className="topbar-actions">
          <div className="segmented" role="group" aria-label="Vista">
            <button
              type="button"
              className={view === 'banco' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setView('banco')}
            >
              Banco de potencia
            </button>
            <button
              type="button"
              className={view === 'fisica' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setView('fisica')}
            >
              Laboratorio físico
            </button>
          </div>
          <button className="btn" onClick={() => void openProjectFile()}>
            Abrir proyecto…
          </button>
          <button className="btn" onClick={() => void saveProjectAs()}>
            Guardar proyecto…
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section>
            <h2 className="section-title"><em>01</em> Piezas</h2>
            {slots.map(({ key, label, options }) => (
              <div className="field" key={key}>
                <label htmlFor={`sel-${key}`}>{label}</label>
                <select id={`sel-${key}`} value={sel[key]} onChange={(e) => selectPart(key, e.target.value)}>
                  {options.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.source === 'imported' ? `⬆ ${p.name}` : p.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <button className="btn import-btn" onClick={() => void startImport()}>
              Importar pieza CAD… (STEP/IGES/STL)
            </button>
          </section>

          <section>
            <h2 className="section-title"><em>02</em> ECU y combustible</h2>
            <div className="field">
              <label htmlFor="fuel">Combustible</label>
              <select id="fuel" value={fuelId} onChange={(e) => setFuelId(e.target.value)}>
                {Object.entries(FUELS).map(([id, f]) => (
                  <option key={id} value={id}>
                    {f.name} · {f.octane} RON
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="lambdatrim">Trim global de λ (sobre el mapa)</label>
              <div className="slider-row">
                <input
                  id="lambdatrim"
                  type="range"
                  min="-0.10"
                  max="0.10"
                  step="0.01"
                  value={tune.lambdaTrim}
                  onChange={(e) => setTune((t) => ({ ...t, lambdaTrim: Number(e.target.value) }))}
                />
                <span className="slider-value">
                  {tune.lambdaTrim > 0 ? '+' : ''}
                  {tune.lambdaTrim.toFixed(2)}
                </span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="revlimit">Corte de inyección</label>
              <div className="slider-row">
                <input
                  id="revlimit"
                  type="range"
                  min="6000"
                  max="11000"
                  step="100"
                  value={tune.revLimit}
                  onChange={(e) => setTune((t) => ({ ...t, revLimit: Number(e.target.value) }))}
                />
                <span className="slider-value">{tune.revLimit} rpm</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="boost">Boost objetivo {isTurbo ? '' : '(requiere turbo)'}</label>
              <div className="slider-row">
                <input
                  id="boost"
                  type="range"
                  min="0"
                  max="250000"
                  step="10000"
                  disabled={!isTurbo}
                  value={tune.boostTarget}
                  onChange={(e) => setTune((t) => ({ ...t, boostTarget: Number(e.target.value) }))}
                />
                <span className="slider-value">{(tune.boostTarget / 1e5).toFixed(1)} bar</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="spark">Corrección de avance</label>
              <div className="slider-row">
                <input
                  id="spark"
                  type="range"
                  min="-10"
                  max="6"
                  step="1"
                  value={tune.sparkTrim}
                  onChange={(e) => setTune((t) => ({ ...t, sparkTrim: Number(e.target.value) }))}
                />
                <span className="slider-value">
                  {tune.sparkTrim > 0 ? '+' : ''}
                  {tune.sparkTrim}°
                </span>
              </div>
            </div>
          </section>

          <section>
            <h2 className="section-title"><em>03</em> Motor resuelto</h2>
            <div className="engine-card">
              <dl>
                <dt>Cilindrada</dt>
                <dd>{(g.displacement * 1e6).toFixed(0)} cc</dd>
                <dt>Diámetro × carrera</dt>
                <dd>
                  {(g.bore * 1000).toFixed(0)} × {(g.stroke * 1000).toFixed(0)} mm
                </dd>
                <dt>Relación de compresión</dt>
                <dd>{g.compressionRatio.toFixed(1)} : 1</dd>
                <dt>Combustible</dt>
                <dd>{fuel.name}</dd>
              </dl>
              {engine.issues.map((issue, i) => (
                <div key={i} className={`issue ${issue.severity}`}>
                  <span>{issue.severity === 'error' ? '✕' : '⚠'}</span>
                  <span>{issue.message}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>

        {view === 'fisica' ? (
          <main className="main main-phys">
            {hasErrors ? (
              <p className="empty-note">
                Corrige los errores de compatibilidad del ensamblaje para entrar al laboratorio físico.
              </p>
            ) : (
              <Suspense fallback={<p className="empty-note">Cargando laboratorio físico (Rapier)…</p>}>
                <PhysicsLab engine={engine} />
              </Suspense>
            )}
          </main>
        ) : (
        <main className="main">
          <div className="stat-row">
            <div className="stat-tile">
              <div className="stat-label">Potencia máxima</div>
              <div className="stat-value">
                {dyno ? (dyno.peakPower.power / CV).toFixed(0) : '—'}
                <span className="unit">CV</span>
              </div>
              <div className="stat-detail">{dyno ? `@ ${dyno.peakPower.rpm} rpm` : 'motor no montable'}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Par máximo</div>
              <div className="stat-value">
                {dyno ? dyno.peakTorque.torque.toFixed(0) : '—'}
                <span className="unit">Nm</span>
              </div>
              <div className="stat-detail">{dyno ? `@ ${dyno.peakTorque.rpm} rpm` : 'motor no montable'}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Estado</div>
              <div className="stat-value">
                {!dyno ? (
                  <span className="status-chip critical">✕ No montable</span>
                ) : dyno.failedAtRpm !== null ? (
                  <span className="status-chip critical">✕ Rompe @ {dyno.failedAtRpm}</span>
                ) : (
                  <span className="status-chip good">✓ Aguanta</span>
                )}
              </div>
              <div className="stat-detail">
                {dyno && dyno.failedAtRpm === null
                  ? `hasta el corte de ${tune.revLimit} rpm`
                  : (failure?.failureMode ?? '')}
              </div>
            </div>
          </div>

          {!hasErrors && (
            <div className="chart-card">
              <div className="chart-card-head">
                <h3>Tren alternativo — geometría real del ensamblaje{failure ? ' · pieza rota en rojo' : ''}</h3>
                <div className="segmented" role="group" aria-label="Overlay de utilización">
                  {(
                    [
                      ['normal', 'Normal'],
                      ['termico', 'Térmico'],
                      ['estructural', 'Estructural']
                    ] as Array<['normal' | OverlayCategory, string]>
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={overlayMode === mode ? 'seg-btn active' : 'seg-btn'}
                      onClick={() => setOverlayMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <Engine3D geometry={g} failedKind={failedKind} overlay={overlay} />
              {overlay !== null && (
                <p className="overlay-note">
                  Color por utilización {overlayMode === 'termico' ? 'térmica' : 'estructural'} máxima en el
                  barrido: azul frío → ámbar al 92% → rojo al límite. Gris: sin límite de esta categoría.
                </p>
              )}
            </div>
          )}

          {dyno && (
            <>
              <div className="dyno-toolbar">
                {reference ? (
                  <>
                    <span className="ref-chip">
                      A/B contra <strong>{reference.label}</strong>
                      <span
                        className={
                          dyno.peakPower.power >= reference.peakPower ? 'ref-delta good' : 'ref-delta bad'
                        }
                      >
                        {dyno.peakPower.power >= reference.peakPower ? '+' : ''}
                        {((dyno.peakPower.power - reference.peakPower) / CV).toFixed(0)} CV
                      </span>
                    </span>
                    <button className="btn" onClick={() => setReference(null)}>
                      Quitar referencia
                    </button>
                  </>
                ) : (
                  <button className="btn" onClick={pinReference}>
                    Fijar como referencia (A/B)
                  </button>
                )}
                <button className="btn" onClick={() => void exportCsv()}>
                  Exportar CSV
                </button>
              </div>
              <DynoChart
                title="Potencia (CV)"
                unit="CV"
                colorVar="--series-power"
                points={dyno.points.map((p) => ({ rpm: p.rpm, value: p.power / CV }))}
                peak={{ rpm: dyno.peakPower.rpm, value: dyno.peakPower.power / CV }}
                failedAtRpm={dyno.failedAtRpm}
                hoverRpm={hoverRpm}
                onHover={setHoverRpm}
                reference={reference?.power}
                referenceLabel={reference?.label}
              />
              <DynoChart
                title="Par (Nm)"
                unit="Nm"
                colorVar="--series-torque"
                points={dyno.points.map((p) => ({ rpm: p.rpm, value: p.torque }))}
                peak={{ rpm: dyno.peakTorque.rpm, value: dyno.peakTorque.torque }}
                failedAtRpm={dyno.failedAtRpm}
                hoverRpm={hoverRpm}
                onHover={setHoverRpm}
                reference={reference?.torque}
                referenceLabel={reference?.label}
              />

              <details className="map-card">
                <summary>Mapas ECU — mezcla y encendido (rpm × carga)</summary>
                <div className="map-grid">
                  <MapEditor
                    title="Mezcla λ"
                    unit="λ objetivo"
                    map={tune.fuelMap}
                    min={0.7}
                    max={1.1}
                    step={0.01}
                    decimals={2}
                    invertScale
                    onChange={(m) => setTune((t) => ({ ...t, fuelMap: m }))}
                  />
                  <MapEditor
                    title="Avance de encendido"
                    unit="° APMS"
                    map={tune.sparkMap}
                    min={0}
                    max={40}
                    step={0.5}
                    decimals={1}
                    onChange={(m) => setTune((t) => ({ ...t, sparkMap: m }))}
                  />
                </div>
              </details>

              <TransientPanel engine={engine} tune={tune} fuel={fuel} />

              <EndurancePanel engine={engine} tune={tune} fuel={fuel} wear={wear} onWear={setWear} />

              <section>
                <h2 className="section-title">Eventos de la simulación</h2>
                {dyno.events.length === 0 && (
                  <p className="empty-note">
                    Sin avisos: ninguna pieza pasa del 92% de su límite en todo el barrido.
                  </p>
                )}
                {dyno.events.map((ev, i) => (
                  <EventCard key={i} ev={ev} />
                ))}
              </section>

              <details className="data-table">
                <summary>Ver tabla de datos del barrido</summary>
                <table>
                  <thead>
                    <tr>
                      <th>RPM</th>
                      <th>Par (Nm)</th>
                      <th>Potencia (CV)</th>
                      <th>P. pico (bar)</th>
                      <th>EGT (°C)</th>
                      <th>Corona (°C)</th>
                      <th>Duty iny.</th>
                      <th>λ real</th>
                      <th>Avance (°)</th>
                      <th>Raíl (bar)</th>
                      <th>Picado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dyno.points.map((p) => (
                      <tr key={p.rpm}>
                        <td>{p.rpm}</td>
                        <td>{p.torque.toFixed(0)}</td>
                        <td>{(p.power / CV).toFixed(0)}</td>
                        <td>{(p.peakPressure / 1e5).toFixed(0)}</td>
                        <td>{(p.exhaustTemp - 273.15).toFixed(0)}</td>
                        <td>{(p.crownTemp - 273.15).toFixed(0)}</td>
                        <td>{(p.injectorDuty * 100).toFixed(0)}%</td>
                        <td>{p.lambdaActual.toFixed(2)}</td>
                        <td>{p.sparkAdvance.toFixed(0)}</td>
                        <td>{(p.railPressure / 1e5).toFixed(1)}</td>
                        <td>{p.knockIndex.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          )}

          {!dyno && (
            <p className="empty-note">
              Corrige los errores de compatibilidad del ensamblaje para poder simular.
            </p>
          )}
        </main>
        )}
      </div>

      {importFile && (
        <ImportDialog file={importFile} onCancel={() => setImportFile(null)} onSave={saveImported} />
      )}
    </>
  )
}
