import type { ResolvedGeometry } from '../types'

/**
 * EngineArchetype (Fase 2): el núcleo físico es CIEGO a si el motor es L4,
 * V6 o V12. Todo emerge de la geometría ensamblada: fases de encendido con
 * espaciado uniforme sobre el ciclo 4π, banco en V como desfase geométrico,
 * e inercias interpoladas de bore/stroke/masas por fórmula — sin valores
 * hardcodeados por arquetipo.
 */

export interface ArchetypeInput {
  geometry: ResolvedGeometry
  /** Masa alternativa por cilindro (pistón + bulón + pie de biela), kg. */
  reciprocatingMass: number
  /** Masa rotativa por cilindro (cabeza de biela), kg. */
  rotatingMassPerCyl: number
  /** Ángulo de banco en rad (0 = en línea). */
  bankAngle?: number
  /** Orden de encendido explícito (índices de cilindro); si falta, se genera. */
  firingOrder?: number[]
}

export interface EngineArchetype {
  readonly cylinders: number
  readonly bankAngle: number
  /** Orden de encendido (índices 0..n-1). */
  readonly firingOrder: Int32Array
  /** Desfase de ciclo (rad, sobre 4π) del cilindro i respecto al cigüeñal. */
  readonly cyclePhase: Float64Array
  /** Desfase geométrico del eje del cilindro i (rad) — bancos en V. */
  readonly bankOffset: Float64Array
  /** Inercia rotacional total del conjunto cigüeñal+volante (kg·m²). */
  readonly crankInertia: number
  /** Masa alternativa por cilindro (kg). */
  readonly reciprocatingMass: number
}

/**
 * Inercia del cigüeñal por fórmula (no tabla): muñequillas y contrapesos a
 * radio ~carrera/2 con masa proporcional a la rotativa por cilindro, más un
 * volante dimensionado con la cilindrada (los motores grandes llevan
 * volantes mayores para el mismo grado de irregularidad).
 */
export function crankInertiaFor(g: ResolvedGeometry, rotatingMassPerCyl: number): number {
  const r = g.stroke / 2
  // muñequillas + brazos + contrapesos ≈ 3× la masa rotativa efectiva a radio r
  const crankItself = g.cylinders * 3 * rotatingMassPerCyl * r * r
  // volante: disco de radio ~1.5·carrera, masa ∝ cilindrada (≈ 8 kg/L)
  const flyMass = 8 * (g.displacement * 1000)
  const flyRadius = 1.5 * g.stroke
  const flywheel = 0.5 * flyMass * flyRadius * flyRadius
  return crankItself + flywheel
}

export function buildArchetype(input: ArchetypeInput): EngineArchetype {
  const g = input.geometry
  const n = g.cylinders
  if (n < 1 || n > 16) throw new Error(`Arquetipo inválido: ${n} cilindros`)
  const bankAngle = input.bankAngle ?? 0

  // Orden de encendido: explícito o generado saltando en mitades (patrón
  // real de motores en línea: 1-3-4-2 para L4, 1-5-3-6-2-4 para L6…)
  const firing = new Int32Array(n)
  if (input.firingOrder) {
    if (input.firingOrder.length !== n) throw new Error('Orden de encendido incompleto')
    firing.set(input.firingOrder)
  } else if (n === 1) {
    firing[0] = 0
  } else {
    // recorre extremos alternos: reparte los pulsos a lo largo del cigüeñal
    let lo = 0
    let hi = n - 1
    for (let k = 0; k < n; k++) {
      firing[k] = k % 2 === 0 ? lo++ : hi--
    }
  }

  // Encendidos equiespaciados sobre el ciclo de 4 tiempos (4π)
  const cyclePhase = new Float64Array(n)
  const bankOffset = new Float64Array(n)
  const spacing = (4 * Math.PI) / n
  for (let k = 0; k < n; k++) {
    const cyl = firing[k]!
    cyclePhase[cyl] = k * spacing
    // en V: cilindros alternos en cada banco, desfasados el ángulo de banco
    bankOffset[cyl] = bankAngle > 0 ? (cyl % 2 === 0 ? -bankAngle / 2 : bankAngle / 2) : 0
  }

  return {
    cylinders: n,
    bankAngle,
    firingOrder: firing,
    cyclePhase,
    bankOffset,
    crankInertia: crankInertiaFor(g, input.rotatingMassPerCyl),
    reciprocatingMass: input.reciprocatingMass
  }
}
