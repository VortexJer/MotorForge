import type { SimEvent } from '@sim/types'

const CV = 735.5

export default function EventCard({ ev }: { ev: SimEvent }): React.JSX.Element {
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
          {ev.time !== undefined ? ` · t = ${ev.time.toFixed(1)} s` : ''}
        </div>
      )}
    </article>
  )
}
