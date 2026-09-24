/**
 * Escena de montaje: un motor descrito como GEOMETRÍA ANOTADA, sin catálogo.
 *
 * La idea de fondo: el núcleo físico no simula mallas, simula NÚMEROS (calibre,
 * carrera, longitud de biela, cilindros, fases de encendido). Así que el trabajo
 * de un montador 3D no es dibujar: es MEDIR. El usuario trae sus modelos, dice
 * qué es cada uno y clava unos pocos puntos; de la posición de esos puntos salen
 * los números. La carrera es el doble del radio de la muñequilla que marcaste;
 * la biela, la distancia entre sus dos ojos; el orden de encendido, las fases
 * angulares de las muñequillas alrededor del eje.
 *
 * Nada de esto se le pregunta al usuario en un formulario: se deduce de dónde
 * puso los marcadores. Por eso funciona igual con un motor inventado.
 *
 * Unidades: METROS y radianes, como todo el núcleo. La conversión desde las
 * unidades del archivo (los STL suelen venir en mm) se hace AL IMPORTAR.
 */

export type Vec3 = readonly [number, number, number]

/** Qué es una malla dentro del motor. Lo elige el usuario al importarla. */
export type PartRole =
  | 'block'
  | 'crank'
  | 'rod'
  | 'piston'
  | 'head'
  | 'injector'
  | 'sparkPlug'
  | 'starter'
  | 'sensor'
  /** Decorativa: se ve, no se simula (tapas, poleas, tubos). */
  | 'decor'

/**
 * Un punto con nombre sobre una malla, en COORDENADAS DE ESCENA (ya aplicada la
 * transformación de la pieza). Es lo que el usuario arrastra con el gizmo.
 */
export interface Marker {
  id: string
  position: Vec3
  /** Dirección asociada, si el marcador la necesita (chorro, eje, empuje). */
  direction?: Vec3
}

export interface ScenePart {
  id: string
  name: string
  role: PartRole
  /** Malla ya en metros y en coordenadas de escena. */
  mesh?: { positions: Float32Array; index?: Uint32Array }
  /** Densidad del material (kg/m³) para sacar la masa del volumen. */
  density?: number
  markers: Marker[]
  /**
   * A qué cilindro pertenece esta pieza (0..n-1). Lo necesitan bielas,
   * pistones, inyectores y bujías: sin esto no se sabe quién alimenta a quién.
   */
  cylinder?: number
}

export interface EngineScene {
  name: string
  parts: ScenePart[]
}

// ---------------------------------------------------------------------------
// Nombres de marcador que el medidor entiende. Son un CONTRATO: si el editor
// los escribe con otro nombre, la medición no encuentra nada y lo dice.

export const MARKER = {
  /** Cigüeñal: dos puntos del eje de bancada (definen la recta de giro). */
  crankAxisA: 'crank.axis.a',
  crankAxisB: 'crank.axis.b',
  /** Cigüeñal: centro de la muñequilla del cilindro i → 'crank.pin.0', .1… */
  crankPin: (i: number) => `crank.pin.${i}`,
  /** Biela: ojo pequeño (bulón) y ojo grande (muñequilla). */
  rodSmallEnd: 'rod.smallEnd',
  rodBigEnd: 'rod.bigEnd',
  /** Pistón: eje del bulón y punto más alto de la corona. */
  pistonPin: 'piston.pin',
  pistonCrown: 'piston.crown',
  /** Culata: un punto del plano de junta y su normal (hacia el bloque). */
  headDeck: 'head.deck',
  /** Inyector: punta del inyector y dirección del chorro. */
  injectorTip: 'injector.tip',
  /** Bujía: punto donde salta la chispa. */
  sparkGap: 'spark.gap',
  /** Motor de arranque: punto de engrane y dirección de empuje. */
  starterDrive: 'starter.drive'
} as const

// ---------------------------------------------------------------------------
// Álgebra mínima. Se evita depender de three aquí para que el medidor pueda
// correr headless en los tests y, más adelante, en un worker.

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
export const len = (a: Vec3): number => Math.sqrt(dot(a, a))
export const norm = (a: Vec3): Vec3 => {
  const l = len(a)
  return l < 1e-12 ? [0, 0, 0] : scale(a, 1 / l)
}

/** Componente de `v` perpendicular al eje unitario `u`. */
export const perp = (v: Vec3, u: Vec3): Vec3 => sub(v, scale(u, dot(v, u)))

/** Distancia de un punto a la recta (origen `p0`, dirección unitaria `u`). */
export const distToAxis = (p: Vec3, p0: Vec3, u: Vec3): number => len(perp(sub(p, p0), u))
