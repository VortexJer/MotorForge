import { describe, it, expect } from 'vitest'
import {
  newProject, nextId, clonePart, cloneSeries, copyConfig, glue, gluedChain,
  movePart, serializeProject, parseProject, PROJECT_FORMAT
} from './project'
import type { ProjectPart } from './project'
import { MARKER } from './scene'

const pieza = (id: string, role: ProjectPart['role'], x = 0): ProjectPart => ({
  id, name: id, role, position: [x, 0, 0], rotation: [0, 0, 0], scale: 1, markers: []
})

describe('Proyecto — clonar', () => {
  it('el clon no hereda el número de cilindro del original', () => {
    const parts = [{ ...pieza('piston-1', 'piston'), cylinder: 0 }]
    const c = clonePart(parts, 'piston-1', [0.094, 0, 0])!
    // Heredarlo en silencio deja cuatro pistones diciendo que son el cilindro 1.
    expect(c.cylinder).toBeUndefined()
    expect(c.id).not.toBe('piston-1')
    expect(c.position[0]).toBeCloseTo(0.094, 6)
  })

  it('duplicar en serie coloca y numera los cilindros de una vez', () => {
    const parts = [{ ...pieza('piston-1', 'piston'), cylinder: 0 }]
    const serie = cloneSeries(parts, 'piston-1', [0.094, 0, 0], 3)
    expect(serie).toHaveLength(3)
    expect(serie.map((p) => p.cylinder)).toEqual([1, 2, 3])
    expect(serie.map((p) => Number(p.position[0].toFixed(3)))).toEqual([0.094, 0.188, 0.282])
    // Y ninguno repite identificador con los que ya existían.
    const ids = new Set([...parts, ...serie].map((p) => p.id))
    expect(ids.size).toBe(4)
  })

  it('nextId no colisiona con ids ya usados', () => {
    const parts = [pieza('piston-1', 'piston'), pieza('piston-2', 'piston')]
    expect(nextId(parts, 'piston')).toBe('piston-3')
  })
})

describe('Proyecto — copiar configuración', () => {
  it('lleva rol y marcadores a otras piezas, recolocándolos en cada una', () => {
    const parts: ProjectPart[] = [
      {
        ...pieza('a', 'piston', 0),
        density: 2700,
        markers: [{ id: MARKER.pistonCrown, position: [0, 0, 0.03] }]
      },
      pieza('b', 'decor', 0.1)
    ]
    const out = copyConfig(parts, 'a', ['b'])
    const b = out.find((p) => p.id === 'b')!
    expect(b.role).toBe('piston')
    expect(b.density).toBe(2700)
    // El marcador estaba 30 mm por encima del origen de "a"; en "b" tiene que
    // quedar 30 mm por encima del origen de "b", no encima de "a".
    expect(b.markers[0]!.position[0]).toBeCloseTo(0.1, 6)
    expect(b.markers[0]!.position[2]).toBeCloseTo(0.03, 6)
  })

  it('no se copia a sí misma', () => {
    const parts = [{ ...pieza('a', 'piston'), density: 2700 }]
    expect(copyConfig(parts, 'a', ['a'])[0]!.density).toBe(2700)
  })
})

describe('Proyecto — pegar piezas', () => {
  it('lo pegado se mueve con su padre, en cascada', () => {
    let parts = [pieza('bloque', 'block'), pieza('culata', 'head'), pieza('tapa', 'decor')]
    parts = glue(parts, 'culata', 'bloque')
    parts = glue(parts, 'tapa', 'culata') // el tornillo del tornillo
    expect(gluedChain(parts, 'bloque').sort()).toEqual(['culata', 'tapa'])

    parts = movePart(parts, 'bloque', [0, 0.5, 0])
    for (const id of ['bloque', 'culata', 'tapa']) {
      expect(parts.find((p) => p.id === id)!.position[1]).toBeCloseTo(0.5, 6)
    }
  })

  it('mover un hijo NO arrastra al padre', () => {
    let parts = glue([pieza('bloque', 'block'), pieza('culata', 'head')], 'culata', 'bloque')
    parts = movePart(parts, 'culata', [0, 0.2, 0])
    expect(parts.find((p) => p.id === 'bloque')!.position[1]).toBeCloseTo(0, 6)
    expect(parts.find((p) => p.id === 'culata')!.position[1]).toBeCloseTo(0.2, 6)
  })

  it('los marcadores viajan con la pieza', () => {
    let parts: ProjectPart[] = [
      { ...pieza('c', 'crank'), markers: [{ id: MARKER.crankPin(0), position: [0, 0, 0.043] }] }
    ]
    parts = movePart(parts, 'c', [0, 0, 0.1])
    expect(parts[0]!.markers[0]!.position[2]).toBeCloseTo(0.143, 6)
  })

  it('no deja crear un ciclo de pegado', () => {
    let parts = glue([pieza('a', 'block'), pieza('b', 'head')], 'b', 'a')
    parts = glue(parts, 'a', 'b') // cerraría el bucle
    expect(parts.find((p) => p.id === 'a')!.gluedTo).toBeUndefined()
  })
})

describe('Proyecto — guardar y abrir', () => {
  it('ida y vuelta conserva el proyecto', () => {
    const p = newProject('Mi V8')
    p.parts.push({
      ...pieza('crank-1', 'crank'),
      meshPath: 'C:/motores/crank.stl',
      density: 7850,
      cylinder: 0,
      markers: [{ id: MARKER.crankAxisA, position: [-0.2, 0, 0], direction: [1, 0, 0] }]
    })
    const r = parseProject(serializeProject(p))
    expect('project' in r).toBe(true)
    if (!('project' in r)) return
    expect(r.project.name).toBe('Mi V8')
    expect(r.project.parts[0]!.meshPath).toBe('C:/motores/crank.stl')
    expect(r.project.parts[0]!.markers[0]!.direction).toEqual([1, 0, 0])
  })

  it('un archivo de otro formato se rechaza con motivo, no revienta', () => {
    const r = parseProject(JSON.stringify({ format: 'otra-cosa/9', parts: [] }))
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(/Formato desconocido/)
  })

  it('un JSON roto se rechaza con motivo', () => {
    const r = parseProject('{esto no es json')
    expect('error' in r && r.error).toMatch(/no es JSON/)
  })

  it('una pieza con datos corruptos no tumba la carga del resto', () => {
    const json = JSON.stringify({
      format: PROJECT_FORMAT, name: 'x',
      parts: [
        { id: 'buena', role: 'piston', position: [1, 2, 3], scale: 1, markers: [] },
        { role: 'sin-id' },
        { id: 'sin-pos', role: 'rod' }
      ]
    })
    const r = parseProject(json)
    if (!('project' in r)) throw new Error('debería cargar')
    expect(r.project.parts.map((p) => p.id)).toEqual(['buena', 'sin-pos'])
    // Lo que falta se rellena con algo sano en vez de dejar undefined suelto.
    expect(r.project.parts[1]!.position).toEqual([0, 0, 0])
    expect(r.project.parts[1]!.scale).toBe(1)
  })
})
