import type { EngineScene, ScenePart, PartRole, Marker, Vec3 } from './scene'

/**
 * Proyecto de montaje: lo que se guarda en disco.
 *
 * Separado de `EngineScene` a propósito. La escena que usa el medidor lleva las
 * MALLAS (Float32Array de cientos de miles de números); el proyecto guarda solo
 * la RECETA: qué archivo era cada pieza, dónde está, qué es y qué marcadores le
 * pusiste. Guardar las mallas dentro del .json haría archivos de cientos de MB
 * y, peor, congelaría una copia del modelo: si retocas el STL, quieres que el
 * proyecto coja la versión nueva, no la de cuando lo guardaste.
 */

export const PROJECT_FORMAT = 'motorforge-assembly/1'

export interface ProjectPart {
  id: string
  name: string
  role: PartRole
  /** Ruta del archivo de malla, relativa al proyecto o absoluta. */
  meshPath?: string
  /** Traslación (m), rotación (rad, XYZ) y escala uniforme. */
  position: Vec3
  rotation: Vec3
  scale: number
  density?: number
  cylinder?: number
  markers: Marker[]
  /**
   * Pieza a la que está PEGADA: se mueve con ella. Es lo de "piezas que van
   * atornilladas juntas": mueves el bloque y la culata lo sigue.
   */
  gluedTo?: string
}

export interface AssemblyProject {
  format: typeof PROJECT_FORMAT
  name: string
  /** Unidades del archivo de malla al importarlo: mm es lo habitual en CAD. */
  parts: ProjectPart[]
}

export function newProject(name = 'Motor sin título'): AssemblyProject {
  return { format: PROJECT_FORMAT, name, parts: [] }
}

/** Identificador único y legible: 'piston-3', no un uuid ilegible en el JSON. */
export function nextId(parts: ProjectPart[], role: PartRole): string {
  const n = parts.filter((p) => p.role === role).length + 1
  let id = `${role}-${n}`
  let k = n
  while (parts.some((p) => p.id === id)) id = `${role}-${++k}`
  return id
}

/**
 * Duplica una pieza. Copia rol, densidad, marcadores y pegado; NO copia el
 * cilindro, porque un clon casi siempre va a otro cilindro y heredarlo en
 * silencio es la forma más fácil de acabar con cuatro pistones diciendo que
 * son todos el número 1.
 */
export function clonePart(parts: ProjectPart[], id: string, offset: Vec3): ProjectPart | null {
  const src = parts.find((p) => p.id === id)
  if (!src) return null
  return {
    ...src,
    id: nextId(parts, src.role),
    name: src.name,
    cylinder: undefined,
    position: [src.position[0] + offset[0], src.position[1] + offset[1], src.position[2] + offset[2]],
    markers: src.markers.map((m) => ({ ...m }))
  }
}

/**
 * Duplica en serie a lo largo de un eje: es como se ponen ocho pistones sin
 * colocarlos uno a uno. Numera los cilindros de forma consecutiva desde el
 * original, que es lo que se quiere el 99% de las veces.
 */
export function cloneSeries(
  parts: ProjectPart[], id: string, paso: Vec3, cuantos: number
): ProjectPart[] {
  const src = parts.find((p) => p.id === id)
  if (!src || cuantos < 1) return []
  const salida: ProjectPart[] = []
  const acumulado = [...parts]
  const base = src.cylinder ?? 0
  for (let i = 1; i <= cuantos; i++) {
    const clon = clonePart(acumulado, id, [paso[0] * i, paso[1] * i, paso[2] * i])
    if (!clon) break
    clon.cylinder = base + i
    salida.push(clon)
    acumulado.push(clon)
  }
  return salida
}

/**
 * Copia la CONFIGURACIÓN de una pieza a otras: rol, densidad y marcadores, sin
 * tocar dónde están. Sirve para "estos otros tres pistones son como este":
 * marcas uno bien y lo repartes.
 */
export function copyConfig(parts: ProjectPart[], desdeId: string, haciaIds: string[]): ProjectPart[] {
  const src = parts.find((p) => p.id === desdeId)
  if (!src) return parts
  const destino = new Set(haciaIds)
  return parts.map((p) => {
    if (!destino.has(p.id) || p.id === desdeId) return p
    return {
      ...p,
      role: src.role,
      density: src.density,
      // Los marcadores se copian en LOCAL respecto al origen de la pieza: si se
      // copiaran en coordenadas de escena, todos apuntarían a la pieza original.
      markers: src.markers.map((m) => ({
        ...m,
        position: [
          m.position[0] - src.position[0] + p.position[0],
          m.position[1] - src.position[1] + p.position[1],
          m.position[2] - src.position[2] + p.position[2]
        ] as Vec3
      }))
    }
  })
}

/** Pega `hijoId` a `padreId` para que se muevan juntos. Evita ciclos. */
export function glue(parts: ProjectPart[], hijoId: string, padreId: string | null): ProjectPart[] {
  if (hijoId === padreId) return parts
  if (padreId) {
    // Recorrer hacia arriba: si el padre ya cuelga del hijo, pegarlos haría un bucle.
    let cursor: string | undefined = padreId
    const visto = new Set<string>()
    while (cursor) {
      if (cursor === hijoId) return parts
      if (visto.has(cursor)) break
      visto.add(cursor)
      cursor = parts.find((p) => p.id === cursor)?.gluedTo
    }
  }
  return parts.map((p) => (p.id === hijoId ? { ...p, gluedTo: padreId ?? undefined } : p))
}

/** Ids de todo lo pegado a `id`, en cascada (los tornillos del tornillo). */
export function gluedChain(parts: ProjectPart[], id: string): string[] {
  const salida: string[] = []
  const pendiente = [id]
  while (pendiente.length) {
    const actual = pendiente.pop()!
    for (const p of parts) {
      if (p.gluedTo === actual && !salida.includes(p.id)) {
        salida.push(p.id)
        pendiente.push(p.id)
      }
    }
  }
  return salida
}

/** Mueve una pieza y arrastra todo lo que lleve pegado. */
export function movePart(parts: ProjectPart[], id: string, delta: Vec3): ProjectPart[] {
  const arrastra = new Set([id, ...gluedChain(parts, id)])
  return parts.map((p) => {
    if (!arrastra.has(p.id)) return p
    return {
      ...p,
      position: [p.position[0] + delta[0], p.position[1] + delta[1], p.position[2] + delta[2]] as Vec3,
      markers: p.markers.map((m) => ({
        ...m,
        position: [
          m.position[0] + delta[0], m.position[1] + delta[1], m.position[2] + delta[2]
        ] as Vec3
      }))
    }
  })
}

// ---------------------------------------------------------------------------

export function serializeProject(p: AssemblyProject): string {
  return JSON.stringify(p, null, 2)
}

/**
 * Lee un proyecto validando lo que importa. Un archivo tocado a mano o de una
 * versión futura no debe reventar la aplicación: se rechaza con un motivo.
 */
export function parseProject(json: string): { project: AssemblyProject } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { error: 'El archivo no es JSON válido.' }
  }
  const o = raw as Partial<AssemblyProject>
  if (!o || typeof o !== 'object') return { error: 'El archivo está vacío o no es un proyecto.' }
  if (o.format !== PROJECT_FORMAT) {
    return { error: `Formato desconocido: "${String(o.format)}". Se esperaba "${PROJECT_FORMAT}".` }
  }
  if (!Array.isArray(o.parts)) return { error: 'El proyecto no tiene lista de piezas.' }
  const parts: ProjectPart[] = []
  for (const p of o.parts as ProjectPart[]) {
    if (!p || typeof p.id !== 'string' || typeof p.role !== 'string') continue
    parts.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      role: p.role,
      meshPath: typeof p.meshPath === 'string' ? p.meshPath : undefined,
      position: vec(p.position),
      rotation: vec(p.rotation),
      scale: typeof p.scale === 'number' && p.scale > 0 ? p.scale : 1,
      density: typeof p.density === 'number' ? p.density : undefined,
      cylinder: typeof p.cylinder === 'number' ? p.cylinder : undefined,
      gluedTo: typeof p.gluedTo === 'string' ? p.gluedTo : undefined,
      markers: Array.isArray(p.markers)
        ? (p.markers as Marker[])
            .filter((m) => m && typeof m.id === 'string')
            .map((m) => ({ id: m.id, position: vec(m.position), direction: m.direction ? vec(m.direction) : undefined }))
        : []
    })
  }
  return {
    project: {
      format: PROJECT_FORMAT,
      name: typeof o.name === 'string' ? o.name : 'Sin título',
      parts
    }
  }
}

const vec = (v: unknown): Vec3 => {
  const a = v as number[] | undefined
  return Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [a[0]!, a[1]!, a[2]!]
    : [0, 0, 0]
}

/** Une el proyecto con las mallas ya cargadas para poder MEDIRLO. */
export function toScene(
  p: AssemblyProject,
  mallas: Map<string, { positions: Float32Array; index?: Uint32Array }>
): EngineScene {
  const parts: ScenePart[] = p.parts.map((pp) => ({
    id: pp.id,
    name: pp.name,
    role: pp.role,
    mesh: mallas.get(pp.id),
    density: pp.density,
    cylinder: pp.cylinder,
    markers: pp.markers
  }))
  return { name: p.name, parts }
}
