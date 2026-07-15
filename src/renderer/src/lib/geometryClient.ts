/**
 * Cliente del worker de geometría: un único worker perezoso y una API
 * basada en promesas para parsear ficheros CAD y lanzar el FEA vóxel.
 */
import GeometryWorker from '../workers/geometry.worker?worker'
import type { ParseReply, WorkerRequest } from '../workers/geometry.worker'
import type { GeometryMetrics } from '@sim/import/metrics'
import type { FeaCase, FeaSummary } from '@sim/import/fea'

export interface ParsedCad {
  metrics: GeometryMetrics
  positions: Float32Array
  triangleCount: number
}

interface Pending {
  resolve: (r: ParseReply & { ok: true }) => void
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
    if (e.data.ok) req.resolve(e.data)
    else req.reject(new Error(e.data.error))
  }
  worker.onerror = (e) => {
    const err = new Error(e.message || 'El worker de geometría falló')
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  return worker
}

function post(msg: WorkerRequest, transfer?: Transferable[]): Promise<ParseReply & { ok: true }> {
  const w = ensureWorker()
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject })
    if (transfer) w.postMessage(msg, transfer)
    else w.postMessage(msg)
  })
}

export async function parseCadFile(name: string, data: ArrayBuffer): Promise<ParsedCad> {
  const reply = await post({ id: nextId++, type: 'parse', name, data }, [data])
  if (reply.kind !== 'parse') throw new Error('Respuesta inesperada del worker')
  return { metrics: reply.metrics, positions: reply.positions, triangleCount: reply.triangleCount }
}

/** FEA vóxel sobre el soup ya parseado. Se copia (no transfiere): la vista previa sigue viva. */
export async function runFea(positions: Float32Array, feaCase: FeaCase): Promise<FeaSummary> {
  const reply = await post({ id: nextId++, type: 'fea', feaCase, positions })
  if (reply.kind !== 'fea') throw new Error('Respuesta inesperada del worker')
  return reply.fea
}
