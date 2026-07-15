/**
 * Matemáticas del laboratorio físico (pliego §4): fuerzas de inercia,
 * estrés de biela, pandeo de Euler, pernos de sombrerete, térmica con
 * dilatación y gripaje. Puro y determinista: se testea con vitest.
 *
 * Las fuerzas se calculan SIEMPRE con la velocidad angular REAL del motor;
 * Rapier gira la escena a una velocidad visual reducida (cámara lenta
 * automática) porque ningún integrador de cuerpos rígidos aguanta 8000 rpm
 * a 60 fps, pero la física de fallo no se entera de ese factor.
 */

export interface PhysMaterial {
  id: 'aluminio' | 'acero' | 'titanio'
  name: string
  youngModulus: number // Pa (pliego: Al 70 GPa, acero 210, Ti 115)
  yieldStrength: number // Pa
  density: number // kg/m³
  thermalExpansion: number // 1/K
}

export const PHYS_MATERIALS: Record<PhysMaterial['id'], PhysMaterial> = {
  aluminio: {
    id: 'aluminio',
    name: 'Aluminio forjado',
    youngModulus: 70e9,
    yieldStrength: 320e6,
    density: 2700,
    thermalExpansion: 23e-6
  },
  acero: {
    id: 'acero',
    name: 'Acero 4340',
    youngModulus: 210e9,
    yieldStrength: 850e6,
    density: 7850,
    thermalExpansion: 12e-6
  },
  titanio: {
    id: 'titanio',
    name: 'Titanio Ti-6Al-4V',
    youngModulus: 115e9,
    yieldStrength: 900e6,
    density: 4500,
    thermalExpansion: 8.6e-6
  }
}

/**
 * Fuerza de inercia alternativa del pistón (pliego §4A):
 * F = m·ω²·r·(cos θ + (r/L)·cos 2θ). Positiva hacia la culata en el PMS.
 */
export function inertiaForce(
  mPiston: number,
  omega: number,
  r: number,
  L: number,
  theta: number
): number {
  return mPiston * omega * omega * r * (Math.cos(theta) + (r / L) * Math.cos(2 * theta))
}

/** Fuerza de combustión sobre la corona: F = A_pistón · P_comb · throttle. */
export function combustionForce(pistonArea: number, pComb: number, throttle: number): number {
  return pistonArea * pComb * Math.min(Math.max(throttle, 0), 1)
}

/** Estrés axial de la biela (Pa): σ = |F| / A. */
export function rodStress(totalForce: number, rodArea: number): number {
  return Math.abs(totalForce) / Math.max(rodArea, 1e-9)
}

/**
 * Carga crítica de pandeo de Euler (pliego §4A): P_crit = π²·E·I / L².
 * I del brazo estimado desde el área con el mismo factor de forma del
 * derivador analítico: I ≈ 1.4·A²/4π.
 */
export function eulerCritical(E: number, rodArea: number, L: number): number {
  const I = (1.4 * rodArea * rodArea) / (4 * Math.PI)
  return (Math.PI * Math.PI * E * I) / (L * L)
}

/**
 * Tracción sobre los pernos del sombrerete en el cruce de PMS de escape:
 * la inercia de pistón+pie de biela tira del conjunto hacia arriba.
 * Devuelve el estrés por perno (Pa).
 */
export function boltStress(
  inertiaPull: number,
  boltCount: number,
  boltDiameter: number
): number {
  const area = Math.PI * (boltDiameter / 2) ** 2
  return Math.max(inertiaPull, 0) / (boltCount * area)
}

export type FailureMode = 'traccion' | 'pandeo' | 'pernos' | null

export interface StressCheck {
  sigma: number // Pa — estrés axial en biela
  sigmaLimit: number // Pa
  eulerLoad: number // N — carga de compresión actual
  eulerLimit: number // N
  boltSigma: number // Pa
  boltLimit: number // Pa
  failure: FailureMode
}

export interface StressInput {
  mPiston: number
  omega: number // rad/s REALES
  r: number
  rodLength: number
  rodArea: number
  material: PhysMaterial
  /** Presión de combustión efectiva en este instante (Pa, 0 fuera del PMS). */
  pComb: number
  pistonArea: number
  throttle: number // 0..1
  theta: number // rad — ángulo del cigüeñal de ESTE cilindro
  boltCount?: number
  boltDiameter?: number // m
  boltYield?: number // Pa
}

/** Chequeo completo de rotura del pliego §4A para un cilindro en un instante. */
export function checkStress(input: StressInput): StressCheck {
  const {
    mPiston,
    omega,
    r,
    rodLength,
    rodArea,
    material,
    pComb,
    pistonArea,
    throttle,
    theta,
    boltCount = 2,
    boltDiameter = 0.009,
    boltYield = 1.0e9
  } = input

  const fInertia = inertiaForce(mPiston, omega, r, rodLength, theta)
  const fComb = combustionForce(pistonArea, pComb, throttle)
  // Convención: compresión positiva sobre la biela (combustión empuja,
  // la inercia en el PMS tira hacia arriba = tracción)
  const fTotal = fComb - fInertia

  const sigma = rodStress(fTotal, rodArea)
  const sigmaLimit = material.yieldStrength

  const compression = Math.max(fTotal, 0)
  const eulerLimit = eulerCritical(material.youngModulus, rodArea, rodLength)

  // Pernos: solo trabaja la tracción (PMS de escape, sin presión que empuje)
  const tension = Math.max(-fTotal, 0)
  const bolts = boltStress(tension, boltCount, boltDiameter)

  let failure: FailureMode = null
  if (bolts > boltYield) failure = 'pernos'
  else if (compression > eulerLimit) failure = 'pandeo'
  else if (sigma > sigmaLimit) failure = 'traccion'

  return { sigma, sigmaLimit, eulerLoad: compression, eulerLimit, boltSigma: bolts, boltLimit: boltYield, failure }
}

// ---------------------------------------------------------------------------
// Térmica (pliego §4B)

export interface ThermalState {
  tMotor: number // K
}

export interface ThermalInput {
  rpm: number
  throttle: number // 0..1
  /** Presión media de cilindro (bar) para el término de calor generado. */
  pCylBar: number
  /** Caudales 0..1 (posición de las válvulas de agua/aceite de la UI). */
  waterFlow: number
  oilFlow: number
  tAmbient: number // K
  /** Masa térmica del motor × calor específico (J/K). */
  heatCapacity: number
  dt: number // s
}

/**
 * Coeficientes de disipación calibrados para que a plena carga (ΔQ_gen ≈
 * 540 kW con la fórmula del pliego) el motor cruce en ~88 °C con caudales
 * al 100%, y se dispare si se corta el agua.
 */
const WATER_COEFF = 7200 // W/K a caudal máximo (× 2.0 del pliego ya incluido)
const OIL_COEFF = 1400 // W/K a caudal máximo (× 1.2 del pliego ya incluido)

/**
 * Juego efectivo de pistón en frío como fracción del radio: el 0.6% cubre la
 * dilatación diferencial pistón-camisa hasta ~145 °C de agua; por encima,
 * gripa. (El pistón corre más caliente que el bloque: factor 2.2 en
 * hotPistonRadius.)
 */
export const PISTON_COLD_FACTOR = 0.994

/** Integra un paso del modelo térmico del pliego. Devuelve el nuevo estado. */
export function thermalStep(state: ThermalState, input: ThermalInput): ThermalState {
  const { rpm, throttle, pCylBar, waterFlow, oilFlow, tAmbient, heatCapacity, dt } = input
  // ΔQ_generado = RPM · Throttle · P_cil · 1.5  (W)
  const qGen = rpm * throttle * pCylBar * 1.5
  // ΔQ_disipado = caudal_agua·2.0·(T−T_amb) + caudal_aceite·1.2·(T−T_amb)
  const dT = state.tMotor - tAmbient
  const qDis = (waterFlow * WATER_COEFF + oilFlow * OIL_COEFF) * Math.max(dT, 0)
  const tMotor = Math.max(tAmbient, state.tMotor + ((qGen - qDis) / heatCapacity) * dt)
  return { tMotor }
}

export interface SeizureInput {
  pistonRadius: number // m — radio nominal en frío
  boreRadius: number // m
  tMotor: number // K
  tAmbient: number // K
  thermalExpansion: number // 1/K del material del pistón
}

/**
 * Dilatación térmica y gripaje (pliego §4B):
 * R_caliente = R_nominal·(1 + α·(T − T_amb)); gripa si R_caliente ≥ R_cilindro.
 * El pistón corre más caliente que la camisa: se aplica un factor 2.2 sobre
 * la temperatura media del motor para su dilatación diferencial.
 */
export function hotPistonRadius(input: SeizureInput): number {
  const dT = Math.max(input.tMotor - input.tAmbient, 0) * 2.2
  return input.pistonRadius * (1 + input.thermalExpansion * dT)
}

export function isSeized(input: SeizureInput): boolean {
  return hotPistonRadius(input) >= input.boreRadius
}
