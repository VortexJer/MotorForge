import { useMemo, useState } from 'react'
import {
  buildDesign, defaultDesign, architectureLabel
} from '@sim/designer'
import type { EngineDesign, Layout, BlockMaterial, CrankType, PistonType, RodType } from '@sim/designer'
import { resolveEngine } from '@sim/assembly'
import type { Part } from '@sim/types'

/**
 * Diseñador de motores: la pantalla que faltaba para poder hacer un motor que
 * NO sea el 2.0 de cuatro cilindros del catálogo.
 *
 * No inventa piezas de la nada: traduce una arquitectura a un juego de piezas
 * con sus límites derivados (ver `@sim/designer`), y las mete en el mismo saco
 * de "piezas importadas" que ya usa el resto de la aplicación. Por eso el banco,
 * el laboratorio, el desgaste y los proyectos funcionan con el motor diseñado
 * sin tocar ni una línea suya.
 */

interface Props {
  onApply: (parts: Part[], nombre: string) => void
}

const LAYOUTS: Array<[Layout, string]> = [
  ['inline', 'En línea'],
  ['v', 'En V'],
  ['boxer', 'Bóxer']
]

/** Campo numérico con deslizador: se ajusta a ojo o se teclea exacto. */
function Cota({
  label, unit, value, min, max, step, decimals = 1, onChange
}: {
  label: string; unit: string; value: number; min: number; max: number
  step: number; decimals?: number; onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <div className="slider-row">
      <label>
        {label} <span className="unit">{unit}</span>
      </label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        className="slider-value" type="number" min={min} max={max} step={step}
        value={Number(value.toFixed(decimals))}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
      />
    </div>
  )
}

function Opciones<T extends string>({
  label, value, options, onChange
}: {
  label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="segmented">
        {options.map(([v, texto]) => (
          <button
            key={v} type="button"
            className={value === v ? 'seg-btn active' : 'seg-btn'}
            onClick={() => onChange(v)}
          >
            {texto}
          </button>
        ))}
      </div>
    </div>
  )
}

export function EngineDesigner({ onApply }: Props): React.JSX.Element {
  const [d, setD] = useState<EngineDesign>(defaultDesign)
  const set = <K extends keyof EngineDesign>(k: K, v: EngineDesign[K]): void =>
    setD((prev) => ({ ...prev, [k]: v }))

  // Recalcular en cada tecla es barato: son cuatro fórmulas, no una simulación.
  const { assembly, warnings, summary, issues } = useMemo(() => {
    const r = buildDesign(d)
    return { ...r, issues: resolveEngine(r.assembly).issues }
  }, [d])

  const errores = issues.filter((i) => i.severity === 'error')
  const avisos = [...warnings, ...issues.filter((i) => i.severity === 'warning').map((i) => i.message)]

  const limites = [
    ...assembly.block.limits.map((l) => ({ pieza: 'Bloque', ...l })),
    ...assembly.crank.limits.map((l) => ({ pieza: 'Cigüeñal', ...l })),
    ...assembly.rod.limits.map((l) => ({ pieza: 'Biela', ...l })),
    ...assembly.piston.limits.map((l) => ({ pieza: 'Pistón', ...l }))
  ]

  const fmt = (v: number, variable: string): string => {
    if (variable === 'rpm') return `${v.toFixed(0)} rpm`
    if (variable.endsWith('Pressure')) return `${(v / 1e5).toFixed(0)} bar`
    if (variable === 'rodCompression' || variable === 'rodTension') return `${(v / 1e3).toFixed(0)} kN`
    if (variable.endsWith('Temp')) return `${(v - 273).toFixed(0)} °C`
    return v.toFixed(2)
  }

  return (
    <div className="designer">
      <div className="designer-form">
        <div className="section-title">Arquitectura</div>

        <div className="field">
          <label>Nombre</label>
          <input
            type="text" value={d.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Mi motor"
          />
        </div>

        <Cota
          label="Cilindros" unit="" value={d.cylinders} min={1} max={16} step={1} decimals={0}
          onChange={(v) => set('cylinders', Math.round(v))}
        />

        <Opciones
          label="Disposición" value={d.layout} options={LAYOUTS}
          onChange={(v) => set('layout', v)}
        />

        {d.layout === 'v' && (
          <Cota
            label="Ángulo de banco" unit="°" value={d.bankAngleDeg}
            min={10} max={180} step={5} decimals={0}
            onChange={(v) => set('bankAngleDeg', v)}
          />
        )}

        <div className="section-title">Cotas</div>
        <Cota
          label="Calibre" unit="mm" value={d.bore * 1000} min={40} max={160} step={0.5}
          onChange={(v) => set('bore', v / 1000)}
        />
        <Cota
          label="Carrera" unit="mm" value={d.stroke * 1000} min={40} max={160} step={0.5}
          onChange={(v) => set('stroke', v / 1000)}
        />
        <Cota
          label="Relación biela/carrera" unit="" value={d.rodRatio} min={1.3} max={2.2} step={0.01}
          decimals={2} onChange={(v) => set('rodRatio', v)}
        />
        <Cota
          label="Compresión" unit=":1" value={d.compressionRatio} min={6} max={16} step={0.1}
          onChange={(v) => set('compressionRatio', v)}
        />

        <div className="section-title">Materiales</div>
        <Opciones
          label="Bloque" value={d.blockMaterial}
          options={[['aluminio', 'Aluminio'], ['fundicion', 'Fundición']] as Array<[BlockMaterial, string]>}
          onChange={(v) => set('blockMaterial', v)}
        />
        <Opciones
          label="Cigüeñal" value={d.crankType}
          options={[['fundido', 'Fundido'], ['forjado', 'Forjado'], ['billet', 'Billet']] as Array<[CrankType, string]>}
          onChange={(v) => set('crankType', v)}
        />
        <Opciones
          label="Pistones" value={d.pistonType}
          options={[['fundido', 'Fundidos'], ['forjado', 'Forjados']] as Array<[PistonType, string]>}
          onChange={(v) => set('pistonType', v)}
        />
        <Opciones
          label="Bielas" value={d.rodType}
          options={[['serie', 'De serie'], ['forjada', 'Forjadas']] as Array<[RodType, string]>}
          onChange={(v) => set('rodType', v)}
        />
      </div>

      <div className="designer-out">
        <div className="stat-row">
          <div className="stat-tile">
            <div className="stat-label">Arquitectura</div>
            <div className="stat-value">{architectureLabel(d)}</div>
            <div className="stat-detail">
              {(d.bore * 1000).toFixed(1)} × {(d.stroke * 1000).toFixed(1)} mm
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Cilindrada</div>
            <div className="stat-value">{summary.displacementL.toFixed(2)} L</div>
            <div className="stat-detail">
              {((summary.displacementL * 1000) / d.cylinders).toFixed(0)} cc por cilindro
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Régimen máximo</div>
            <div className="stat-value">{summary.rpmLimit.toFixed(0)}</div>
            <div className="stat-detail">
              {summary.meanPistonSpeedAtLimit.toFixed(1)} m/s de velocidad media de pistón
            </div>
          </div>
        </div>

        <div className="stat-row">
          <div className="stat-tile">
            <div className="stat-label">Biela</div>
            <div className="stat-value">{(summary.rodLength * 1000).toFixed(1)}</div>
            <div className="stat-detail">mm entre centros</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Altura de bloque</div>
            <div className="stat-value">{(summary.deckHeight * 1000).toFixed(1)}</div>
            <div className="stat-detail">mm, pistón enrasado en PMS</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Cámara</div>
            <div className="stat-value">{(summary.chamberVolume * 1e6).toFixed(1)}</div>
            <div className="stat-detail">cc por cilindro</div>
          </div>
        </div>

        {errores.length > 0 && (
          <div className="designer-issues">
            {errores.map((e, i) => (
              <div key={i} className="status-chip critical">{e.message}</div>
            ))}
          </div>
        )}
        {avisos.length > 0 && (
          <div className="designer-issues">
            {avisos.map((m, i) => (
              <div key={i} className="empty-note">{m}</div>
            ))}
          </div>
        )}

        <div className="section-title">De dónde salen los límites</div>
        <p className="sub">
          Ninguno está escrito a mano: cada uno es una ley de escalado calibrada con el
          motor del catálogo. Cambia una cota y mira cómo se mueven.
        </p>
        <div className="limits-table">
          {limites.map((l, i) => (
            <div key={i} className="limit-row">
              <div className="limit-head">
                <span className="ref-chip">{l.pieza}</span>
                <strong>{fmt(l.value, l.variable)}</strong>
                <span className="unit">{l.variable}</span>
              </div>
              <div className="limit-why">{l.explanation}</div>
              <div className="limit-fail">Fallo: {l.failureMode}</div>
            </div>
          ))}
        </div>

        <button
          className="btn" type="button" disabled={errores.length > 0}
          onClick={() => {
            const parts: Part[] = [
              assembly.block, assembly.crank, assembly.rod, assembly.piston, assembly.head
            ]
            onApply(parts, d.name.trim() || architectureLabel(d))
          }}
        >
          {errores.length > 0 ? 'Corrige los errores para montarlo' : 'Montar este motor en el banco'}
        </button>
      </div>
    </div>
  )
}
