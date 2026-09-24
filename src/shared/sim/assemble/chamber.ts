import type { Vec3 } from './scene'
import { norm, sub, dot, cross, add, scale } from './scene'

/**
 * Medición de la CÁMARA DE COMBUSTIÓN: el último número que faltaba.
 *
 * Es el problema difícil del montador, y conviene entender por qué. Todo lo
 * demás (carrera, biela, calibre) son distancias entre puntos que el usuario
 * marca. La cámara no es una pieza: es el HUECO que queda entre la corona del
 * pistón en PMS, la pared del cilindro y la cavidad de la culata. No hay nada
 * que medir, hay que medir la ausencia de algo.
 *
 * Método: voxelizar el cilindro. Se recorre el volumen cilíndrico que va del
 * plano de la corona (en PMS) hacia la culata, y se cuenta qué fracción NO está
 * ocupada por el sólido de la culata. Esa fracción por el volumen del cilindro
 * es la cámara.
 *
 * La ocupación se resuelve con lanzamiento de rayos y conteo de cruces: un punto
 * está DENTRO del sólido si un rayo cualquiera desde él corta la malla un número
 * impar de veces. Es robusto con mallas trianguladas cualesquiera y no exige que
 * sean convexas, que es justo lo que una culata no es.
 *
 * Límite honesto: exige que la malla de la culata esté CERRADA. Con una malla
 * abierta el conteo de cruces pierde el sentido y el resultado sería basura, así
 * que se detecta y se dice, en vez de devolver un número bonito y falso.
 */

export interface ChamberInput {
  /** Malla de la culata, en metros y en coordenadas de escena. */
  headPositions: Float32Array
  /** Centro del cilindro sobre el plano de la corona en PMS. */
  crownCenter: Vec3
  /** Eje del cilindro, apuntando de la corona HACIA la culata. */
  axis: Vec3
  bore: number
  /** Hasta dónde buscar techo de cámara (m). Por defecto, medio calibre. */
  maxHeight?: number
  /** Divisiones radiales del muestreo. Más = más preciso y más lento. */
  resolution?: number
}

export interface ChamberResult {
  /** Volumen de la cámara (m³). NaN si no se ha podido medir. */
  volume: number
  /** Altura sobre la corona donde deja de haber hueco (m). */
  height: number
  ok: boolean
  motivo?: string
  /** Fracción del muestreo que cayó dentro del sólido de la culata. */
  ocupacion: number
}

/** ¿Está `p` dentro de la malla? Rayo + paridad de cruces (Möller-Trumbore). */
function dentroDeMalla(pos: Float32Array, p: Vec3, dir: Vec3): boolean {
  let cruces = 0
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const a: Vec3 = [pos[i]!, pos[i + 1]!, pos[i + 2]!]
    const b: Vec3 = [pos[i + 3]!, pos[i + 4]!, pos[i + 5]!]
    const c: Vec3 = [pos[i + 6]!, pos[i + 7]!, pos[i + 8]!]
    const e1 = sub(b, a)
    const e2 = sub(c, a)
    const h = cross(dir, e2)
    const det = dot(e1, h)
    if (Math.abs(det) < 1e-14) continue
    const f = 1 / det
    const s = sub(p, a)
    const u = f * dot(s, h)
    if (u < 0 || u > 1) continue
    const q = cross(s, e1)
    const v = f * dot(dir, q)
    if (v < 0 || u + v > 1) continue
    const t = f * dot(e2, q)
    if (t > 1e-9) cruces++
  }
  return cruces % 2 === 1
}

/**
 * ¿La malla está cerrada? Se comprueba que cada arista aparezca exactamente dos
 * veces. Una malla abierta invalida el conteo de cruces, así que más vale
 * detectarlo antes de dar un volumen inventado.
 */
export function mallaCerrada(pos: Float32Array): boolean {
  const cuenta = new Map<string, number>()
  const clave = (i: number, j: number): string => {
    // Cuantizar: dos vértices "iguales" pueden diferir en el último bit del float.
    const k = (n: number): number => Math.round(pos[n]! * 1e6)
    const A = `${k(i)},${k(i + 1)},${k(i + 2)}`
    const B = `${k(j)},${k(j + 1)},${k(j + 2)}`
    return A < B ? `${A}|${B}` : `${B}|${A}`
  }
  for (let t = 0; t + 8 < pos.length; t += 9) {
    const v = [t, t + 3, t + 6]
    for (let e = 0; e < 3; e++) {
      const kk = clave(v[e]!, v[(e + 1) % 3]!)
      cuenta.set(kk, (cuenta.get(kk) ?? 0) + 1)
    }
  }
  let sueltas = 0
  for (const n of cuenta.values()) if (n !== 2) sueltas++
  // La tolerancia ESCALA con la malla y no es un mínimo fijo. Un mínimo de 4
  // dejaba pasar una caja a la que le falta una cara entera (4 aristas sueltas),
  // que es exactamente el caso que hay que cazar. En una malla grande, en
  // cambio, unas pocas aristas raras son ruido de soldadura de vértices.
  return sueltas <= Math.ceil(cuenta.size * 0.002)
}

/**
 * Caché de mediciones. Medir la cámara es O(muestras × triángulos) con
 * lanzamiento de rayo, y `assembleEngine` se llama en cada recálculo: sin caché,
 * la suite de tests pasó de 50 segundos a 38 minutos. El resultado es
 * determinista para la misma malla y la misma colocación, así que se guarda.
 *
 * La clave externa es la PROPIA malla por referencia (WeakMap: si la malla se
 * descarta, su caché se va con ella) y la interna, la geometría cuantizada a
 * micras, que es muy por debajo de lo que cambia un resultado.
 */
const cache = new WeakMap<Float32Array, Map<string, ChamberResult>>()

function claveCache(i: ChamberInput): string {
  const q = (n: number): number => Math.round(n * 1e6)
  return [
    ...i.crownCenter.map(q), ...i.axis.map(q),
    q(i.bore), q(i.maxHeight ?? -1), i.resolution ?? -1
  ].join(',')
}

export function measureChamber(input: ChamberInput): ChamberResult {
  const porMalla = cache.get(input.headPositions)
  const k = claveCache(input)
  const guardado = porMalla?.get(k)
  if (guardado) return guardado
  const r = medirCamara(input)
  if (porMalla) porMalla.set(k, r)
  else cache.set(input.headPositions, new Map([[k, r]]))
  return r
}

function medirCamara(input: ChamberInput): ChamberResult {
  const { headPositions, bore } = input
  const u = norm(input.axis)
  const r = bore / 2
  const res = Math.max(6, Math.floor(input.resolution ?? 24))
  const maxH = input.maxHeight ?? bore * 0.5

  if (headPositions.length < 9) {
    return { volume: NaN, height: 0, ok: false, ocupacion: 0, motivo: 'La culata no tiene malla.' }
  }
  if (r <= 0) {
    return { volume: NaN, height: 0, ok: false, ocupacion: 0, motivo: 'El calibre medido es cero.' }
  }
  if (!mallaCerrada(headPositions)) {
    return {
      volume: NaN, height: 0, ok: false, ocupacion: 0,
      motivo: 'La malla de la culata está abierta: no se puede saber qué es dentro y qué es fuera. ' +
        'Repárala en tu CAD (cerrar sólido) y vuelve a importarla.'
    }
  }

  // Base ortonormal perpendicular al eje, para barrer el disco del cilindro.
  const tmp: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const e1 = norm(cross(u, tmp))
  const e2 = cross(u, e1)

  // Rayo de prueba: oblicuo a propósito. Uno paralelo a un eje tiene muchas
  // papeletas de pasar justo por una arista o un vértice y contar mal.
  const rayo = norm([0.4137, 0.6421, 0.6455])

  const pasosH = res
  const dh = maxH / pasosH
  let huecoTotal = 0
  let muestras = 0
  let dentroTotal = 0
  let alturaTope = 0

  for (let ih = 0; ih < pasosH; ih++) {
    const h = (ih + 0.5) * dh
    let huecoCapa = 0
    let muestrasCapa = 0
    // Muestreo en anillos de área constante: así cada muestra representa el
    // mismo trozo de disco y no hay que ponderar por radio.
    const anillos = Math.max(3, Math.floor(res / 3))
    for (let ir = 0; ir < anillos; ir++) {
      const rr = r * Math.sqrt((ir + 0.5) / anillos)
      const nAng = Math.max(6, Math.round(2 * Math.PI * rr / (r / anillos)))
      for (let ia = 0; ia < nAng; ia++) {
        const ang = (ia / nAng) * 2 * Math.PI
        const p = add(
          add(input.crownCenter, scale(u, h)),
          add(scale(e1, rr * Math.cos(ang)), scale(e2, rr * Math.sin(ang)))
        )
        muestrasCapa++
        if (dentroDeMalla(headPositions, p, rayo)) dentroTotal++
        else huecoCapa++
      }
    }
    muestras += muestrasCapa
    const fraccion = muestrasCapa > 0 ? huecoCapa / muestrasCapa : 0
    huecoTotal += fraccion
    // El techo de la cámara: la última capa donde todavía quedaba hueco real.
    if (fraccion > 0.02) alturaTope = h + dh / 2
  }

  const areaCilindro = Math.PI * r * r
  const volume = huecoTotal * dh * areaCilindro
  return {
    volume,
    height: alturaTope,
    ok: true,
    ocupacion: muestras > 0 ? dentroTotal / muestras : 0
  }
}

/**
 * Relación de compresión a partir de la cámara medida y la geometría.
 * Misma fórmula que `assembly.ts`, para que el motor montado y el elegido por
 * catálogo hablen el mismo idioma.
 */
export function compressionFrom(
  bore: number, stroke: number, chamberVolume: number
): number {
  const swept = (Math.PI / 4) * bore * bore * stroke
  if (chamberVolume <= 0) return NaN
  return (swept + chamberVolume) / chamberVolume
}
