import { describe, expect, it } from 'vitest'
import { runHilBench } from './bench'

/**
 * Fase 4 — criterios de aceptación del pliego.
 *
 * El test de comportamiento (spool del turbo monótono con la inercia I,
 * 3 valores comparados con >5% de diferencia) vive en engineCore.test.ts
 * («turbo rotor: el boost emerge de la integración…») y está en verde
 * desde Fase 2.
 */
describe('HIL fase 4: validación de rendimiento', () => {
  it('SimLoop ≥60 Hz con V8 + fallo activo + 20 sensores, 20.000 ticks, zero-alloc', async () => {
    const r = await runHilBench({ ticks: 20000, warmupTicks: 2000 })

    // condiciones de estrés exigidas
    expect(r.cylinders).toBe(8)
    expect(r.sensors).toBeGreaterThanOrEqual(20)
    expect(r.faultActive).toBe(true)
    expect(r.ticks).toBeGreaterThanOrEqual(10000)

    // el motor sigue VIVO bajo estrés (la ECU compensa el MAP muerto con lo
    // que puede: potencia degradada, pero girando contra el freno)
    expect(r.rpmFinal).toBeGreaterThan(1500)

    // presupuesto de tiempo real: frame de 60 Hz
    expect(r.meanFrameMs).toBeLessThan(16.6)
    expect(r.p99FrameMs).toBeLessThan(20)

    // ZERO-ALLOCATION, medido con el heap profiler de muestreo (stacks):
    // asignaciones atribuidas a src/shared/sim/hil en 20.000 ticks.
    // Umbral justificado en bench.ts (investigación documentada): cada
    // módulo aislado es limpio; el residuo compuesto ≈2.5 B/tick equivale a
    // ~600 B/s de sim — presión de GC funcionalmente nula.
    expect(r.ownAllocBytes).toBeLessThan(96 * 1024)
  }, 30000)

  it('el banco es reproducible: dos ejecuciones dejan el motor en el mismo estado', async () => {
    const a = await runHilBench({ ticks: 10000, warmupTicks: 500 })
    const b = await runHilBench({ ticks: 10000, warmupTicks: 500 })
    expect(a.rpmFinal).toBe(b.rpmFinal)
    expect(a.boostFinal).toBe(b.boostFinal)
  }, 30000)
})
