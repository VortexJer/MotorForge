import type { Material } from '../materials'
import type { DerivedLimit, InjectorPart, PistonPart, RodPart } from '../types'
import type { GeometryMetrics } from './metrics'

/**
 * Derivación automática de límites de fallo: geometría medida + material
 * elegido + plantilla de cargas por tipo de pieza → DerivedLimit[] con
 * provenance 'derived-analytic' y explicación legible.
 *
 * Nivel A del plan (fórmulas cerradas). El nivel B (FEA vóxel) llegará en
 * fase 4 y solo sustituirá el value/explanation manteniendo el contrato.
 */

export type ImportKind = 'rod' | 'piston' | 'injector'

/** Parámetros que la app propone desde la geometría y el usuario confirma. */
export interface RodParams {
  /** Distancia entre centros (m). Propuesta: 0.8 × dimensión mayor. */
  centerDistance: number
}
export interface PistonParams {
  /** Diámetro nominal (m). Propuesta: mayor dimensión lateral. */
  bore: number
  /** Altura de compresión, eje de bulón a corona (m). */
  compressionHeight: number
}
export interface InjectorParams {
  /** Diámetro del conducto interno de combustible (m). */
  channelDiameter: number
  /** Caudal estático (kg/s) — dato hidráulico, no derivable de la carcasa. */
  staticFlow: number
}

export interface ImportedPartInput {
  name: string
  metrics: GeometryMetrics
  material: Material
}

const bar = (pa: number): string => (pa / 1e5).toFixed(0)
const mm = (m: number): string => (m * 1000).toFixed(1)
const kN = (n: number): string => (n / 1000).toFixed(0)

/** Factor de seguridad aplicado a todos los límites derivados analíticamente. */
const SF = 1.35

export function deriveRodLimits(input: ImportedPartInput, params: RodParams): DerivedLimit[] {
  const { metrics: g, material: m } = input
  const A = g.minSectionArea
  const L = params.centerDistance
  // Sección en I/H: inercia estimada desde el área con factor de forma
  const I = (1.4 * A * A) / (4 * Math.PI)
  const buckling = (Math.PI * Math.PI * m.youngModulus * I) / (L * L)
  const yield_ = m.yieldStrength * A
  const compression = Math.min(buckling, yield_) / SF
  const governs = buckling < yield_ ? 'pandeo de Euler' : 'plastificación'

  // La unión (tornillos) no se ve en la geometría: fatiga del vástago con
  // factor conservador por concentración de tensiones en cabeza/pie
  const tension = (0.5 * m.fatigueLimit * A) / SF

  return [
    {
      variable: 'rodCompression',
      value: compression,
      provenance: 'derived-analytic',
      explanation: `Sección mínima ${(A * 1e6).toFixed(0)} mm², ${m.name}: ${governs} a ${kN(compression * SF)} kN (÷${SF} seguridad). Euler con I≈1.4·A²/4π, L=${mm(L)} mm`,
      failureMode: 'Pandeo de biela'
    },
    {
      variable: 'rodTension',
      value: tension,
      provenance: 'derived-analytic',
      explanation: `Fatiga del material (${(m.fatigueLimit / 1e6).toFixed(0)} MPa) sobre sección mínima con factor 0.5 por concentración en uniones (÷${SF} seguridad)`,
      failureMode: 'Rotura de biela por tracción/fatiga'
    }
  ]
}

export function derivePistonLimits(input: ImportedPartInput, params: PistonParams): DerivedLimit[] {
  const { metrics: g, material: m } = input
  const t = g.minWallThickness // espesor de corona ≈ pared mínima medida
  const r = params.bore / 2
  // Placa circular empotrada bajo presión: σ_max = 0.75·P·(r/t)².
  // Los pistones reales llevan nervios y cúpula: factor de refuerzo 1.8.
  // Tensión admisible reducida al 55% del límite elástico por temperatura.
  const sigmaAllow = 0.55 * m.yieldStrength
  const pLimit = ((1.8 * sigmaAllow * t * t) / (0.75 * r * r)) / SF

  return [
    {
      variable: 'peakCylinderPressure',
      value: pLimit,
      provenance: 'derived-analytic',
      explanation: `Corona de ${mm(t)} mm en ${m.name}, Ø${mm(params.bore)} mm: flexión de placa empotrada con refuerzo por nervios ×1.8 y σ_adm=0.55·σy (÷${SF} seguridad) → ${bar(pLimit)} bar`,
      failureMode: 'Rotura de corona de pistón'
    },
    {
      variable: 'crownTemp',
      value: m.maxServiceTemp,
      provenance: 'derived-analytic',
      explanation: `${m.name} conserva propiedades hasta ${(m.maxServiceTemp - 273).toFixed(0)} °C (funde a ${(m.meltingPoint - 273).toFixed(0)} °C)`,
      failureMode: 'Fusión / ablandamiento de corona de pistón'
    }
  ]
}

export function deriveInjectorLimits(input: ImportedPartInput, params: InjectorParams): DerivedLimit[] {
  const { metrics: g, material: m } = input
  const ri = params.channelDiameter / 2
  const ro = ri + g.minWallThickness
  // Cilindro de pared gruesa (Lamé): P_fluencia = σy·(ro²−ri²)/(ro²+ri²)
  const pBurst = (m.yieldStrength * (ro * ro - ri * ri)) / (ro * ro + ri * ri)
  const pLimit = pBurst / SF

  return [
    {
      variable: 'railPressure',
      value: pLimit,
      provenance: 'derived-analytic',
      explanation: `Conducto Ø${mm(params.channelDiameter)} mm con pared de ${mm(g.minWallThickness)} mm en ${m.name}: Lamé pared gruesa → fluencia a ${bar(pBurst)} bar (÷${SF} seguridad)`,
      failureMode: 'Estallido del cuerpo del inyector'
    },
    {
      variable: 'injectorDuty',
      value: 0.85,
      provenance: 'derived-analytic',
      explanation: 'Límite electro-hidráulico típico: por encima del 85% el inyector no cierra de forma consistente',
      failureMode: 'Inyector saturado: la mezcla empobrece sin control'
    }
  ]
}

let importCounter = 0
const newId = (kind: string): string => `imported-${kind}-${Date.now()}-${importCounter++}`

export function buildImportedRod(input: ImportedPartInput, params: RodParams): RodPart {
  return {
    id: newId('rod'),
    kind: 'rod',
    name: input.name,
    source: 'imported',
    spec: {
      length: params.centerDistance,
      mass: input.metrics.volume * input.material.density
    },
    limits: deriveRodLimits(input, params)
  }
}

export function buildImportedPiston(input: ImportedPartInput, params: PistonParams): PistonPart {
  return {
    id: newId('piston'),
    kind: 'piston',
    name: input.name,
    source: 'imported',
    spec: {
      bore: params.bore,
      compressionHeight: params.compressionHeight,
      mass: input.metrics.volume * input.material.density,
      domeVolume: 0
    },
    limits: derivePistonLimits(input, params)
  }
}

export function buildImportedInjector(input: ImportedPartInput, params: InjectorParams): InjectorPart {
  return {
    id: newId('injector'),
    kind: 'injector',
    name: input.name,
    source: 'imported',
    spec: { staticFlow: params.staticFlow },
    limits: deriveInjectorLimits(input, params)
  }
}

/** Propuestas de parámetros a partir de la geometría, para que el usuario confirme. */
export function proposeParams(kind: ImportKind, g: GeometryMetrics): RodParams | PistonParams | InjectorParams {
  const dims = [g.bbox.x, g.bbox.y, g.bbox.z].sort((a, b) => b - a) as [number, number, number]
  switch (kind) {
    case 'rod':
      return { centerDistance: dims[0] * 0.8 }
    case 'piston':
      return { bore: dims[0], compressionHeight: dims[2] * 0.55 }
    case 'injector':
      return { channelDiameter: Math.max(0.002, g.minWallThickness), staticFlow: 5e-3 }
  }
}
