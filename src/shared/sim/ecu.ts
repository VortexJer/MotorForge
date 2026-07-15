import type { EcuMap } from './types'

/**
 * Mapas ECU 2D (rpm × presión de colector) con interpolación bilineal.
 * Los mapas por defecto reproducen la calibración implícita de la fase 1:
 * λ 0.88 a plena carga atmosférica que se enriquece con boost, y avance
 * que crece con rpm y se retrasa con boost.
 */

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/** Índice del tramo y fracción para interpolar sobre un eje (saturando en bordes). */
function axisLookup(axis: number[], x: number): { i: number; f: number } {
  const n = axis.length
  if (n < 2 || x <= axis[0]!) return { i: 0, f: 0 }
  if (x >= axis[n - 1]!) return { i: n - 2, f: 1 }
  for (let i = 1; i < n; i++) {
    if (x <= axis[i]!) {
      return { i: i - 1, f: (x - axis[i - 1]!) / (axis[i]! - axis[i - 1]!) }
    }
  }
  return { i: n - 2, f: 1 }
}

/** Lectura bilineal del mapa en (rpm, presión absoluta de colector). */
export function mapLookup(map: EcuMap, rpm: number, pMan: number): number {
  const { i: ir, f: fr } = axisLookup(map.rpmAxis, rpm)
  const { i: il, f: fl } = axisLookup(map.loadAxis, pMan)
  const row0 = map.values[il]!
  const row1 = map.values[il + 1] ?? row0
  const v00 = row0[ir]!
  const v01 = row0[ir + 1] ?? v00
  const v10 = row1[ir]!
  const v11 = row1[ir + 1] ?? v10
  const a = v00 + fr * (v01 - v00)
  const b = v10 + fr * (v11 - v10)
  return a + fl * (b - a)
}

export const RPM_AXIS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8500]
/** kPa→Pa: 60 (carga parcial), 100 (atmosférico), 150/200/250/300 (boost). */
export const LOAD_AXIS = [0.6e5, 1.0e5, 1.5e5, 2.0e5, 2.5e5, 3.0e5]

/** λ objetivo: estequiométrica en carga parcial, 0.88 a plena carga NA, rica con boost. */
export function defaultFuelMap(): EcuMap {
  const lambdaByLoad = [1.0, 0.88, 0.85, 0.82, 0.8, 0.78]
  return {
    rpmAxis: [...RPM_AXIS],
    loadAxis: [...LOAD_AXIS],
    values: lambdaByLoad.map((l) => RPM_AXIS.map(() => l))
  }
}

/** Avance (° APMS): crece con rpm, se retrasa ~7° por bar de boost. */
export function defaultSparkMap(): EcuMap {
  return {
    rpmAxis: [...RPM_AXIS],
    loadAxis: [...LOAD_AXIS],
    values: LOAD_AXIS.map((load) => {
      const boostBar = Math.max(0, (load - 1.0e5) / 1e5)
      return RPM_AXIS.map((rpm) => {
        const base = 12 + 20 * clamp((rpm - 1000) / 7000, 0, 1)
        // en carga parcial se puede adelantar un poco más
        const partLoad = load < 1.0e5 ? 4 : 0
        return Math.round((base - 7 * boostBar + partLoad) * 10) / 10
      })
    })
  }
}

export function cloneMap(map: EcuMap): EcuMap {
  return {
    rpmAxis: [...map.rpmAxis],
    loadAxis: [...map.loadAxis],
    values: map.values.map((row) => [...row])
  }
}

/** Copia del mapa con una celda cambiada (para la UI y los tests). */
export function withCell(map: EcuMap, iLoad: number, iRpm: number, value: number): EcuMap {
  const next = cloneMap(map)
  next.values[iLoad]![iRpm] = value
  return next
}
