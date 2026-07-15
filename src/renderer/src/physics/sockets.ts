import * as THREE from 'three'
import type { ResolvedGeometry } from '@sim/types'

/**
 * Base de datos estructural de sockets (pliego §1A): posiciones de unión
 * 3D relativas al origen de cada pieza. Para las piezas de biblioteca se
 * GENERAN paramétricamente de la geometría real del ensamblaje (nada de
 * adivinar); para piezas importadas en el sandbox las coloca el usuario
 * con el Asistente de Sockets y viajan en este mismo formato.
 *
 * Convención de ejes por pieza (frames locales):
 *  - Bloque: origen en el eje del cigüeñal, Y hacia la culata, X a lo
 *    largo del cigüeñal, Z en el plano de oscilación de las bielas.
 *  - Cigüeñal: origen en su eje; las muñequillas orbitan en el plano YZ.
 *  - Biela: origen en su centro; +Y hacia el pie (bulón).
 *  - Pistón: origen en el eje del bulón; +Y hacia la corona.
 */

export interface BlockSockets {
  /** Apoyos de bancada del cigüeñal (uno por extremo). */
  mainBearings: [THREE.Vector3, THREE.Vector3]
  /** Centro de cada cilindro i en el plano de la bancada. */
  cylinders: THREE.Vector3[]
  /** Altura del plano de culata (deck) sobre el origen. */
  deckY: number
}

export interface CrankSockets {
  /** Eje central de rotación (muñones de bancada). */
  mainAxis: THREE.Vector3
  /** Muñequillas de biela: excéntricas a radio r, con su fase. */
  rodPins: Array<{ position: THREE.Vector3; phase: number }>
}

export interface RodSockets {
  /** Ojo superior (bulón). */
  smallEnd: THREE.Vector3
  /** Ojo inferior (muñequilla). */
  bigEnd: THREE.Vector3
}

export interface PistonSockets {
  /** Alojamiento del bulón. */
  pinBoss: THREE.Vector3
  /** Plano superior de la corona. */
  crownY: number
}

export interface EngineSockets {
  block: BlockSockets
  crank: CrankSockets
  rod: RodSockets
  piston: PistonSockets
  /** Separación entre cilindros (m escalados). */
  spacing: number
  /** Radio de muñequilla = carrera/2 (escalado). */
  crankRadius: number
  rodLength: number
  boreRadius: number
}

/** Fases de encendido de un I4 de plano de 180°. */
export const CRANK_PHASE = [0, Math.PI, Math.PI, 0]

/**
 * Genera el mapa de sockets desde la geometría real del ensamblaje.
 * `S` es la escala de escena (1 m → S unidades).
 */
export function buildSockets(g: ResolvedGeometry, S: number): EngineSockets {
  const spacing = g.bore * 1.3 * S
  const r = (g.stroke / 2) * S
  const l = g.rodLength * S
  const boreR = (g.bore / 2) * S
  const ch = 0.03 * S
  const deckY = r + l + ch
  const half = ((g.cylinders - 1) / 2) * spacing

  const cylX = (i: number): number => i * spacing - half

  return {
    block: {
      mainBearings: [new THREE.Vector3(-half - spacing * 0.6, 0, 0), new THREE.Vector3(half + spacing * 0.6, 0, 0)],
      cylinders: Array.from({ length: g.cylinders }, (_, i) => new THREE.Vector3(cylX(i), deckY, 0)),
      deckY
    },
    crank: {
      mainAxis: new THREE.Vector3(0, 0, 0),
      rodPins: Array.from({ length: g.cylinders }, (_, i) => {
        const phase = CRANK_PHASE[i] ?? 0
        return {
          // en el frame local del cigüeñal, la muñequilla i está a radio r
          // girada su fase alrededor de X
          position: new THREE.Vector3(cylX(i), r * Math.cos(phase), r * Math.sin(phase)),
          phase
        }
      })
    },
    rod: {
      smallEnd: new THREE.Vector3(0, l / 2, 0),
      bigEnd: new THREE.Vector3(0, -l / 2, 0)
    },
    piston: {
      pinBoss: new THREE.Vector3(0, 0, 0),
      crownY: ch
    },
    spacing,
    crankRadius: r,
    rodLength: l,
    boreRadius: boreR
  }
}

/**
 * Escalado paramétrico (pliego §1B): al cambiar la longitud de biela o el
 * área de sección, NO se regeneran mallas — solo matrices de transformación.
 */
export interface RodTuning {
  /** Longitud entre centros (m reales). */
  length: number
  /** Área de sección del brazo (m² reales). */
  area: number
}

/** escalaY = L_nueva / L_original; grosor visual ∝ √(A_nueva / A_original). */
export function rodScale(tuning: RodTuning, originalLength: number, originalArea: number): THREE.Vector3 {
  const sy = tuning.length / originalLength
  const st = Math.sqrt(tuning.area / originalArea)
  return new THREE.Vector3(st, sy, st)
}

/**
 * Sockets colocados a mano en el sandbox (pliego §2B). Coordenadas locales
 * de la malla importada, en el frame del lienzo del asistente.
 */
export interface CustomSockets {
  kind: 'rod' | 'piston' | 'block'
  /** biela: bulón; pistón: bulón; bloque: apoyo de bancada. */
  primary: THREE.Vector3
  /** biela: muñequilla; pistón: corona; bloque: centro del cilindro 1. */
  secondary: THREE.Vector3
}

/**
 * Alineación de mallas del sandbox (pliego §2C): devuelve posición y
 * cuaternión para que el socket `from` de la malla (local) coincida con el
 * punto global `target`, orientando su eje primario→secundario hacia `up`.
 */
export function alignToSocket(
  fromLocal: THREE.Vector3,
  axisLocal: THREE.Vector3,
  targetGlobal: THREE.Vector3,
  axisGlobal: THREE.Vector3
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    axisLocal.clone().normalize(),
    axisGlobal.clone().normalize()
  )
  const rotatedFrom = fromLocal.clone().applyQuaternion(quaternion)
  const position = targetGlobal.clone().sub(rotatedFrom)
  return { position, quaternion }
}
