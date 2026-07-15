import { useEffect, useState } from 'react'
import { WEAR_LABELS, freshWear, runEndurance } from '@sim/index'
import type { EnduranceResult, EnduranceStyle, WearState } from '@sim/index'
import type { FuelSpec, ResolvedEngine, Tune } from '@sim/types'
import TimeChart from './TimeChart'
import EventCard from './EventCard'

interface Props {
  engine: ResolvedEngine
  tune: Tune
  fuel: FuelSpec
  /** Desgaste acumulado del motor (persiste entre tandas y sesiones). */
  wear: WearState
  onWear: (w: WearState) => void
}

const STYLE_LABELS: Record<EnduranceStyle, string> = {
  suave: 'Suave',
  deportivo: 'Deportivo',
  limite: 'Al límite'
}

const STYLE_HINTS: Record<EnduranceStyle, string> = {
  suave: 'uso de calle: mayoría del tiempo a medio régimen',
  deportivo: 'tandas de circuito: régimen alto con puntas al corte',
  limite: 'castigo máximo: clavado cerca del corte casi todo el tiempo'
}

const MINUTE_OPTIONS = [15, 30, 60, 120]

interface HistoryEntry {
  n: number
  style: EnduranceStyle
  minutes: number
  failedAtMinute: number | null
  failureMode: string | null
  torqueLoss: number
}

/**
 * Banco de resistencia: la pregunta ya no es "¿rompe ahora?" sino "¿cuánto
 * dura?". El desgaste se ACUMULA entre tandas: un motor castigado ayer parte
 * hoy con la fatiga a cuestas, hasta que lo reconstruyes.
 */
export default function EndurancePanel({ engine, tune, fuel, wear, onWear }: Props): React.JSX.Element {
  const [style, setStyle] = useState<EnduranceStyle>('deportivo')
  const [minutes, setMinutes] = useState(30)
  const [result, setResult] = useState<EnduranceResult | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])

  // Cambiar motor, ajustes o combustible invalida la tanda mostrada
  useEffect(() => setResult(null), [engine, tune, fuel])

  const wearKeys = Object.keys(WEAR_LABELS) as Array<keyof WearState>
  const broken = wearKeys.some((k) => k !== 'ringsWear' && wear[k] >= 1)
  const used = wearKeys.some((k) => wear[k] > 0.005)

  const run = (): void => {
    const r = runEndurance(engine, tune, fuel, { minutes, style, initialWear: wear })
    setResult(r)
    onWear(r.finalWear)
    setHistory((h) => [
      {
        n: h.length + 1,
        style,
        minutes,
        failedAtMinute: r.failedAtMinute,
        failureMode: r.events.find((e) => e.severity === 'failure')?.failureMode ?? null,
        torqueLoss: r.torqueLossFraction
      },
      ...h
    ])
  }

  const rebuild = (): void => {
    onWear(freshWear())
    setResult(null)
  }

  const shownWear = result ? result.finalWear : wear

  return (
    <section className="transient-panel">
      <div className="transient-head">
        <h2 className="section-title">Banco de resistencia (desgaste acumulado)</h2>
        <div className="endurance-controls">
          <div className="segmented" role="group" aria-label="Estilo de conducción">
            {(Object.keys(STYLE_LABELS) as EnduranceStyle[]).map((s) => (
              <button
                key={s}
                type="button"
                className={style === s ? 'seg-btn active' : 'seg-btn'}
                title={STYLE_HINTS[s]}
                onClick={() => {
                  setStyle(s)
                  setResult(null)
                }}
              >
                {STYLE_LABELS[s]}
              </button>
            ))}
          </div>
          <select
            id="endurance-minutes"
            aria-label="Duración de la tanda"
            value={minutes}
            onChange={(e) => {
              setMinutes(Number(e.target.value))
              setResult(null)
            }}
          >
            {MINUTE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={run} disabled={broken}>
            Rodar tanda
          </button>
          {used && (
            <button className="btn" onClick={rebuild} title="Reconstruye el motor: desgaste a cero">
              Motor a estrenar
            </button>
          )}
        </div>
      </div>

      {broken && !result && (
        <p className="broken-note">
          ✕ Este motor está roto por una tanda anterior. Reconstrúyelo («Motor a estrenar») para
          volver a rodar.
        </p>
      )}

      {!result && !broken && (
        <p className="empty-note">
          Perfil «{STYLE_LABELS[style]}»: {STYLE_HINTS[style]}.{' '}
          {used
            ? 'El motor arranca con el desgaste acumulado de tandas anteriores.'
            : 'El dyno dice si rompe ahora; esto dice cuánto aguanta — la fatiga no roba potencia, simplemente un día parte la pieza.'}
        </p>
      )}

      {(used || result) && (
        <div className="wear-bars">
          {wearKeys.map((k) => {
            const w = Math.min(shownWear[k], 1)
            const cls = w >= 1 ? 'critical' : w >= 0.7 ? 'warning' : ''
            return (
              <div className="wear-row" key={k}>
                <span className="wear-label">{WEAR_LABELS[k]}</span>
                <div className="wear-track">
                  <div className={`wear-fill ${cls}`} style={{ width: `${(w * 100).toFixed(1)}%` }} />
                </div>
                <span className={`wear-pct ${cls}`}>{(w * 100).toFixed(0)}%</span>
              </div>
            )
          })}
        </div>
      )}

      {result && (
        <>
          <div className="transient-summary">
            <span className={`status-chip ${result.failedAtMinute !== null ? 'critical' : 'good'}`}>
              {result.failedAtMinute !== null
                ? `✕ Rompe en el minuto ${result.failedAtMinute}`
                : `✓ Aguanta los ${minutes} min`}
            </span>
            <span className="summary-item">
              pérdida de par por desgaste {(result.torqueLossFraction * 100).toFixed(1)}%
            </span>
          </div>

          <TimeChart
            title="Par de referencia (Nm) — el desgaste de segmentos roba compresión"
            unit="Nm"
            colorVar="--series-torque"
            xUnit="min"
            points={result.samples.map((s) => ({ t: s.tMin, value: s.torqueRef }))}
            failedAtTime={result.failedAtMinute}
          />

          {result.events.length > 0 && (
            <div className="transient-events">
              {result.events.map((ev, i) => (
                <EventCard key={i} ev={ev} />
              ))}
            </div>
          )}
        </>
      )}

      {history.length > 0 && (
        <div className="endurance-history">
          <h3 className="section-title">Histórico de tandas</h3>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Perfil</th>
                <th>Duración</th>
                <th>Resultado</th>
                <th>Pérdida de par</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.n}>
                  <td>{h.n}</td>
                  <td>{STYLE_LABELS[h.style]}</td>
                  <td>{h.minutes} min</td>
                  <td className={h.failedAtMinute !== null ? 'hist-fail' : 'hist-ok'}>
                    {h.failedAtMinute !== null
                      ? `✕ min ${h.failedAtMinute} — ${h.failureMode ?? ''}`
                      : '✓ aguanta'}
                  </td>
                  <td>{(h.torqueLoss * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
