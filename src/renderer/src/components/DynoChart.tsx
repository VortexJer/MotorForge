import { useLayoutEffect, useRef, useState } from 'react'

export interface ChartPoint {
  rpm: number
  value: number
}

interface Props {
  title: string
  unit: string
  colorVar: string
  points: ChartPoint[]
  peak: { rpm: number; value: number }
  failedAtRpm: number | null
  hoverRpm: number | null
  onHover: (rpm: number | null) => void
  formatValue?: (v: number) => string
}

const MARGIN = { top: 16, right: 18, bottom: 26, left: 48 }
const HEIGHT = 210

function niceStep(maxValue: number, targetTicks: number): number {
  const raw = maxValue / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag
  }
  return 10 * mag
}

/**
 * Panel de curva del banco: una serie, un eje (nunca doble eje).
 * Crosshair + tooltip al pasar el ratón; pico etiquetado; marca de rotura.
 */
export default function DynoChart({
  title,
  unit,
  colorVar,
  points,
  peak,
  failedAtRpm,
  hoverRpm,
  onHover,
  formatValue = (v) => v.toFixed(0)
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)

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
      <div className="chart-card">
        <h3>
          <span className="swatch" style={{ background: `var(${colorVar})` }} />
          {title}
        </h3>
        <p className="empty-note">Sin datos: el motor no completa el barrido.</p>
      </div>
    )
  }

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom
  const xMin = first.rpm
  const xMax = last.rpm
  const yMax0 = Math.max(...points.map((p) => p.value), 1)
  const yStep = niceStep(yMax0 * 1.1, 4)
  const yMax = Math.ceil((yMax0 * 1.1) / yStep) * yStep

  const x = (rpm: number): number => MARGIN.left + ((rpm - xMin) / (xMax - xMin || 1)) * plotW
  const y = (v: number): number => MARGIN.top + plotH - (v / yMax) * plotH

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.rpm).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ')
  const areaPath = `${path} L${x(last.rpm).toFixed(1)},${y(0)} L${x(first.rpm).toFixed(1)},${y(0)} Z`

  const yTicks: number[] = []
  for (let v = 0; v <= yMax; v += yStep) yTicks.push(v)
  const xTicks: number[] = []
  const xTickStep = xMax - xMin > 5000 ? 1000 : 500
  for (let v = Math.ceil(xMin / xTickStep) * xTickStep; v <= xMax; v += xTickStep) xTicks.push(v)

  const hoverPoint =
    hoverRpm === null
      ? null
      : points.reduce((best, p) =>
          Math.abs(p.rpm - hoverRpm) < Math.abs(best.rpm - hoverRpm) ? p : best
        )

  const handleMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const rpm = xMin + (px / (plotW || 1)) * (xMax - xMin)
    onHover(Math.round(rpm))
  }

  // Etiqueta del pico, evitando salirse por los bordes
  const peakX = x(peak.rpm)
  const peakAnchor = peakX > MARGIN.left + plotW - 90 ? 'end' : peakX < MARGIN.left + 90 ? 'start' : 'middle'

  const gradId = `grad-${colorVar.replace(/[^a-z0-9]/gi, '')}`

  return (
    <div className="chart-card" ref={containerRef}>
      <h3>
        <span className="swatch" style={{ background: `var(${colorVar})` }} />
        {title}
      </h3>
      <svg width={width} height={HEIGHT} role="img" aria-label={`${title} frente a RPM`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`var(${colorVar})`} stopOpacity="0.18" />
            <stop offset="100%" stopColor={`var(${colorVar})`} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* rejilla y ejes */}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth="1" />
            <text x={MARGIN.left - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {v}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={v} x={x(v)} y={HEIGHT - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
            {v >= 1000 ? `${v / 1000}k` : v}
          </text>
        ))}
        <line
          x1={MARGIN.left}
          x2={MARGIN.left + plotW}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--baseline)"
          strokeWidth="1"
        />

        {/* serie */}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={path} fill="none" stroke={`var(${colorVar})`} strokeWidth="2" strokeLinejoin="round" />

        {/* pico: etiqueta directa selectiva */}
        <circle cx={peakX} cy={y(peak.value)} r="3.5" fill={`var(${colorVar})`} stroke="var(--surface)" strokeWidth="2" />
        <text x={peakX} y={y(peak.value) - 9} textAnchor={peakAnchor} fontSize="11" fontWeight="600" fill="var(--ink)">
          {formatValue(peak.value)} {unit} @ {peak.rpm}
        </text>

        {/* rotura */}
        {failedAtRpm !== null && failedAtRpm >= xMin && failedAtRpm <= xMax && (
          <g>
            <line
              x1={x(failedAtRpm)}
              x2={x(failedAtRpm)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
              stroke="var(--status-critical)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <text
              x={x(failedAtRpm)}
              y={MARGIN.top + 10}
              textAnchor={x(failedAtRpm) > MARGIN.left + plotW - 70 ? 'end' : 'start'}
              dx={x(failedAtRpm) > MARGIN.left + plotW - 70 ? -5 : 5}
              fontSize="11"
              fontWeight="700"
              fill="var(--status-critical)"
            >
              ✕ ROTURA
            </text>
          </g>
        )}

        {/* crosshair */}
        {hoverPoint && (
          <g>
            <line
              x1={x(hoverPoint.rpm)}
              x2={x(hoverPoint.rpm)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
              stroke="var(--baseline)"
              strokeWidth="1"
            />
            <circle
              cx={x(hoverPoint.rpm)}
              cy={y(hoverPoint.value)}
              r="4.5"
              fill={`var(${colorVar})`}
              stroke="var(--surface)"
              strokeWidth="2"
            />
          </g>
        )}

        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={Math.max(plotW, 0)}
          height={plotH}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => onHover(null)}
        />
      </svg>

      {hoverPoint && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(x(hoverPoint.rpm) + 12, width - 130),
            top: y(hoverPoint.value) - 14
          }}
        >
          <span className="t-rpm">{hoverPoint.rpm} rpm · </span>
          <span className="t-val">
            {formatValue(hoverPoint.value)} {unit}
          </span>
        </div>
      )}
    </div>
  )
}
