/**
 * Worker de geometría: parsea el fichero CAD (STEP/IGES vía OCCT-WASM,
 * STL vía three) y mide la malla resultante fuera del hilo de la UI.
 * Las coordenadas de entrada se asumen en milímetros (convención CAD)
 * y se devuelven en metros.
 */
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import occtimportjs from 'occt-import-js'
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'
import { analyzeMesh } from '@sim/import/metrics'
import type { GeometryMetrics } from '@sim/import/metrics'
import type { OcctMesh, OcctModule, OcctResult } from 'occt-import-js'

export interface ParseRequest {
  id: number
  name: string
  data: ArrayBuffer
}

export type ParseReply =
  | {
      id: number
      ok: true
      metrics: GeometryMetrics
      /** Soup de triángulos en metros, para la vista previa. */
      positions: Float32Array
      triangleCount: number
    }
  | { id: number; ok: false; error: string }

const ctx = self as unknown as {
  postMessage(msg: ParseReply, options?: { transfer: Transferable[] }): void
  addEventListener(type: 'message', cb: (e: MessageEvent<ParseRequest>) => void): void
}

let occtPromise: Promise<OcctModule> | null = null
function getOcct(): Promise<OcctModule> {
  if (!occtPromise) {
    occtPromise = fetch(wasmUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`No se pudo cargar el WASM de OCCT (${r.status})`)
        return r.arrayBuffer()
      })
      .then((wasmBinary) => occtimportjs({ wasmBinary }))
  }
  return occtPromise
}

/** Expande las mallas indexadas de OCCT a un soup de triángulos único. */
function occtToSoup(meshes: OcctMesh[]): Float32Array {
  let indices = 0
  for (const m of meshes) indices += m.index.array.length
  const out = new Float32Array(indices * 3)
  let o = 0
  for (const m of meshes) {
    const pos = m.attributes.position.array
    const idx = m.index.array
    for (let i = 0; i < idx.length; i++) {
      const vi = (idx[i] as number) * 3
      out[o++] = pos[vi] as number
      out[o++] = pos[vi + 1] as number
      out[o++] = pos[vi + 2] as number
    }
  }
  return out
}

async function parseToSoup(name: string, data: ArrayBuffer): Promise<Float32Array> {
  const ext = (name.split('.').pop() ?? '').toLowerCase()

  if (ext === 'stl') {
    const geo = new STLLoader().parse(data)
    return new Float32Array(geo.getAttribute('position').array)
  }

  const occt = await getOcct()
  const bytes = new Uint8Array(data)
  let result: OcctResult
  if (ext === 'step' || ext === 'stp') result = occt.ReadStepFile(bytes, null)
  else if (ext === 'iges' || ext === 'igs') result = occt.ReadIgesFile(bytes, null)
  else if (ext === 'brep') result = occt.ReadBrepFile(bytes, null)
  else throw new Error(`Formato no soportado: .${ext}`)

  if (!result.success || result.meshes.length === 0) {
    throw new Error('OCCT no pudo teselar el fichero (¿está corrupto o vacío?)')
  }
  return occtToSoup(result.meshes)
}

ctx.addEventListener('message', (e) => {
  void (async (): Promise<void> => {
    const { id, name, data } = e.data
    try {
      const positions = await parseToSoup(name, data)
      // mm → m
      for (let i = 0; i < positions.length; i++) positions[i] = (positions[i] as number) * 1e-3
      const metrics = analyzeMesh(positions)
      ctx.postMessage(
        { id, ok: true, metrics, positions, triangleCount: positions.length / 9 },
        { transfer: [positions.buffer] }
      )
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.postMessage({ id, ok: false, error })
    }
  })()
})
