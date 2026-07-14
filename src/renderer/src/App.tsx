import { useMemo, useState } from 'react'
import {
  ASPIRATIONS,
  BLOCKS,
  CRANKS,
  FUELS,
  HEADS,
  INJECTORS,
  PISTONS,
  RODS,
  partById,
  resolveEngine,
  runDyno
} from '@sim/index'
import type {
  AspirationPart,
  DynoResult,
  EngineAssembly,
  Part,
  SimEvent,
  Tune
} from '@sim/types'
import DynoChart from './components/DynoChart'
import Engine3D from './components/Engine3D'

const CV = 735.5
const fuel = FUELS.gasolina95!

interface Selection {
  block: string
  crank: string
  rod: string
  piston: string
  head: string
  injector: string
  aspiration: string
}

const SLOTS: Array<{ key: keyof Selection; label: string; options: Part[] }> = [
  { key: 'block', label: 'Bloque', options: BLOCKS },
  { key: 'crank', label: 'Cigüeñal', options: CRANKS },
  { key: 'rod', label: 'Bielas', options: RODS },
  { key: 'piston', label: 'Pistones', options: PISTONS },
  { key: 'head', label: 'Culata', options: HEADS },
  { key: 'injector', label: 'Inyectores', options: INJECTORS },
  { key: 'aspiration', label: 'Admisión', options: ASPIRATIONS }
]

function EventCard({ ev }: { ev: SimEvent }): React.JSX.Element {
  return (
    <article className="event">
      <div className="event-head">
        <span className={`sev ${ev.severity}`}>{ev.severity === 'failure' ? '✕ FALLO' : '⚠ AVISO'}</span>
        <span className="part">{ev.partName}</span>
        <span className="mode">{ev.failureMode}</span>
      </div>
      <ul className="cause-chain">
        {ev.causeChain.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
      {ev.severity === 'failure' && (
        <div className="state-before">
          Rendimiento en el momento del fallo: {ev.state.torque.toFixed(0)} Nm ·{' '}
          {(ev.state.power / CV).toFixed(0)} CV @ {ev.state.rpm} rpm
        </div>
      )}
    </article>
  )
}

export default function App(): React.JSX.Element {
  const [sel, setSel] = useState<Selection>({
    block: 'block-alu-2.0',
    crank: 'crank-cast-86',
    rod: 'rod-stock-139',
    piston: 'piston-cast-86',
    head: 'head-sport-42',
    injector: 'inj-310',
    aspiration: 'asp-na'
  })
  const [tune, setTune] = useState<Tune>({ lambda: 0.88, revLimit: 8200, boostTarget: 0, sparkTrim: 0 })
  const [hoverRpm, setHoverRpm] = useState<number | null>(null)

  const engine = useMemo(() => {
    const assembly: EngineAssembly = {
      block: partById(sel.block),
      crank: partById(sel.crank),
      rod: partById(sel.rod),
      piston: partById(sel.piston),
      head: partById(sel.head),
      injector: partById(sel.injector),
      aspiration: partById(sel.aspiration)
    }
    return resolveEngine(assembly)
  }, [sel])

  const hasErrors = engine.issues.some((i) => i.severity === 'error')
  const isTurbo = engine.assembly.aspiration.spec.type === 'turbo'

  const dyno: DynoResult | null = useMemo(() => {
    if (hasErrors) return null
    return runDyno(engine, tune, fuel)
  }, [engine, tune, hasErrors])

  const selectPart = (key: keyof Selection, id: string): void => {
    setSel((s) => ({ ...s, [key]: id }))
    if (key === 'aspiration') {
      const asp = partById<AspirationPart>(id)
      setTune((t) => ({ ...t, boostTarget: asp.spec.defaultBoost }))
    }
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
        <span className="sub">Banco de potencia · Fase 1 — catálogo, ensamblaje y fallos por límite</span>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section>
            <h2 className="section-title">Piezas</h2>
            {SLOTS.map(({ key, label, options }) => (
              <div className="field" key={key}>
                <label htmlFor={`sel-${key}`}>{label}</label>
                <select id={`sel-${key}`} value={sel[key]} onChange={(e) => selectPart(key, e.target.value)}>
                  {options.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </section>

          <section>
            <h2 className="section-title">Ajustes (ECU-lite)</h2>
            <div className="field">
              <label htmlFor="lambda">Mezcla λ a plena carga</label>
              <div className="slider-row">
                <input
                  id="lambda"
                  type="range"
                  min="0.75"
                  max="1.05"
                  step="0.01"
                  value={tune.lambda}
                  onChange={(e) => setTune((t) => ({ ...t, lambda: Number(e.target.value) }))}
                />
                <span className="slider-value">{tune.lambda.toFixed(2)}</span>
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
            <h2 className="section-title">Motor resuelto</h2>
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
              <h3>Tren alternativo — geometría real del ensamblaje{failure ? ' · pieza rota en rojo' : ''}</h3>
              <Engine3D geometry={g} failedKind={failedKind} />
            </div>
          )}

          {dyno && (
            <>
              <DynoChart
                title="Potencia (CV)"
                unit="CV"
                colorVar="--series-power"
                points={dyno.points.map((p) => ({ rpm: p.rpm, value: p.power / CV }))}
                peak={{ rpm: dyno.peakPower.rpm, value: dyno.peakPower.power / CV }}
                failedAtRpm={dyno.failedAtRpm}
                hoverRpm={hoverRpm}
                onHover={setHoverRpm}
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
              />

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
      </div>
    </>
  )
}
