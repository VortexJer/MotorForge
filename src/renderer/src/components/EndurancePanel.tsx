import { useEffect, useState } from 'react'
import { WEAR_LABELS, runEndurance } from '@sim/index'
import type { EnduranceResult, EnduranceStyle, WearState } from '@sim/index'
import type { FuelSpec, ResolvedEngine, Tune } from '@sim/types'
import TimeChart from './TimeChart'
import EventCard from './EventCard'

interface Props {
  engine: ResolvedEngine
  tune: Tune
  fuel: FuelSpec
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

/**
 * Banco de resistencia: la pregunta ya no es "¿rompe ahora?" sino "¿cuánto
 * dura?". Acumula fatiga (Miner), picado, fluencia térmica y desgaste de
 * segmentos minuto a minuto; la fatiga no avisa hasta que rompe.
 */
export default function EndurancePanel({ engine, tune, fuel }: Props): React.JSX.Element {
  const [style, setStyle] = useState<EnduranceStyle>('deportivo')
  const [minutes, setMinutes] = useState(30)
  const [result, setResult] = useState<EnduranceResult | null>(null)

  // Cambiar motor, ajustes o combustible invalida la tanda anterior
  useEffect(() => setResult(null), [engine, tune, fuel])

  const run = (): void => {
    setResult(runEndurance(engine, tune, fuel, { minutes, style }))
  }

  const wearKeys = Object.keys(WEAR_LABELS) as Array<keyof WearState>

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
          <button className="btn primary" onClick={run}>
            ▶ Rodar tanda
          </button>
        </div>
      </div>

      {!result && (
        <p className="empty-note">
          Perfil «{STYLE_LABELS[style]}»: {STYLE_HINTS[style]}. El dyno dice si rompe ahora; esto dice
          cuánto aguanta — la fatiga no roba potencia, simplemente un día parte la pieza.
        </p>
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

          <div className="wear-bars">
            {wearKeys.map((k) => {
              const w = Math.min(result.finalWear[k], 1)
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
    </section>
  )
}
