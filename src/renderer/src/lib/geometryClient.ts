/**
 * Cliente del worker de geometría: un único worker perezoso y una API
 * basada en promesas para parsear ficheros CAD.
 */
import GeometryWorker from '../workers/geometry.worker?worker'
import type { ParseReply, ParseRequest } from '../workers/geometry.worker'
import type { GeometryMetrics } from '@sim/import/metrics'

export interface ParsedCad {
  metrics: GeometryMetrics
  positions: Float32Array
  triangleCount: number
}

interface Pending {
  resolve: (r: ParsedCad) => void
  reject: (e: Error) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new GeometryWorker()
  worker.onmessage = (e: MessageEvent<ParseReply>) => {
    const req = pending.get(e.data.id)
    if (!req) return
    pending.delete(e.data.id)
    if (e.data.ok) {
      req.resolve({
        metrics: e.data.metrics,
        positions: e.data.positions,
        triangleCount: e.data.triangleCount
      })
    } else {
      req.reject(new Error(e.data.error))
    }
  }
  worker.onerror = (e) => {
    const err = new Error(e.message || 'El worker de geometría falló')
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  return worker
}

export function parseCadFile(name: string, data: ArrayBuffer): Promise<ParsedCad> {
  const w = ensureWorker()
  const id = nextId++
  return new Promise<ParsedCad>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const msg: ParseRequest = { id, name, data }
    w.postMessage(msg, [data])
  })
}
