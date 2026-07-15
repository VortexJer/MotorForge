import { withCell } from '@sim/ecu'
import type { EcuMap } from '@sim/types'

interface Props {
  title: string
  unit: string
  map: EcuMap
  min: number
  max: number
  step: number
  decimals: number
  /** true si valores BAJOS son "intensos" (λ: más rico = más color). */
  invertScale?: boolean
  onChange: (map: EcuMap) => void
}

/**
 * Editor de mapa ECU: filas = carga (presión de colector), columnas = rpm.
 * Convención de taller: la carga alta arriba. Heatmap monocromo por valor.
 */
export default function MapEditor({
  title,
  unit,
  map,
  min,
  max,
  step,
  decimals,
  invertScale = false,
  onChange
}: Props): React.JSX.Element {
  const rows = [...map.loadAxis.keys()].reverse()

  const cellBg = (v: number): string => {
    let t = (v - min) / (max - min || 1)
    t = Math.min(1, Math.max(0, invertScale ? 1 - t : t))
    return `rgba(57, 135, 229, ${(0.06 + 0.34 * t).toFixed(3)})`
  }

  return (
    <div className="map-editor">
      <h4>
        {title} <span className="map-unit">({unit})</span>
      </h4>
      <div className="map-scroll">
        <table>
          <thead>
            <tr>
              <th className="map-corner">bar ↓ · rpm →</th>
              {map.rpmAxis.map((rpm) => (
                <th key={rpm}>{rpm >= 1000 ? `${(rpm / 1000).toFixed(1).replace('.0', '')}k` : rpm}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((iLoad) => (
              <tr key={iLoad}>
                <th>{(map.loadAxis[iLoad]! / 1e5).toFixed(1)}</th>
                {map.rpmAxis.map((_, iRpm) => {
                  const v = map.values[iLoad]![iRpm]!
                  return (
                    <td key={iRpm} style={{ background: cellBg(v) }}>
                      <input
                        type="number"
                        value={Number(v.toFixed(decimals))}
                        min={min}
                        max={max}
                        step={step}
                        aria-label={`${title} a ${map.rpmAxis[iRpm]} rpm y ${(map.loadAxis[iLoad]! / 1e5).toFixed(1)} bar`}
                        onChange={(e) => {
                          const n = Number(e.target.value)
                          if (Number.isFinite(n)) onChange(withCell(map, iLoad, iRpm, n))
                        }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
