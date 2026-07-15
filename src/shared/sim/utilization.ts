import { measuredValue } from './dyno'
import type { LimitVariable, OperatingPointResult, Part, PartKind, ResolvedEngine } from './types'

/**
 * Utilización por pieza para los overlays 3D: fracción valor/límite máxima
 * a lo largo del barrido, filtrada por categoría (térmica o estructural).
 * 1.0 = la pieza tocó su límite en algún punto.
 */

export type OverlayCategory = 'termico' | 'estructural'

const CATEGORY_VARS: Record<OverlayCategory, LimitVariable[]> = {
  termico: ['crownTemp', 'exhaustTemp'],
  estructural: ['peakCylinderPressure', 'rodCompression', 'rodTension', 'rpm', 'boost']
}

export function computeUtilization(
  engine: ResolvedEngine,
  points: OperatingPointResult[],
  category: OverlayCategory
): Partial<Record<PartKind, number>> {
  const vars = CATEGORY_VARS[category]
  const out: Partial<Record<PartKind, number>> = {}

  const parts: Part[] = Object.values(engine.assembly)
  for (const part of parts) {
    let worst: number | null = null
    for (const limit of part.limits) {
      if (!vars.includes(limit.variable) || limit.value <= 0) continue
      for (const p of points) {
        const ratio = measuredValue(limit.variable, p) / limit.value
        if (worst === null || ratio > worst) worst = ratio
      }
    }
    if (worst !== null) {
      const prev = out[part.kind]
      out[part.kind] = prev === undefined ? worst : Math.max(prev, worst)
    }
  }
  return out
}
