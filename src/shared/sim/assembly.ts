import type { CompatIssue, EngineAssembly, ResolvedEngine, ResolvedGeometry } from './types'

/** Espesor comprimido de junta de culata estándar (v0: fijo). */
const HEAD_GASKET_THICKNESS = 0.0008 // m

/**
 * Resuelve la geometría del motor a partir de las piezas y valida compatibilidad.
 * La relación de compresión NO es un dato de entrada: emerge de cámara de culata,
 * cúpula de pistón, altura de bloque y junta. Cambiar una pieza cambia el motor.
 */
export function resolveEngine(assembly: EngineAssembly): ResolvedEngine {
  const { block, crank, rod, piston, head } = assembly
  const issues: CompatIssue[] = []

  const bore = block.spec.bore
  const stroke = crank.spec.stroke
  const area = (Math.PI * bore * bore) / 4

  if (Math.abs(piston.spec.bore - bore) > 0.0005) {
    issues.push({
      severity: 'error',
      message: `El pistón (${(piston.spec.bore * 1000).toFixed(1)} mm) no encaja en el bloque (${(bore * 1000).toFixed(1)} mm)`
    })
  }

  // Altura de la cadena cinemática en PMS vs altura de bloque
  const stackHeight = stroke / 2 + rod.spec.length + piston.spec.compressionHeight
  const deckClearance = block.spec.deckHeight - stackHeight

  if (deckClearance < -1e-6) {
    issues.push({
      severity: 'error',
      message: `Interferencia: el pistón sobresale ${(-deckClearance * 1000).toFixed(2)} mm del bloque en PMS (biela/pistón demasiado largos para este bloque)`
    })
  } else if (deckClearance > 0.003) {
    issues.push({
      severity: 'warning',
      message: `El pistón queda ${(deckClearance * 1000).toFixed(1)} mm por debajo del plano: relación de compresión muy baja`
    })
  }

  const clearanceVolume =
    head.spec.chamberVolume +
    area * Math.max(0, deckClearance) +
    area * HEAD_GASKET_THICKNESS -
    piston.spec.domeVolume

  const sweptPerCyl = area * stroke
  const compressionRatio = (sweptPerCyl + clearanceVolume) / clearanceVolume

  if (compressionRatio > 14) {
    issues.push({
      severity: 'warning',
      message: `Relación de compresión ${compressionRatio.toFixed(1)}:1 — muy alta para gasolina de surtidor`
    })
  } else if (compressionRatio < 7 && deckClearance >= -1e-6) {
    issues.push({
      severity: 'warning',
      message: `Relación de compresión ${compressionRatio.toFixed(1)}:1 — muy baja, rendimiento pobre`
    })
  }

  const geometry: ResolvedGeometry = {
    bore,
    stroke,
    rodLength: rod.spec.length,
    cylinders: block.spec.cylinders,
    displacement: sweptPerCyl * block.spec.cylinders,
    clearanceVolume,
    compressionRatio,
    deckClearance
  }

  return { geometry, assembly, issues }
}
