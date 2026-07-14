/**
 * Contratos del núcleo de simulación. Todo en unidades SI:
 * m, kg, s, Pa, K, J, W, rad. Las unidades "de taller" (bar, CV, °C, RPM)
 * solo existen en la capa de presentación.
 */

export type PartKind =
  | 'block'
  | 'crank'
  | 'rod'
  | 'piston'
  | 'head'
  | 'injector'
  | 'aspiration'

export type Provenance = 'catalog' | 'derived-analytic' | 'derived-fea' | 'manual'

/** Variables sobre las que una pieza puede declarar un límite de fallo. */
export type LimitVariable =
  | 'peakCylinderPressure' // Pa — presión pico en cámara
  | 'rodCompression'       // N  — carga axial de compresión sobre la biela
  | 'rodTension'           // N  — carga axial de tracción sobre la biela
  | 'crownTemp'            // K  — temperatura de la corona del pistón
  | 'exhaustTemp'          // K  — temperatura de gases de escape (válvulas)
  | 'rpm'                  // rpm — régimen máximo del cigüeñal
  | 'boost'                // Pa (relativa) — presión máxima del sistema de admisión
  | 'injectorDuty'         // 0..1 — ciclo de trabajo máximo del inyector

export interface DerivedLimit {
  variable: LimitVariable
  value: number
  provenance: Provenance
  /** Fórmula o razón legible: de dónde sale este número. */
  explanation: string
  /** Modo de fallo humano: "pandeo de biela", "fusión de corona"... */
  failureMode: string
}

interface BasePart {
  id: string
  kind: PartKind
  name: string
  source: 'catalog' | 'imported'
  limits: DerivedLimit[]
}

export interface BlockPart extends BasePart {
  kind: 'block'
  spec: {
    bore: number        // m
    deckHeight: number  // m — eje de cigüeñal a plano de culata
    cylinders: number
  }
}

export interface CrankPart extends BasePart {
  kind: 'crank'
  spec: {
    stroke: number // m
  }
}

export interface RodPart extends BasePart {
  kind: 'rod'
  spec: {
    length: number // m — entre centros
    mass: number   // kg
  }
}

export interface PistonPart extends BasePart {
  kind: 'piston'
  spec: {
    bore: number              // m — debe casar con el bloque
    compressionHeight: number // m — eje de bulón a corona
    mass: number              // kg — con bulón y segmentos
    domeVolume: number        // m³ — positivo = cúpula (resta cámara), negativo = valle
  }
}

export interface HeadPart extends BasePart {
  kind: 'head'
  spec: {
    chamberVolume: number       // m³ por cilindro
    /** Eficiencia volumétrica vs RPM a plena carga: la "respiración" de la culata+levas. */
    veCurve: Array<[rpm: number, ve: number]>
  }
}

export interface InjectorPart extends BasePart {
  kind: 'injector'
  spec: {
    staticFlow: number // kg/s a duty 100%
  }
}

export interface AspirationPart extends BasePart {
  kind: 'aspiration'
  spec: {
    type: 'na' | 'turbo'
    /** Boost objetivo por defecto (Pa relativa). Ajustable desde la UI. */
    defaultBoost: number
    /** RPM a la que el turbo alcanza el boost objetivo. */
    spoolRpm: number
  }
}

export type Part =
  | BlockPart
  | CrankPart
  | RodPart
  | PistonPart
  | HeadPart
  | InjectorPart
  | AspirationPart

/** Selección de piezas: un slot por tipo (motor de un solo banco, v0). */
export interface EngineAssembly {
  block: BlockPart
  crank: CrankPart
  rod: RodPart
  piston: PistonPart
  head: HeadPart
  injector: InjectorPart
  aspiration: AspirationPart
}

export interface CompatIssue {
  severity: 'error' | 'warning'
  message: string
}

/** Geometría que emerge de las piezas elegidas. */
export interface ResolvedGeometry {
  bore: number
  stroke: number
  rodLength: number
  cylinders: number
  displacement: number      // m³ total
  clearanceVolume: number   // m³ por cilindro
  compressionRatio: number
  deckClearance: number     // m — pistón a plano de bloque en PMS
}

export interface ResolvedEngine {
  geometry: ResolvedGeometry
  assembly: EngineAssembly
  issues: CompatIssue[]
}

/** Ajustes que el usuario puede tocar en el banco (ECU-lite de la fase 1). */
export interface Tune {
  /** Lambda objetivo a plena carga (1 = estequiométrica, <1 = rica). */
  lambda: number
  /** Corte de inyección. */
  revLimit: number
  /** Boost objetivo (Pa relativa). Ignorado en motores atmosféricos. */
  boostTarget: number
  /** Corrección de avance de encendido sobre el mapa base (grados, +adelanta). */
  sparkTrim: number
}

export interface FuelSpec {
  name: string
  stoichAFR: number
  lhv: number     // J/kg
  density: number // kg/m³
}

/** Resultado de simular un punto de funcionamiento estacionario a plena carga. */
export interface OperatingPointResult {
  rpm: number
  torque: number            // Nm
  power: number             // W
  imep: number              // Pa (neta)
  bmep: number              // Pa
  fmep: number              // Pa
  peakPressure: number      // Pa
  peakPressureAngle: number // rad después de PMS
  peakGasTemp: number       // K
  exhaustTemp: number       // K
  crownTemp: number         // K
  manifoldPressure: number  // Pa absoluta
  boost: number             // Pa relativa
  rodCompression: number    // N
  rodTension: number        // N
  injectorDuty: number      // 0..1
  lambdaActual: number      // tras capar inyectores, si aplica
  fuelFlow: number          // kg/s total
  bsfc: number              // kg/J (presentar como g/kWh)
}

export interface SimEvent {
  severity: 'info' | 'warning' | 'failure'
  rpm: number
  partId: string
  partName: string
  failureMode: string
  variable: LimitVariable
  value: number
  limit: number
  /** Cadena causal legible, del ajuste del usuario al fallo. */
  causeChain: string[]
  /** Rendimiento justo antes/en el momento del evento. */
  state: { torque: number; power: number; rpm: number }
}

export interface DynoResult {
  points: OperatingPointResult[]
  events: SimEvent[]
  /** RPM en la que el motor rompió, si rompió. */
  failedAtRpm: number | null
  peakPower: { power: number; rpm: number }
  peakTorque: { torque: number; rpm: number }
}
