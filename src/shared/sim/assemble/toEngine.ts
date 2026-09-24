import type { EngineScene, Vec3 } from './scene'
import { MARKER, norm, sub, len, dot, perp } from './scene'
import { measureEngine } from './measure'
import type { EngineMeasurement } from './measure'
import { measureChamber, compressionFrom } from './chamber'
import type { ResolvedGeometry } from '../types'
import { buildArchetype } from '../hil/archetype'
import type { CoreConfig } from '../hil/engineCore'
import type { EcuCalib } from '../hil/ecu'
import { buildDesign, defaultDesign } from '../designer'
import type { EngineDesign, BlockMaterial, CrankType, PistonType, RodType } from '../designer'
import type { EngineAssembly } from '../types'
import { readSemantics } from './semantics'
import type { SemanticEffects } from './semantics'
import type { EngineArchetype } from '../hil/archetype'

/**
 * El puente: convierte un montaje anotado en algo que el HIL puede ARRANCAR.
 *
 * Aquí se cierra el círculo del montador. Todo lo anterior medía piezas sueltas;
 * esto junta las medidas, saca la compresión de la cámara voxelizada y produce
 * la geometría resuelta más el arquetipo (fases de encendido incluidas) que
 * `SimCore` consume.
 *
 * Sigue mandando la misma regla: si falta algo, se dice. Un motor a medio anotar
 * NO se completa con supuestos, porque una simulación que corre con parámetros
 * inventados da resultados creíbles y falsos, que es el peor de los mundos.
 */

export interface AssembledEngine {
  geometry: ResolvedGeometry
  archetype: EngineArchetype
  measurement: EngineMeasurement
  /** Volumen de cámara medido (m³) y de dónde salió. */
  chamberVolume: number
  /** Piezas semánticas encontradas, para que la UI diga qué se va a simular. */
  semantica: {
    inyectoresPorCilindro: number[]
    bujiasPorCilindro: number[]
    tieneArranque: boolean
    sensores: number
  }
  /** Consecuencias físicas de DÓNDE están los marcadores. */
  efectos: SemanticEffects
  listo: boolean
  /** Por qué NO está listo, en lenguaje de taller. */
  problemas: string[]
}

/** Eje del cilindro: del bulón a la corona del primer pistón marcado. */
function ejeCilindro(scene: EngineScene): { origen: Vec3; dir: Vec3 } | null {
  for (const p of scene.parts) {
    if (p.role !== 'piston') continue
    const pin = p.markers.find((m) => m.id === MARKER.pistonPin)?.position
    const crown = p.markers.find((m) => m.id === MARKER.pistonCrown)?.position
    if (pin && crown && len(sub(crown, pin)) > 1e-5) {
      return { origen: crown, dir: norm(sub(crown, pin)) }
    }
  }
  return null
}

export function assembleEngine(scene: EngineScene): AssembledEngine {
  const m = measureEngine(scene)
  const problemas: string[] = m.fallos.map((f) => `${f.motivo} ${f.arregla}`)

  // ---------------------------------------------------------------- semántica
  const porCil = (rol: string): number[] => {
    const out: number[] = []
    for (const p of scene.parts) {
      if (p.role !== rol) continue
      out.push(p.cylinder ?? -1)
    }
    return out
  }
  const inyectores = porCil('injector')
  const bujias = porCil('sparkPlug')
  const semantica = {
    inyectoresPorCilindro: inyectores,
    bujiasPorCilindro: bujias,
    tieneArranque: scene.parts.some((p) => p.role === 'starter'),
    sensores: scene.parts.filter((p) => p.role === 'sensor').length
  }

  if (m.cylinders > 0) {
    if (inyectores.length === 0) {
      problemas.push('No hay ningún inyector marcado: el motor no tendría cómo recibir combustible.')
    } else if (inyectores.length < m.cylinders) {
      problemas.push(
        `Hay ${inyectores.length} inyectores para ${m.cylinders} cilindros. Falta marcar los demás.`
      )
    }
    if (bujias.length === 0) {
      problemas.push('No hay ninguna bujía marcada: no habría chispa que encienda la mezcla.')
    }
    if (inyectores.some((c) => c < 0) || bujias.some((c) => c < 0)) {
      problemas.push(
        'Hay inyectores o bujías sin cilindro asignado. Sin eso no se sabe a quién alimentan.'
      )
    }
    if (!semantica.tieneArranque) {
      problemas.push('No hay motor de arranque marcado: el motor no podría girar para arrancar.')
    }
  }

  // ------------------------------------------------------------------ cámara
  let chamberVolume = NaN
  const head = scene.parts.find((p) => p.role === 'head' && p.mesh)
  const eje = ejeCilindro(scene)
  if (!head) {
    problemas.push('No hay ninguna malla marcada como culata: sin ella no se puede medir la cámara.')
  } else if (!eje) {
    problemas.push('Falta marcar el bulón y la corona de un pistón para saber por dónde va el cilindro.')
  } else if (m.bore <= 0) {
    problemas.push('Sin calibre medido no se puede acotar la cámara.')
  } else {
    const r = measureChamber({
      headPositions: head.mesh!.positions,
      crownCenter: eje.origen,
      axis: eje.dir,
      bore: m.bore
    })
    if (!r.ok) problemas.push(r.motivo ?? 'No se pudo medir la cámara.')
    else if (!(r.volume > 0)) {
      // Dos causas MUY distintas dan el mismo cero, y confundirlas manda al
      // usuario a mover una culata que ya está donde tiene que estar. Se
      // distinguen por la ocupación del muestreo justo encima de la corona.
      if (r.ocupacion > 0.9) {
        problemas.push(
          'La culata es maciza justo encima del pistón: este modelo no tiene la cámara de ' +
            'combustión vaciada, es solo el contorno exterior. Modela el hueco de la cámara ' +
            '(y los asientos de válvula) o mete la cámara a mano en cc.'
        )
      } else if (r.ocupacion < 0.1) {
        problemas.push(
          'Encima del pistón no hay culata: no está colocada sobre el cilindro. Muévela hasta ' +
            'que apoye en el plano de junta.'
        )
      } else {
        problemas.push(
          `La cámara medida sale vacía con una ocupación del ${(r.ocupacion * 100).toFixed(0)}%. ` +
            'Revisa la posición de la culata respecto a la corona del pistón.'
        )
      }
    } else chamberVolume = r.volume
  }

  // -------------------------------------------------------- geometría y motor
  const swept = m.bore > 0 && m.stroke > 0 ? (Math.PI / 4) * m.bore * m.bore * m.stroke : 0
  const compressionRatio = chamberVolume > 0 ? compressionFrom(m.bore, m.stroke, chamberVolume) : NaN

  const geometry: ResolvedGeometry = {
    bore: m.bore,
    stroke: m.stroke,
    rodLength: m.rodLength,
    cylinders: m.cylinders,
    displacement: swept * m.cylinders,
    clearanceVolume: chamberVolume,
    compressionRatio,
    deckClearance: 0
  }

  // Ángulo de banco: se DEDUCE de los ejes de cilindro de los pistones. Si todos
  // apuntan igual, es en línea; si hay dos familias, es un V y el ángulo es el
  // que las separa. Nadie tiene que decirlo en un desplegable.
  let bankAngle = 0
  const ejes: Vec3[] = []
  for (const p of scene.parts) {
    if (p.role !== 'piston') continue
    const pin = p.markers.find((k) => k.id === MARKER.pistonPin)?.position
    const cr = p.markers.find((k) => k.id === MARKER.pistonCrown)?.position
    if (pin && cr && len(sub(cr, pin)) > 1e-5) ejes.push(norm(sub(cr, pin)))
  }
  if (ejes.length > 1) {
    let maxAng = 0
    for (let i = 1; i < ejes.length; i++) {
      const c = Math.min(1, Math.max(-1, dot(ejes[0]!, ejes[i]!)))
      maxAng = Math.max(maxAng, Math.acos(c))
    }
    if (maxAng > 0.05) bankAngle = maxAng
  }

  let archetype: EngineArchetype | null = null
  if (m.cylinders >= 1 && m.stroke > 0) {
    try {
      archetype = buildArchetype({
        geometry,
        reciprocatingMass: (m.pistonMass ?? 0.4) + (m.rodMass ?? 0.55) * 0.3,
        rotatingMassPerCyl: (m.rodMass ?? 0.55) * 0.7,
        bankAngle,
        // El orden de encendido sale de las fases MEDIDAS del cigüeñal, no de
        // una tabla por arquitectura: es lo que permite simular un motor que
        // nadie ha fabricado nunca.
        firingOrder: m.firingOrder.length === m.cylinders ? m.firingOrder : undefined
      })
    } catch (e) {
      problemas.push(`No se pudo construir el motor: ${(e as Error).message}`)
    }
  }

  const listo =
    problemas.length === 0 &&
    archetype !== null &&
    Number.isFinite(compressionRatio) &&
    compressionRatio > 4 &&
    compressionRatio < 30

  if (Number.isFinite(compressionRatio) && (compressionRatio <= 4 || compressionRatio >= 30)) {
    problemas.push(
      `La compresión medida sale ${compressionRatio.toFixed(1)}:1, que no es un motor viable. ` +
        'Revisa que la culata esté bien apoyada y que la corona del pistón esté marcada en PMS.'
    )
  }

  const coronas: Vec3[] = []
  for (const p of scene.parts) {
    if (p.role !== 'piston') continue
    const c = p.markers.find((k) => k.id === MARKER.pistonCrown)?.position
    if (c) coronas.push(c)
  }
  const efectos = readSemantics(
    scene,
    eje && m.bore > 0 ? { corona: eje.origen, eje: eje.dir, calibre: m.bore } : null,
    coronas
  )
  problemas.push(...efectos.avisos)

  return {
    geometry,
    efectos,
    archetype: archetype ?? buildArchetype({
      geometry: { ...geometry, cylinders: Math.max(1, m.cylinders), stroke: Math.max(1e-3, m.stroke) },
      reciprocatingMass: 0.4, rotatingMassPerCyl: 0.35
    }),
    measurement: m,
    chamberVolume,
    semantica,
    listo,
    problemas
  }
}

// ---------------------------------------------------------------------------
// De motor medido a motor EN MARCHA.

export interface RunnableEngine {
  core: CoreConfig
  calib: EcuCalib
  /** Cosas que NO salen de la geometría y se han estimado. Se enseñan. */
  supuestos: string[]
}

/**
 * Convierte un motor montado en algo arrancable.
 *
 * Aquí hay que ser explícito con una cosa: **no todo sale de la geometría**. Dos
 * parámetros son de comportamiento, no de forma, y ninguna malla los contiene:
 *
 *  - La RESPIRACIÓN de la culata (curva de eficiencia volumétrica). Depende de
 *    conductos, levas y válvulas. Se puede intuir del tamaño, pero no medir de
 *    un sólido exterior.
 *  - El CAUDAL DE INYECTOR. Un inyector es una pieza con un número grabado, no
 *    una forma que se pueda medir.
 *
 * Se estiman con criterio y se DEVUELVEN COMO SUPUESTOS, para que en pantalla se
 * vea qué es medido y qué es estimado. Un motor que arranca con supuestos
 * ocultos es la trampa que este proyecto lleva evitando desde el principio.
 */
export function toRunnable(
  e: AssembledEngine,
  fuel: { stoichAFR: number; lhv: number },
  ambiente = { p: 101325, t: 298, humedad: 0.4 }
): RunnableEngine {
  const supuestos: string[] = []
  const g = e.geometry

  // Régimen máximo por velocidad media de pistón: el mismo criterio que el
  // diseñador. 25 m/s es lo que aguanta un conjunto de calle bien hecho.
  const rpmMax = g.stroke > 0 ? (25 * 60) / (2 * g.stroke) : 7000

  // Respiración: campana centrada donde el motor puede girar. Un motor de
  // carrera corta gira más y su pico se desplaza arriba con él.
  const pico = rpmMax * 0.7
  const veCurve: Array<[number, number]> = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05, 1.2]
    .map((f) => {
      const rpm = Math.round(pico * f)
      const d = (rpm - pico) / pico
      return [rpm, Math.max(0.55, 0.97 - 1.1 * d * d)] as [number, number]
    })
  // Efectos de la SEMÁNTICA: inyectar dentro del cilindro enfría la carga y
  // densifica la admisión; la bujía descentrada recorta el avance admisible.
  const kLlenado = e.efectos.factorLlenado
  for (let i = 0; i < veCurve.length; i++) veCurve[i]![1] = Math.min(1.15, veCurve[i]![1] * kLlenado)
  for (const x of e.efectos.efectos) supuestos.push(x)

  supuestos.push(
    `Respiración de la culata estimada: pico de llenado a ${Math.round(pico)} rpm. ` +
      'No se puede medir de una malla; depende de conductos, levas y válvulas.'
  )

  // Caudal de inyector: el que hace falta para alimentar el motor a plena
  // carga. Aire por ciclo = cilindrada × densidad × VE; combustible = aire/AFR.
  // Se dimensiona al 80% de servicio, que es como se elige un inyector real.
  const densidadAire = ambiente.p / (287 * ambiente.t)
  const aireCiclo = g.displacement * densidadAire * 0.95
  const ciclosPorSeg = rpmMax / 120 // 4 tiempos: una admisión cada 2 vueltas
  const combustiblePorSeg = (aireCiclo * ciclosPorSeg) / fuel.stoichAFR
  const injectorFlow = (combustiblePorSeg / Math.max(1, g.cylinders)) / 0.8
  supuestos.push(
    `Inyectores estimados en ${(injectorFlow * 1000).toFixed(2)} g/s cada uno, ` +
      'dimensionados para alimentar esta cilindrada al 80% de servicio a plena carga.'
  )

  if (!Number.isFinite(g.compressionRatio)) {
    supuestos.push(
      'La compresión no se ha podido medir, así que el motor arrancará con la geometría ' +
        'que sí se midió pero su rendimiento no será representativo.'
    )
  }

  const core: CoreConfig = {
    geometry: g,
    archetype: e.archetype,
    veCurve,
    fuel,
    injectorFlow,
    injectorDutyMax: 0.85,
    turbo: { inertia: 6e-5, present: false },
    ambientP: ambiente.p,
    ambientT: ambiente.t,
    humidity: ambiente.humedad
  }

  const calib: EcuCalib = {
    idleRpm: Math.max(600, Math.round(rpmMax * 0.12)),
    revLimit: Math.round(rpmMax * 0.9),
    lambdaBase: 1,
    lambdaWotDrop: 0.14,
    advIdle: 0.17,
    advMax: 0.56 * e.efectos.factorAvance,
    advAtRpm: Math.round(pico),
    veEst: veCurve,
    injectorFlow,
    injectorDutyMax: 0.85,
    stoichAFR: fuel.stoichAFR,
    boostTarget: 0
  }

  return { core, calib, supuestos }
}

/**
 * Convierte el motor montado en un ENSAMBLAJE de piezas, para que el banco de
 * potencia, el desgaste y los proyectos lo traten como a cualquier otro motor.
 *
 * Reutiliza a propósito las leyes de escalado del diseñador (`buildDesign`) en
 * vez de repetirlas: así un motor MEDIDO y uno DISEÑADO con las mismas cotas
 * reciben exactamente los mismos límites, y no hay dos fuentes de verdad sobre
 * cuánto aguanta una biela.
 *
 * Lo que se mide PISA a lo que se estima: las masas salen del volumen real de tu
 * malla, no de la ley de semejanza, y la cámara de la voxelización, no de
 * invertir una compresión objetivo.
 */
export function toAssembly(
  e: AssembledEngine,
  materiales?: {
    blockMaterial?: BlockMaterial; crankType?: CrankType
    pistonType?: PistonType; rodType?: RodType
  }
): { assembly: EngineAssembly; avisos: string[] } {
  const g = e.geometry
  const avisos: string[] = []
  if (!(g.bore > 0 && g.stroke > 0 && g.rodLength > 0 && g.cylinders > 0)) {
    avisos.push('Faltan cotas por medir: el motor llegará al banco incompleto.')
  }

  const cr = Number.isFinite(g.compressionRatio) ? g.compressionRatio : 10.5
  if (!Number.isFinite(g.compressionRatio)) {
    avisos.push('La compresión no se midió; se usa 10,5:1 para poder llevarlo al banco.')
  }

  const d: EngineDesign = {
    ...defaultDesign(),
    name: 'Motor montado',
    cylinders: Math.max(1, g.cylinders),
    layout: e.archetype.bankAngle > 0.05 ? 'v' : 'inline',
    bankAngleDeg: (e.archetype.bankAngle * 180) / Math.PI,
    bore: g.bore > 0 ? g.bore : 0.086,
    stroke: g.stroke > 0 ? g.stroke : 0.086,
    rodRatio: g.stroke > 0 ? g.rodLength / g.stroke : 1.6,
    compressionRatio: Math.min(16, Math.max(6, cr)),
    blockMaterial: materiales?.blockMaterial ?? 'aluminio',
    crankType: materiales?.crankType ?? 'forjado',
    pistonType: materiales?.pistonType ?? 'forjado',
    rodType: materiales?.rodType ?? 'forjada'
  }
  const { assembly, warnings } = buildDesign(d)
  avisos.push(...warnings)

  // Lo MEDIDO manda sobre lo estimado.
  const m = e.measurement
  if (m.pistonMass && m.pistonMass > 0) {
    assembly.piston = { ...assembly.piston, spec: { ...assembly.piston.spec, mass: m.pistonMass } }
  }
  if (m.rodMass && m.rodMass > 0) {
    assembly.rod = { ...assembly.rod, spec: { ...assembly.rod.spec, mass: m.rodMass } }
  }
  if (e.chamberVolume > 0) {
    assembly.head = {
      ...assembly.head,
      spec: { ...assembly.head.spec, chamberVolume: e.chamberVolume }
    }
  }
  // Identificadores propios para que no pisen a los del catálogo ni a los de un
  // diseño anterior al mezclarse en la lista de piezas importadas.
  const sufijo = `montaje-${Math.round(g.bore * 1e4)}-${Math.round(g.stroke * 1e4)}-${g.cylinders}`
  assembly.block = { ...assembly.block, id: `block-${sufijo}`, name: `Bloque montado ${g.cylinders} cil` }
  assembly.crank = { ...assembly.crank, id: `crank-${sufijo}` }
  assembly.rod = { ...assembly.rod, id: `rod-${sufijo}` }
  assembly.piston = { ...assembly.piston, id: `piston-${sufijo}` }
  assembly.head = { ...assembly.head, id: `head-${sufijo}` }

  return { assembly, avisos }
}
