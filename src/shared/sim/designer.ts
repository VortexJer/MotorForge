import type {
  BlockPart, CrankPart, RodPart, PistonPart, HeadPart,
  EngineAssembly, DerivedLimit
} from './types'
import { ASPIRATIONS, COOLING, INJECTORS, FUEL_PUMPS } from './catalog'

/**
 * Diseñador de motores: convierte una ARQUITECTURA (cuántos cilindros, qué
 * calibre, qué carrera…) en un juego de piezas coherente que el resto de la
 * aplicación ya sabe simular.
 *
 * Hasta ahora solo se podía elegir entre las piezas del catálogo, y ahí solo
 * hay bloques de 4 cilindros y 86 mm: literalmente no había forma de hacer un
 * V8. La física NUNCA fue el problema — `buildArchetype` acepta de 1 a 16
 * cilindros y deriva órdenes de encendido y desfases de banco solo (ver su
 * cabecera). Lo que faltaba era la capa para AUTORIAR el motor.
 *
 * ─────────────────────── Los límites se DERIVAN ───────────────────────
 *
 * Siguiendo la misma regla que `archetype.ts` ("sin valores hardcodeados por
 * arquetipo"), aquí no hay tablas por tamaño de motor: cada límite sale de una
 * ley de escalado con su razón física, calibrada para REPRODUCIR el catálogo
 * existente en su punto de referencia (86 mm de calibre y de carrera). Así, si
 * diseñas exactamente el motor del catálogo, te salen sus mismos números.
 *
 *   · Cigüeñal → VELOCIDAD MEDIA DE PISTÓN CONSTANTE. Es el criterio clásico:
 *     lo que mata una muñequilla es la inercia alternativa, que va con
 *     vm = 2·carrera·rpm/60. El catálogo da 8400 rpm a 86 mm de carrera para
 *     un fundido, o sea 24,1 m/s; ese es el número que se conserva. Consecuencia
 *     directa y correcta: un motor de carrera larga corta antes.
 *
 *   · Biela → PANDEO DE EULER. La carga crítica va con I/L². Con secciones
 *     geométricamente semejantes que escalan con el calibre, I ∝ calibre⁴, así
 *     que la compresión admisible ∝ calibre⁴/L². La tracción, en cambio, es
 *     sección pura: ∝ calibre².
 *
 *   · Pistón y bloque → SEMEJANZA GEOMÉTRICA. En una corona de espesor
 *     proporcional al radio, la tensión depende de la presión pero NO del
 *     tamaño, así que el límite de presión no escala con el calibre. Lo que sí
 *     penaliza es un motor muy supercuadrado: a igualdad de todo, subir calibre
 *     y bajar carrera adelgaza el material entre cilindros y es donde revienta
 *     la junta de culata.
 *
 *   · Masas → SEMEJANZA GEOMÉTRICA: pistón ∝ calibre³, biela ∝ longitud·calibre².
 */

export type Layout = 'inline' | 'v' | 'boxer'
export type BlockMaterial = 'aluminio' | 'fundicion'
export type CrankType = 'fundido' | 'forjado' | 'billet'
export type PistonType = 'fundido' | 'forjado'
export type RodType = 'serie' | 'forjada'

export interface EngineDesign {
  name: string
  /** 1..16. La física no impone más límite que ese. */
  cylinders: number
  layout: Layout
  /** Ángulo de banco en GRADOS. Solo se usa con layout 'v'. */
  bankAngleDeg: number
  /** Calibre (m). */
  bore: number
  /** Carrera (m). */
  stroke: number
  /**
   * Relación biela/carrera (longitud entre centros ÷ carrera). Entre 1,4 y 2.
   * Por debajo de 1,5 el pistón acelera brutalmente y roza la camisa; por
   * encima de 1,9 el bloque se vuelve altísimo.
   */
  rodRatio: number
  /** Relación de compresión geométrica objetivo. */
  compressionRatio: number
  blockMaterial: BlockMaterial
  crankType: CrankType
  pistonType: PistonType
  rodType: RodType
  /** Id de la pieza de admisión del catálogo (atmosférica, turbo…). */
  aspirationId?: string
  coolingId?: string
  injectorId?: string
  fuelPumpId?: string
}

/** Punto de calibración: el motor del catálogo. Cambiarlo mueve TODO el escalado. */
const REF = {
  bore: 0.086,
  stroke: 0.086,
  rodLength: 0.139,
  rodMass: 0.57,
  pistonMass: 0.4,
  pistonCH: 0.03,
  chamber: 42e-6
} as const

/** Velocidad media de pistón admisible (m/s) por tipo de cigüeñal. */
const VM_MAX: Record<CrankType, number> = {
  // 8400 rpm × 86 mm del catálogo = 24,08 m/s
  fundido: 24.08,
  // 10200 rpm × 86 mm = 29,24 m/s
  forjado: 29.24,
  // billet de competición: no hay referencia en el catálogo, se extrapola
  billet: 33
}

export interface DesignDefaults {
  design: EngineDesign
}

/** Diseño de partida: el 2.0 de 4 cilindros del catálogo, para tener de dónde salir. */
export function defaultDesign(): EngineDesign {
  return {
    name: 'Motor sin nombre',
    cylinders: 4,
    layout: 'inline',
    bankAngleDeg: 90,
    bore: 0.086,
    stroke: 0.086,
    rodRatio: 0.139 / 0.086,
    compressionRatio: 10.5,
    blockMaterial: 'aluminio',
    crankType: 'forjado',
    pistonType: 'forjado',
    rodType: 'forjada'
  }
}

export function bankAngleRad(d: EngineDesign): number {
  if (d.layout === 'inline') return 0
  if (d.layout === 'boxer') return Math.PI
  return (d.bankAngleDeg * Math.PI) / 180
}

const mm = (m: number): string => (m * 1000).toFixed(1)

/** Nombre corto de la arquitectura: "V8", "L4", "B6". */
export function architectureLabel(d: EngineDesign): string {
  const p = d.layout === 'inline' ? 'L' : d.layout === 'boxer' ? 'B' : 'V'
  return `${p}${d.cylinders}`
}

// ---------------------------------------------------------------------------
// Piezas derivadas

function designedBlock(d: EngineDesign, deckHeight: number): BlockPart {
  const base = d.blockMaterial === 'aluminio' ? 150e5 : 230e5
  // Penalización por supercuadrado: cuanto más calibre para la misma carrera,
  // menos material queda entre cilindros y antes se va la junta de culata. Sin
  // penalización hasta 1,2 (un 2.0 normal está en 1,0).
  const rel = d.bore / d.stroke
  const castigo = rel > 1.2 ? Math.max(0.55, 1 - (rel - 1.2) * 0.45) : 1
  const peak = base * castigo

  const limits: DerivedLimit[] = [
    {
      variable: 'peakCylinderPressure',
      value: peak,
      provenance: 'derived-analytic',
      explanation:
        `Bloque de ${d.blockMaterial === 'aluminio' ? 'aluminio' : 'fundición'}: ` +
        `${(base / 1e5).toFixed(0)} bar de base` +
        (castigo < 1
          ? `, reducidos a ${(peak / 1e5).toFixed(0)} por relación calibre/carrera ${rel.toFixed(2)} ` +
            '(supercuadrado: queda menos material entre cilindros)'
          : ''),
      failureMode: 'Fisura de camisa / junta de culata'
    }
  ]
  return {
    id: `block-design-${d.cylinders}-${mm(d.bore)}`,
    kind: 'block',
    name: `Bloque ${architectureLabel(d)} ${mm(d.bore)} mm (${d.blockMaterial})`,
    source: 'imported',
    spec: { bore: d.bore, deckHeight, cylinders: d.cylinders },
    limits
  }
}

function designedCrank(d: EngineDesign): CrankPart {
  const vm = VM_MAX[d.crankType]
  const rpmMax = (vm * 60) / (2 * d.stroke)
  return {
    id: `crank-design-${mm(d.stroke)}`,
    kind: 'crank',
    name: `Cigüeñal ${d.crankType} ${mm(d.stroke)} mm`,
    source: 'imported',
    spec: { stroke: d.stroke },
    limits: [
      {
        variable: 'rpm',
        value: rpmMax,
        provenance: 'derived-analytic',
        explanation:
          `Velocidad media de pistón máxima de ${vm.toFixed(1)} m/s para un cigüeñal ` +
          `${d.crankType}; con ${mm(d.stroke)} mm de carrera eso son ${rpmMax.toFixed(0)} rpm. ` +
          'Más carrera, menos vueltas: la inercia alternativa es lo que rompe la muñequilla.',
        failureMode: 'Rotura de muñequilla por fatiga'
      }
    ]
  }
}

function designedRod(d: EngineDesign, rodLength: number): RodPart {
  const kBore = d.bore / REF.bore
  const kLen = rodLength / REF.rodLength
  const mass = REF.rodMass * kLen * kBore * kBore
  const refComp = d.rodType === 'serie' ? 68e3 : 130e3
  const refTens = d.rodType === 'serie' ? 29e3 : 55e3
  // Euler: la carga crítica va con I/L², e I con calibre⁴ por semejanza.
  const comp = refComp * (kBore ** 4) / (kLen * kLen)
  const tens = refTens * kBore * kBore

  return {
    id: `rod-design-${mm(rodLength)}`,
    kind: 'rod',
    name: `Biela ${d.rodType} ${mm(rodLength)} mm`,
    source: 'imported',
    spec: { length: rodLength, mass },
    limits: [
      {
        variable: 'rodCompression',
        value: comp,
        provenance: 'derived-analytic',
        explanation:
          `Pandeo de Euler: la carga crítica escala con I/L². Partiendo de ` +
          `${(refComp / 1e3).toFixed(0)} kN a ${mm(REF.rodLength)} mm y ${mm(REF.bore)} mm de calibre, ` +
          `esta biela de ${mm(rodLength)} mm aguanta ${(comp / 1e3).toFixed(0)} kN.`,
        failureMode: 'Pandeo de biela'
      },
      {
        variable: 'rodTension',
        value: tens,
        provenance: 'derived-analytic',
        explanation:
          `Tracción: sección pura, escala con el calibre². ${(tens / 1e3).toFixed(0)} kN. ` +
          'Es lo que se lleva la biela al soltar gas a alto régimen, no en la explosión.',
        failureMode: 'Rotura de biela por tracción'
      }
    ]
  }
}

function designedPiston(d: EngineDesign, compressionHeight: number): PistonPart {
  const kBore = d.bore / REF.bore
  const mass = REF.pistonMass * kBore ** 3
  const forjado = d.pistonType === 'forjado'
  return {
    id: `piston-design-${mm(d.bore)}`,
    kind: 'piston',
    name: `Pistón ${d.pistonType} ${mm(d.bore)} mm`,
    source: 'imported',
    spec: { bore: d.bore, compressionHeight, mass, domeVolume: 0 },
    limits: [
      {
        variable: 'peakCylinderPressure',
        value: forjado ? 200e5 : 125e5,
        provenance: 'derived-analytic',
        explanation:
          `Corona de pistón ${d.pistonType}. En una corona de espesor proporcional al radio la tensión ` +
          'depende de la presión pero no del tamaño, así que este límite NO cambia con el calibre.',
        failureMode: 'Corona perforada / falda agarrotada'
      },
      {
        variable: 'crownTemp',
        value: forjado ? 690 : 610,
        provenance: 'derived-analytic',
        explanation: `Temperatura de corona admisible en un pistón ${d.pistonType}.`,
        failureMode: 'Fusión de corona'
      },
      {
        variable: 'knockIndex',
        value: forjado ? 1.15 : 1.05,
        provenance: 'derived-analytic',
        explanation: 'Tolerancia a detonación antes de daño acumulado.',
        failureMode: 'Erosión de corona por detonación'
      }
    ]
  }
}

function designedHead(d: EngineDesign, chamberVolume: number, deckClearance: number, area: number): HeadPart {
  // La respiración escala con el régimen máximo alcanzable: un motor de carrera
  // corta gira más y su pico de VE se desplaza arriba. Se mueve la curva de
  // referencia con el mismo factor, en vez de dejarla clavada en un 2.0.
  const rpmRef = (VM_MAX[d.crankType] * 60) / (2 * REF.stroke)
  const rpmMax = (VM_MAX[d.crankType] * 60) / (2 * d.stroke)
  const k = rpmMax / rpmRef
  const base: Array<[number, number]> = [
    [1000, 0.72], [2000, 0.82], [3000, 0.9], [4000, 0.95],
    [5000, 0.97], [6000, 0.94], [7000, 0.88], [8000, 0.78]
  ]
  return {
    id: `head-design-${mm(d.bore)}`,
    kind: 'head',
    name: `Culata ${architectureLabel(d)} ${(chamberVolume * 1e6).toFixed(1)} cc`,
    source: 'imported',
    spec: {
      chamberVolume,
      veCurve: base.map(([rpm, ve]) => [Math.round(rpm * k), ve] as [number, number])
    },
    limits: [
      {
        variable: 'exhaustTemp',
        value: 1223,
        provenance: 'derived-analytic',
        explanation: 'Temperatura de escape admisible en asientos y guías.',
        failureMode: 'Quemado de válvula de escape'
      }
    ]
  }
}

export interface DesignResult {
  assembly: EngineAssembly
  /** Avisos del propio diseño (antes incluso de resolver compatibilidad). */
  warnings: string[]
  /** Cifras que le interesan a quien diseña, ya calculadas. */
  summary: {
    displacementL: number
    rodLength: number
    deckHeight: number
    chamberVolume: number
    rpmLimit: number
    meanPistonSpeedAtLimit: number
    architecture: string
  }
}

// DEBE coincidir con el de assembly.ts: si no, la compresion que pides no es
// la que sale al resolver el motor.
const HEAD_GASKET_THICKNESS = 0.0008

/**
 * Construye el motor. La cadena es: arquitectura → cotas derivadas → piezas.
 *
 * El bloque se dimensiona con deck CERO (pistón enrasado en PMS), que es lo que
 * hace un motor bien hecho y además lo que evita el aviso de "relación de
 * compresión muy baja" de `resolveEngine`. La cámara se calcula INVIRTIENDO la
 * fórmula de compresión de `assembly.ts`, para que la relación que pides sea
 * exactamente la que sale al resolver.
 */
export function buildDesign(d: EngineDesign): DesignResult {
  const warnings: string[] = []
  const rodLength = d.stroke * d.rodRatio
  const compressionHeight = REF.pistonCH * (d.bore / REF.bore)
  // Deck cero: altura de bloque = semicarrera + biela + altura de compresión.
  const deckHeight = d.stroke / 2 + rodLength + compressionHeight
  const area = (Math.PI / 4) * d.bore * d.bore
  const sweptPerCyl = area * d.stroke

  // Inversa de resolveEngine: Vc = Vd/(CR-1), y de ahí la cámara de la culata.
  const clearance = sweptPerCyl / (d.compressionRatio - 1)
  const chamberVolume = clearance - area * HEAD_GASKET_THICKNESS // deck = 0, domo = 0

  // La junta de culata ocupa volumen SIEMPRE, así que hay un techo de compresión
  // que no depende de lo buena que sea la culata: cuando la cámara que queda es
  // del orden de la junta, el motor no se puede construir aunque los números
  // cuadren. Se avisa por FRACCIÓN y no por un volumen fijo en cc, para que el
  // aviso valga igual en un 250 cc que en un V12 de 6 litros.
  const fraccionJunta = (area * HEAD_GASKET_THICKNESS) / clearance
  if (chamberVolume <= 0) {
    warnings.push(
      `Con ${d.compressionRatio.toFixed(1)}:1 la cámara sale negativa: para este calibre y carrera ` +
        'la junta de culata ya ocupa todo el volumen. Baja la compresión o sube la carrera.'
    )
  } else if (fraccionJunta > 0.33) {
    warnings.push(
      `Con ${d.compressionRatio.toFixed(1)}:1 la cámara queda en ${(chamberVolume * 1e6).toFixed(1)} cc ` +
        `y la junta de culata ya es el ${(fraccionJunta * 100).toFixed(0)}% del volumen muerto. ` +
        'No hay sitio material para las válvulas: es un motor que no se puede fabricar.'
    )
  }
  if (d.rodRatio < 1.5) {
    warnings.push(
      `Relación biela/carrera ${d.rodRatio.toFixed(2)}: muy corta. El pistón acelera mucho cerca del ` +
        'PMS y carga la falda contra la camisa.'
    )
  } else if (d.rodRatio > 1.9) {
    warnings.push(
      `Relación biela/carrera ${d.rodRatio.toFixed(2)}: muy larga. El bloque queda altísimo ` +
        `(${mm(deckHeight)} mm de altura de deck).`
    )
  }
  if (d.layout === 'v' && d.cylinders % 2 !== 0) {
    warnings.push(`Un V${d.cylinders} con cilindros impares deja un banco descompensado.`)
  }
  if (d.layout !== 'inline' && d.cylinders < 4) {
    warnings.push('Menos de 4 cilindros en V o bóxer no tiene mucho sentido mecánico.')
  }

  const crank = designedCrank(d)
  const rpmLimit = crank.limits.find((l) => l.variable === 'rpm')?.value ?? 0

  const pick = <T extends { id: string }>(arr: T[], id: string | undefined): T => {
    const found = id ? arr.find((p) => p.id === id) : undefined
    return found ?? arr[0]!
  }

  const assembly: EngineAssembly = {
    block: designedBlock(d, deckHeight),
    crank,
    rod: designedRod(d, rodLength),
    piston: designedPiston(d, compressionHeight),
    head: designedHead(d, Math.max(chamberVolume, 1e-9), 0, area),
    injector: pick(INJECTORS, d.injectorId),
    fuelPump: pick(FUEL_PUMPS, d.fuelPumpId),
    aspiration: pick(ASPIRATIONS, d.aspirationId),
    cooling: pick(COOLING, d.coolingId)
  }

  return {
    assembly,
    warnings,
    summary: {
      displacementL: sweptPerCyl * d.cylinders * 1000,
      rodLength,
      deckHeight,
      chamberVolume,
      rpmLimit,
      meanPistonSpeedAtLimit: (2 * d.stroke * rpmLimit) / 60,
      architecture: architectureLabel(d)
    }
  }
}
