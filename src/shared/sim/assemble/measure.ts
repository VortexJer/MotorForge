import {
  MARKER, distToAxis, dot, cross, len, norm, perp, sub, scale
} from './scene'
import type { EngineScene, ScenePart, Vec3 } from './scene'

/**
 * El medidor: convierte una escena anotada en los números que el HIL simula.
 *
 * Regla de oro: si algo no se puede medir, se DICE, no se inventa. Un motor a
 * medio anotar tiene que dar un informe con lo que falta y por qué, no un
 * conjunto de parámetros plausibles pero falsos — eso último sería peor que
 * fallar, porque la simulación correría y daría resultados creíbles y erróneos.
 */

export interface Medicion {
  campo: string
  valor: number
  unidad: string
  /** De dónde ha salido: qué marcadores o qué malla. */
  origen: string
}

export interface Fallo {
  campo: string
  motivo: string
  /** Qué tiene que hacer el usuario para arreglarlo. */
  arregla: string
}

export interface EngineMeasurement {
  /** Parámetros listos para el núcleo. Solo son de fiar si `fallos` está vacío. */
  bore: number
  stroke: number
  rodLength: number
  cylinders: number
  /** Fase angular de cada muñequilla alrededor del eje (rad, 0..2π). */
  pinPhases: number[]
  /** Orden de encendido deducido de las fases (índices de cilindro). */
  firingOrder: number[]
  /** Masas medidas del volumen de la malla, si había densidad. */
  pistonMass: number | null
  rodMass: number | null
  mediciones: Medicion[]
  fallos: Fallo[]
  avisos: string[]
}

const porRol = (s: EngineScene, rol: ScenePart['role']): ScenePart[] =>
  s.parts.filter((p) => p.role === rol)

const marcador = (p: ScenePart, id: string): Vec3 | null =>
  p.markers.find((m) => m.id === id)?.position ?? null

/** Volumen con signo de una malla cerrada (suma de tetraedros al origen). */
export function meshVolume(positions: Float32Array, index?: Uint32Array): number {
  let v = 0
  const tri = (ia: number, ib: number, ic: number): void => {
    const ax = positions[ia * 3]!, ay = positions[ia * 3 + 1]!, az = positions[ia * 3 + 2]!
    const bx = positions[ib * 3]!, by = positions[ib * 3 + 1]!, bz = positions[ib * 3 + 2]!
    const cx = positions[ic * 3]!, cy = positions[ic * 3 + 1]!, cz = positions[ic * 3 + 2]!
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
  }
  if (index) {
    for (let i = 0; i < index.length; i += 3) tri(index[i]!, index[i + 1]!, index[i + 2]!)
  } else {
    const n = positions.length / 3
    for (let i = 0; i + 2 < n; i += 3) tri(i, i + 1, i + 2)
  }
  return Math.abs(v)
}

/**
 * Diámetro de una malla medido PERPENDICULARMENTE a un eje.
 *
 * Se usa para sacar el calibre del propio pistón, en vez de preguntarlo. Se
 * toma el percentil 98 del radio y no el máximo: un solo vértice suelto (o una
 * rebaba de la malla) inflaría el calibre, y un pistón real tiene además
 * chaflanes y ranuras de segmento que NO son el diámetro nominal.
 */
export function diameterAcrossAxis(
  positions: Float32Array, axisPoint: Vec3, axisDir: Vec3
): number {
  const u = norm(axisDir)
  const n = positions.length / 3
  if (n === 0) return 0
  const radios = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]
    radios[i] = len(perp(sub(p, axisPoint), u))
  }
  radios.sort()
  const idx = Math.min(n - 1, Math.floor(n * 0.98))
  return 2 * radios[idx]!
}

/** Ángulo de un punto alrededor de un eje, en [0, 2π). */
function faseAlrededorDeEje(p: Vec3, ejeP: Vec3, ejeU: Vec3, ref: Vec3): number {
  const r = perp(sub(p, ejeP), ejeU)
  const x = dot(r, ref)
  const y = dot(r, cross(ejeU, ref))
  const a = Math.atan2(y, x)
  return a < 0 ? a + 2 * Math.PI : a
}

export function measureEngine(scene: EngineScene): EngineMeasurement {
  const mediciones: Medicion[] = []
  const fallos: Fallo[] = []
  const avisos: string[] = []
  const anota = (campo: string, valor: number, unidad: string, origen: string): number => {
    mediciones.push({ campo, valor, unidad, origen })
    return valor
  }

  const cranks = porRol(scene, 'crank')
  const rods = porRol(scene, 'rod')
  const pistons = porRol(scene, 'piston')

  // ---------------------------------------------------------------- cilindros
  const cylinders = pistons.length
  if (cylinders === 0) {
    fallos.push({
      campo: 'cylinders',
      motivo: 'No hay ninguna malla marcada como pistón.',
      arregla: 'Importa el pistón y márcalo con el rol "pistón". Uno por cilindro.'
    })
  } else {
    anota('cylinders', cylinders, '', `${cylinders} mallas con rol pistón`)
  }
  if (rods.length !== cylinders && cylinders > 0) {
    avisos.push(
      `Hay ${pistons.length} pistones pero ${rods.length} bielas. Cada cilindro necesita la suya.`
    )
  }

  // -------------------------------------------------------- eje del cigüeñal
  let ejeP: Vec3 | null = null
  let ejeU: Vec3 | null = null
  const crank = cranks[0] ?? null
  if (!crank) {
    fallos.push({
      campo: 'crankAxis',
      motivo: 'No hay ninguna malla marcada como cigüeñal.',
      arregla: 'Importa el cigüeñal y márcalo con el rol "cigüeñal".'
    })
  } else {
    const a = marcador(crank, MARKER.crankAxisA)
    const b = marcador(crank, MARKER.crankAxisB)
    if (!a || !b) {
      fallos.push({
        campo: 'crankAxis',
        motivo: 'El cigüeñal no tiene marcados los dos puntos de su eje de giro.',
        arregla: `Coloca "${MARKER.crankAxisA}" y "${MARKER.crankAxisB}" en los muñones de bancada de cada extremo.`
      })
    } else if (len(sub(b, a)) < 1e-4) {
      fallos.push({
        campo: 'crankAxis',
        motivo: 'Los dos puntos del eje del cigüeñal están casi en el mismo sitio.',
        arregla: 'Sepáralos: uno en cada extremo del cigüeñal, para que definan bien la recta.'
      })
    } else {
      ejeP = a
      ejeU = norm(sub(b, a))
    }
  }

  // -------------------------------------------------------- carrera y fases
  let stroke = 0
  const pinPhases: number[] = []
  if (crank && ejeP && ejeU) {
    const radios: number[] = []
    // Referencia angular estable: la perpendicular al eje que más lejos cae del
    // eje entre las propias muñequillas. Así las fases no dependen de en qué
    // sistema de coordenadas venga el modelo.
    let ref: Vec3 | null = null
    for (let i = 0; i < cylinders; i++) {
      const pin = marcador(crank, MARKER.crankPin(i))
      if (!pin) continue
      const r = perp(sub(pin, ejeP), ejeU)
      if (len(r) > 1e-5 && !ref) ref = norm(r)
    }
    if (!ref) {
      fallos.push({
        campo: 'stroke',
        motivo: 'No hay ninguna muñequilla marcada fuera del eje del cigüeñal.',
        arregla: `Coloca "${MARKER.crankPin(0)}" en el centro de la muñequilla del cilindro 1.`
      })
    } else {
      for (let i = 0; i < cylinders; i++) {
        const pin = marcador(crank, MARKER.crankPin(i))
        if (!pin) {
          fallos.push({
            campo: `crank.pin.${i}`,
            motivo: `Falta la muñequilla del cilindro ${i + 1}.`,
            arregla: `Coloca "${MARKER.crankPin(i)}" en el centro de esa muñequilla.`
          })
          continue
        }
        radios.push(distToAxis(pin, ejeP, ejeU))
        pinPhases.push(faseAlrededorDeEje(pin, ejeP, ejeU, ref))
      }
      if (radios.length > 0) {
        const rMedio = radios.reduce((s, r) => s + r, 0) / radios.length
        const disp = Math.max(...radios) - Math.min(...radios)
        // Un cigüeñal real tiene todas las muñequillas al MISMO radio. Si no,
        // o el modelo es raro o los marcadores están mal puestos: se avisa en
        // vez de promediar en silencio.
        if (rMedio > 1e-6 && disp / rMedio > 0.02) {
          avisos.push(
            `Las muñequillas no están todas al mismo radio (${(disp * 1000).toFixed(1)} mm de diferencia). ` +
              'Se usa el promedio, pero revisa los marcadores.'
          )
        }
        stroke = anota('stroke', 2 * rMedio, 'm', 'doble del radio medio de las muñequillas marcadas')
      }
    }
  }

  // --------------------------------------------------------- longitud de biela
  let rodLength = 0
  if (rods.length === 0) {
    fallos.push({
      campo: 'rodLength',
      motivo: 'No hay ninguna malla marcada como biela.',
      arregla: 'Importa la biela y márcala con el rol "biela".'
    })
  } else {
    const largos: number[] = []
    for (const r of rods) {
      const s = marcador(r, MARKER.rodSmallEnd)
      const b = marcador(r, MARKER.rodBigEnd)
      if (!s || !b) {
        fallos.push({
          campo: 'rodLength',
          motivo: `La biela "${r.name}" no tiene marcados sus dos ojos.`,
          arregla: `Coloca "${MARKER.rodSmallEnd}" en el ojo del bulón y "${MARKER.rodBigEnd}" en el de la muñequilla.`
        })
        continue
      }
      largos.push(len(sub(b, s)))
    }
    if (largos.length > 0) {
      const medio = largos.reduce((s, l) => s + l, 0) / largos.length
      const disp = Math.max(...largos) - Math.min(...largos)
      if (medio > 1e-6 && disp / medio > 0.01) {
        avisos.push(
          `Las bielas no miden todas lo mismo (${(disp * 1000).toFixed(1)} mm de diferencia). Se usa el promedio.`
        )
      }
      rodLength = anota('rodLength', medio, 'm', 'distancia entre los dos ojos marcados')
    }
  }

  // ----------------------------------------------------------------- calibre
  // Se mide del PISTÓN, que es la pieza cuyo diámetro exterior ES el calibre.
  // Medirlo del bloque exigiría encontrar el hueco de la camisa, que es mucho
  // más frágil con mallas cualesquiera.
  let bore = 0
  const piston = pistons[0] ?? null
  if (piston) {
    const pin = marcador(piston, MARKER.pistonPin)
    const crown = marcador(piston, MARKER.pistonCrown)
    if (!piston.mesh) {
      fallos.push({
        campo: 'bore',
        motivo: 'El pistón no trae malla, así que no se puede medir su diámetro.',
        arregla: 'Importa la geometría del pistón, no solo su marcador.'
      })
    } else if (!pin || !crown) {
      fallos.push({
        campo: 'bore',
        motivo: 'El pistón no tiene marcados el bulón y la corona.',
        arregla: `Coloca "${MARKER.pistonPin}" en el eje del bulón y "${MARKER.pistonCrown}" en el centro de la corona.`
      })
    } else {
      const ejeCil = norm(sub(crown, pin))
      if (len(sub(crown, pin)) < 1e-5) {
        fallos.push({
          campo: 'bore',
          motivo: 'El bulón y la corona del pistón están en el mismo punto.',
          arregla: 'La corona va arriba y el bulón dentro: sepáralos para definir el eje del cilindro.'
        })
      } else {
        bore = anota(
          'bore',
          diameterAcrossAxis(piston.mesh.positions, pin, ejeCil),
          'm',
          'diámetro del pistón medido perpendicular a su eje (percentil 98)'
        )
      }
    }
  }

  // ------------------------------------------------------------------- masas
  const masaDe = (p: ScenePart | null): number | null => {
    if (!p?.mesh || !p.density) return null
    return meshVolume(p.mesh.positions, p.mesh.index) * p.density
  }
  const pistonMass = masaDe(piston)
  const rodMass = masaDe(rods[0] ?? null)
  if (pistonMass !== null) anota('pistonMass', pistonMass, 'kg', 'volumen de la malla × densidad')
  if (rodMass !== null) anota('rodMass', rodMass, 'kg', 'volumen de la malla × densidad')

  // -------------------------------------------------------- orden de encendido
  // Sale de las fases: se encienden en el orden en que las muñequillas van
  // pasando por el punto muerto superior. No hay tabla por arquitectura.
  const firingOrder = pinPhases
    .map((fase, i) => ({ fase, i }))
    .sort((a, b) => a.fase - b.fase)
    .map((x) => x.i)

  // ----------------------------------------------- comprobaciones de coherencia
  if (stroke > 0 && rodLength > 0) {
    const ratio = rodLength / stroke
    if (ratio < 1.2) {
      avisos.push(
        `Relación biela/carrera ${ratio.toFixed(2)}: la biela es casi tan corta como la carrera. ` +
          'Revisa si los marcadores del cigüeñal o de la biela están donde crees.'
      )
    }
  }
  if (bore > 0 && stroke > 0 && (bore / stroke > 2.5 || stroke / bore > 2.5)) {
    avisos.push(
      `Calibre ${(bore * 1000).toFixed(1)} mm y carrera ${(stroke * 1000).toFixed(1)} mm ` +
        'dan una relación muy rara. Suele significar que la escala del modelo no es la que crees.'
    )
  }

  return {
    bore, stroke, rodLength, cylinders,
    pinPhases, firingOrder,
    pistonMass, rodMass,
    mediciones, fallos, avisos
  }
}

/** Resumen legible del informe, para la interfaz y para los tests. */
export function describeMeasurement(m: EngineMeasurement): string {
  const l: string[] = []
  for (const x of m.mediciones) {
    const v = x.unidad === 'm' ? `${(x.valor * 1000).toFixed(2)} mm` : `${x.valor.toFixed(4)} ${x.unidad}`
    l.push(`  ${x.campo.padEnd(12)} ${v.padStart(12)}   ← ${x.origen}`)
  }
  if (m.fallos.length) {
    l.push('  NO SE HA PODIDO MEDIR:')
    for (const f of m.fallos) l.push(`    ${f.campo}: ${f.motivo} → ${f.arregla}`)
  }
  for (const a of m.avisos) l.push(`  aviso: ${a}`)
  return l.join('\n')
}
