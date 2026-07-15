import { useEffect, useState } from 'react'
import { runTransient } from '@sim/index'
import type { FuelSpec, ResolvedEngine, TransientResult, Tune } from '@sim/types'
import TimeChart from './TimeChart'
import EventCard from './EventCard'

interface Props {
  engine: ResolvedEngine
  tune: Tune
  fuel: FuelSpec
}

/**
 * Prueba dinámica: pull a plena carga contra inercia de banco. A diferencia
 * del barrido estacionario, aquí el turbo tiene lag y las temperaturas
 * tienen masa térmica: se ve CUÁNDO llega el boost y CUÁNDO rompe.
 */
export default function TransientPanel({ engine, tune, fuel }: Props): React.JSX.Element {
  const [result, setResult] = useState<TransientResult | null>(null)

  // Cambiar motor, ajustes o combustible invalida el pull anterior
  useEffect(() => setResult(null), [engine, tune, fuel])

  const isTurbo = engine.assembly.aspiration.spec.type === 'turbo'

  const launch = (): void => {
    setResult(runTransient(engine, tune, fuel, { startRpm: 2000, inertia: 1.5 }))
  }

  const kiMax = result ? Math.max(...result.samples.map((s) => s.knockIndex)) : 0
  const boostMax = result ? Math.max(...result.samples.map((s) => s.boost)) : 0
  const crownMax = result ? Math.max(...result.samples.map((s) => s.crownTemp)) : 0

  return (
    <section className="transient-panel">
      <div className="transient-head">
        <h2 className="section-title">Prueba dinámica (pull contra inercia)</h2>
        <button className="btn primary" onClick={launch}>
          ▶ Lanzar pull
        </button>
      </div>

      {!result && (
        <p className="empty-note">
          Acelerón de 2000 rpm al corte con lag de turbo e inercia térmica reales. Lanza el pull para
          ver el transitorio.
        </p>
      )}

      {result && (
        <>
          <div className="transient-summary">
            <span className={`status-chip ${result.failedAtTime !== null ? 'critical' : 'good'}`}>
              {result.failedAtTime !== null
                ? `✕ Rompe a los ${result.failedAtTime.toFixed(1)} s`
                : result.timeToRevLimit !== null
                  ? `✓ Corte en ${result.timeToRevLimit.toFixed(1)} s`
                  : '– No llega al corte'}
            </span>
            {isTurbo && <span className="summary-item">boost máx {(boostMax / 1e5).toFixed(2)} bar</span>}
            <span className="summary-item">picado máx {kiMax.toFixed(2)}</span>
            <span className="summary-item">corona máx {(crownMax - 273.15).toFixed(0)} °C</span>
          </div>

          <TimeChart
            title="Régimen (rpm)"
            unit="rpm"
            colorVar="--series-power"
            points={result.samples.map((s) => ({ t: s.t, value: s.rpm }))}
            failedAtTime={result.failedAtTime}
          />
          {isTurbo ? (
            <TimeChart
              title="Boost (bar)"
              unit="bar"
              colorVar="--series-torque"
              points={result.samples.map((s) => ({ t: s.t, value: s.boost / 1e5 }))}
              reference={result.samples.map((s) => ({ t: s.t, value: s.boostSteady / 1e5 }))}
              referenceLabel="estacionario (sin lag)"
              failedAtTime={result.failedAtTime}
              formatValue={(v) => v.toFixed(1)}
            />
          ) : (
            <TimeChart
              title="Par (Nm)"
              unit="Nm"
              colorVar="--series-torque"
              points={result.samples.map((s) => ({ t: s.t, value: s.torque }))}
              failedAtTime={result.failedAtTime}
            />
          )}

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
