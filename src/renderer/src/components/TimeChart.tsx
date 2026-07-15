import { useLayoutEffect, useRef, useState } from 'react'

export interface TimePoint {
  t: number
  value: number
}

interface Props {
  title: string
  unit: string
  colorVar: string
  points: TimePoint[]
  failedAtTime: number | null
  formatValue?: (v: number) => string
  /** Unidad del eje temporal ('s' para pulls, 'min' para tandas de resistencia). */
  xUnit?: 's' | 'min'
  /** Serie de referencia opcional (p. ej. boost estacionario) en línea discontinua. */
  reference?: TimePoint[]
  referenceLabel?: string
}

const MARGIN = { top: 16, right: 18, bottom: 26, left: 48 }
const HEIGHT = 190

function niceStep(maxValue: number, targetTicks: number): number {
  const raw = maxValue / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag
  }
  return 10 * mag
}

/** Panel de serie temporal del pull: una serie por panel, eje único. */
export default function TimeChart({
  title,
  unit,
  colorVar,
  points,
  failedAtTime,
  formatValue = (v) => v.toFixed(0),
  xUnit = 's',
  reference,
  referenceLabel
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [hoverT, setHoverT] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || points.length < 2) {
    return (
      <div className="chart-card" ref={containerRef}>
        <h3>
          <span className="swatch" style={{ background: `var(${colorVar})` }} />
          {title}
        </h3>
        <p className="empty-note">Sin datos.</p>
      </div>
    )
  }

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom
  const xMax = last.t
  const yMax0 = Math.max(...points.map((p) => p.value), ...(reference ?? []).map((p) => p.value), 1)
  const yStep = niceStep(yMax0 * 1.1, 4)
  const yMax = Math.ceil((yMax0 * 1.1) / yStep) * yStep

  const x = (t: number): number => MARGIN.left + (t / (xMax || 1)) * plotW
  const y = (v: number): number => MARGIN.top + plotH - (v / yMax) * plotH

  const pathOf = (pts: TimePoint[]): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')

  const path = pathOf(points)
  const areaPath = `${path} L${x(last.t).toFixed(1)},${y(0)} L${x(first.t).toFixed(1)},${y(0)} Z`

  const yTicks: number[] = []
  for (let v = 0; v <= yMax; v += yStep) yTicks.push(v)
  const xTickStep = xMax > 30 ? niceStep(xMax, 8) : xMax > 12 ? 2 : xMax > 6 ? 1 : 0.5
  const xTicks: number[] = []
  for (let v = 0; v <= xMax; v += xTickStep) xTicks.push(Number(v.toFixed(1)))

  const hoverPoint =
    hoverT === null
      ? null
      : points.reduce((best, p) => (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT) ? p : best))

  const handleMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    setHoverT((px / (plotW || 1)) * xMax)
  }

  const gradId = `tgrad-${colorVar.replace(/[^a-z0-9]/gi, '')}`

  return (
    <div className="chart-card" ref={containerRef}>
      <h3>
        <span className="swatch" style={{ background: `var(${colorVar})` }} />
        {title}
        {reference && referenceLabel && <span className="chart-sub"> · discontinua: {referenceLabel}</span>}
      </h3>
      <svg width={width} height={HEIGHT} role="img" aria-label={`${title} frente al tiempo`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`var(${colorVar})`} stopOpacity="0.18" />
            <stop offset="100%" stopColor={`var(${colorVar})`} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {yTicks.map((v) => (
          <g key={v}>
            <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth="1" />
            <text x={MARGIN.left - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {formatValue(v)}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={v} x={x(v)} y={HEIGHT - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
            {v}
            {xUnit}
          </text>
        ))}
        <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(0)} y2={y(0)} stroke="var(--baseline)" strokeWidth="1" />

        {reference && (
          <path d={pathOf(reference)} fill="none" stroke={`var(${colorVar})`} strokeWidth="1.4" strokeDasharray="5 4" opacity="0.55" />
        )}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={path} fill="none" stroke={`var(${colorVar})`} strokeWidth="2" strokeLinejoin="round" />

        {failedAtTime !== null && failedAtTime <= xMax && (
          <g>
            <line
              x1={x(failedAtTime)}
              x2={x(failedAtTime)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
              stroke="var(--status-critical)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <text
              x={x(failedAtTime)}
              y={MARGIN.top + plotH - 8}
              textAnchor={x(failedAtTime) > MARGIN.left + plotW - 70 ? 'end' : 'start'}
              dx={x(failedAtTime) > MARGIN.left + plotW - 70 ? -5 : 5}
              fontSize="11"
              fontWeight="700"
              fill="var(--status-critical)"
            >
              ✕ ROTURA
            </text>
          </g>
        )}

        {hoverPoint && (
          <g>
            <line
              x1={x(hoverPoint.t)}
              x2={x(hoverPoint.t)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
              stroke="var(--baseline)"
              strokeWidth="1"
            />
            <circle cx={x(hoverPoint.t)} cy={y(hoverPoint.value)} r="4.5" fill={`var(${colorVar})`} stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}

        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={Math.max(plotW, 0)}
          height={plotH}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverT(null)}
        />
      </svg>

      {hoverPoint && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(x(hoverPoint.t) + 12, width - 130), top: y(hoverPoint.value) - 14 }}
        >
          <span className="t-rpm">
            {xUnit === 'min' ? hoverPoint.t.toFixed(0) : hoverPoint.t.toFixed(1)} {xUnit} ·{' '}
          </span>
          <span className="t-val">
            {formatValue(hoverPoint.value)} {unit}
          </span>
        </div>
      )}
    </div>
  )
}
