/**
 * Tacómetro analógico de celda de ensayo: arco de 240°, marcas cada 500 rpm,
 * numeración ×1000, zona roja desde el corte configurado y aguja amortiguada.
 * SVG puro, sin dependencias.
 */

interface Props {
  rpm: number
  redline: number
  max?: number
}

const CX = 110
const CY = 112
const R = 88
const SWEEP = 240 // grados
const START = 210 // 0 rpm apunta a las 7 y media

function angleFor(rpm: number, max: number): number {
  const f = Math.min(Math.max(rpm / max, 0), 1)
  return START - f * SWEEP
}

function polar(angleDeg: number, radius: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  return [CX + radius * Math.cos(a), CY - radius * Math.sin(a)]
}

function arcPath(fromRpm: number, toRpm: number, max: number, radius: number): string {
  const a0 = angleFor(fromRpm, max)
  const a1 = angleFor(toRpm, max)
  const [x0, y0] = polar(a0, radius)
  const [x1, y1] = polar(a1, radius)
  const large = Math.abs(a0 - a1) > 180 ? 1 : 0
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${radius} ${radius} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`
}

export default function Tachometer({ rpm, redline, max = 13000 }: Props): React.JSX.Element {
  const ticks: React.JSX.Element[] = []
  for (let v = 0; v <= max; v += 500) {
    const major = v % 1000 === 0
    const a = angleFor(v, max)
    const [x0, y0] = polar(a, R - (major ? 10 : 5))
    const [x1, y1] = polar(a, R)
    const danger = v >= redline
    ticks.push(
      <line
        key={v}
        x1={x0}
        y1={y0}
        x2={x1}
        y2={y1}
        stroke={danger ? '#ff3b30' : '#8a93a5'}
        strokeWidth={major ? 1.6 : 0.8}
      />
    )
    if (major && v % 2000 === 0) {
      const [tx, ty] = polar(a, R - 20)
      ticks.push(
        <text
          key={`t${v}`}
          x={tx}
          y={ty + 3}
          textAnchor="middle"
          fontSize="9.5"
          fill={danger ? '#ff5a4d' : '#c0c6d4'}
          fontFamily="inherit"
        >
          {v / 1000}
        </text>
      )
    }
  }

  const needleAngle = angleFor(rpm, max)
  const [nx, ny] = polar(needleAngle, R - 14)
  const [bx, by] = polar(needleAngle + 180, 14)

  return (
    <svg viewBox="0 0 220 150" className="tach" role="img" aria-label={`${rpm.toFixed(0)} rpm`}>
      {/* arco base y zona roja */}
      <path d={arcPath(0, max, max, R)} fill="none" stroke="#212a3a" strokeWidth="3" />
      <path d={arcPath(Math.min(redline, max), max, max, R)} fill="none" stroke="#ff3b30" strokeWidth="3.5" />
      {ticks}
      {/* aguja */}
      <line
        x1={bx}
        y1={by}
        x2={nx}
        y2={ny}
        stroke="#f5b942"
        strokeWidth="2.2"
        strokeLinecap="round"
        style={{ transition: 'x1 0.1s linear, y1 0.1s linear, x2 0.1s linear, y2 0.1s linear' }}
      />
      <circle cx={CX} cy={CY} r="5.5" fill="#0a0d14" stroke="#f5b942" strokeWidth="1.6" />
      <text x={CX} y={CY + 26} textAnchor="middle" fontSize="9" fill="#6f7888" fontFamily="inherit" letterSpacing="2">
        ×1000 RPM
      </text>
    </svg>
  )
}
