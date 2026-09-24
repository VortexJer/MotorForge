import { describe, it, expect } from 'vitest'
import { BlackBox, Src, bankChannels, bankTriggers } from './blackBox'
import type { BlackBoxConfig, BlackBoxSources } from './blackBox'
import { TICK_RATE, Tap, St, Cyl } from './types'

/**
 * Fuentes de mentira: arrays que movemos a mano. Así se prueba el REGISTRADOR
 * sin arrastrar la física entera, y se pueden forzar valores exactos.
 */
function fuentes(): BlackBoxSources & { sensorVal: number; actVal: number } {
  const f = {
    truth: new Float64Array(Tap.COUNT),
    scalars: new Float64Array(St.COUNT),
    perCyl: new Float64Array(4 * Cyl.STRIDE),
    sensorVal: 0,
    actVal: 0,
    sensor: (id: string) =>
      id === 'map' ? ({ spec: {} as never, read: () => f.sensorVal }) : null,
    actuator: (id: string) =>
      id === 'inj' ? ({ spec: {} as never, command: () => {}, effective: 0, get e() { return f.actVal } }) : null
  }
  // `effective` es readonly en la interfaz: se define como getter vivo.
  const puerto = f.actuator('inj')!
  Object.defineProperty(puerto, 'effective', { get: () => f.actVal })
  f.actuator = (id: string) => (id === 'inj' ? puerto : null)
  return f as never
}

const cfgBase = (extra?: Partial<BlackBoxConfig>): BlackBoxConfig => ({
  channels: [
    { id: 'rpm', unit: 'rpm', src: Src.Truth, idx: Tap.CrankOmega, scale: 60 / (2 * Math.PI) },
    { id: 'aceite', unit: 'bar', src: Src.Truth, idx: Tap.OilP, scale: 1e-5 }
  ],
  preRollS: 1,
  postRollS: 0.5,
  rateHz: TICK_RATE, // sin diezmar: 1 muestra = 1 tick, más fácil de contar
  ...extra
})

describe('BlackBox — grabación en anillo', () => {
  it('no graba hasta que se arma', () => {
    const f = fuentes()
    const bb = new BlackBox(cfgBase(), f)
    expect(bb.estado).toBe('parado')
    for (let i = 0; i < 100; i++) bb.record()
    expect(bb.frames).toBe(0)
  })

  it('conserva las muestras más RECIENTES cuando el anillo da la vuelta', () => {
    const f = fuentes()
    const bb = new BlackBox(cfgBase({ triggers: [] }), f)
    bb.arm()
    // Bastantes más ticks que capacidad: el anillo tiene que dar varias vueltas.
    const total = bb.capacity * 3
    for (let i = 0; i < total; i++) {
      f.truth[Tap.CrankOmega] = i // rad/s crecientes: cada tick es distinguible
      bb.record()
    }
    expect(bb.frames).toBe(bb.capacity)

    const buf = new Float32Array(2)
    // La última fila debe ser el último tick grabado, no el primero.
    bb.frameAt(bb.frames - 1, buf)
    expect(buf[0]!).toBeCloseTo(((total - 1) * 60) / (2 * Math.PI), 2)
    // Y la primera, exactamente `capacity` ticks antes: es la ventana de pre-disparo.
    bb.frameAt(0, buf)
    expect(buf[0]!).toBeCloseTo(((total - bb.capacity) * 60) / (2 * Math.PI), 2)
  })

  it('el diezmado deja una rejilla regular al ritmo pedido', () => {
    const f = fuentes()
    const bb = new BlackBox(cfgBase({ rateHz: 60, triggers: [] }), f)
    expect(bb.rateHz).toBe(60)
    bb.arm()
    for (let i = 0; i < TICK_RATE; i++) bb.record() // 1 segundo de simulación
    // 240 ticks a 60 Hz = 60 muestras
    expect(bb.frames).toBe(60)
    const buf = new Float32Array(2)
    const t0 = bb.frameAt(0, buf)
    const t1 = bb.frameAt(1, buf)
    expect(t1 - t0).toBeCloseTo(1 / 60, 6)
  })
})

describe('BlackBox — disparo', () => {
  it('dispara al superar el umbral y CONSERVA lo anterior al evento', () => {
    const f = fuentes()
    const bb = new BlackBox(
      cfgBase({ triggers: [{ channel: 'rpm', op: '>', threshold: 1000, label: 'sobrerrégimen' }] }),
      f
    )
    bb.arm()
    // 200 ticks tranquilos a 500 rpm...
    f.truth[Tap.CrankOmega] = (500 * 2 * Math.PI) / 60
    for (let i = 0; i < 200; i++) bb.record()
    expect(bb.estado).toBe('armado')

    // ...y de golpe se pasa de vueltas
    f.truth[Tap.CrankOmega] = (2000 * 2 * Math.PI) / 60
    bb.record()
    expect(bb.estado).toBe('disparado')
    expect(bb.motivo).toBe('sobrerrégimen')

    // Lo que hace útil a una caja negra: el ANTES sigue ahí.
    const buf = new Float32Array(2)
    bb.frameAt(0, buf)
    expect(buf[0]!).toBeCloseTo(500, 0)
  })

  it('se congela tras el post-disparo y ya no machaca nada', () => {
    const f = fuentes()
    const bb = new BlackBox(
      cfgBase({ postRollS: 0.5, triggers: [{ channel: 'rpm', op: '>', threshold: 1000 }] }),
      f
    )
    bb.arm()
    f.truth[Tap.CrankOmega] = (2000 * 2 * Math.PI) / 60
    bb.record()
    expect(bb.estado).toBe('disparado')

    const postFrames = Math.ceil(0.5 * TICK_RATE)
    for (let i = 0; i < postFrames; i++) bb.record()
    expect(bb.estado).toBe('congelado')

    const antes = bb.frames
    for (let i = 0; i < 500; i++) bb.record() // ya no debería entrar nada
    expect(bb.frames).toBe(antes)
  })

  it('holdTicks ignora un pico de un solo tick', () => {
    const f = fuentes()
    const bb = new BlackBox(
      cfgBase({ triggers: [{ channel: 'rpm', op: '>', threshold: 1000, holdTicks: 5 }] }),
      f
    )
    bb.arm()
    const alto = (2000 * 2 * Math.PI) / 60
    const bajo = (500 * 2 * Math.PI) / 60
    // Pico aislado: sube un tick y vuelve. No debe disparar.
    for (let i = 0; i < 4; i++) {
      f.truth[Tap.CrankOmega] = alto
      bb.record()
      f.truth[Tap.CrankOmega] = bajo
      bb.record()
    }
    expect(bb.estado).toBe('armado')

    // Sostenido cinco ticks: ahora sí.
    f.truth[Tap.CrankOmega] = alto
    for (let i = 0; i < 5; i++) bb.record()
    expect(bb.estado).toBe('disparado')
  })

  it('la marca manual dispara sin condición', () => {
    const f = fuentes()
    const bb = new BlackBox(cfgBase({ triggers: [] }), f)
    bb.arm()
    for (let i = 0; i < 50; i++) bb.record()
    bb.markEvent('suena raro')
    expect(bb.estado).toBe('disparado')
    expect(bb.motivo).toBe('suena raro')
  })

  it('arm() descarta la captura anterior', () => {
    const f = fuentes()
    const bb = new BlackBox(cfgBase({ triggers: [] }), f)
    bb.arm()
    for (let i = 0; i < 50; i++) bb.record()
    bb.markEvent()
    bb.arm()
    expect(bb.estado).toBe('armado')
    expect(bb.frames).toBe(0)
    expect(Number.isNaN(bb.tiempoDisparo)).toBe(true)
  })
})

describe('BlackBox — exportación', () => {
  it('el CSV lleva cabecera con unidades y tiempo relativo al disparo', () => {
    const f = fuentes()
    const bb = new BlackBox(
      cfgBase({ rateHz: 60, triggers: [{ channel: 'rpm', op: '>', threshold: 1000 }] }),
      f
    )
    bb.arm()
    f.truth[Tap.CrankOmega] = (500 * 2 * Math.PI) / 60
    for (let i = 0; i < 120; i++) bb.record()
    f.truth[Tap.CrankOmega] = (2000 * 2 * Math.PI) / 60
    for (let i = 0; i < 60; i++) bb.record()

    const csv = bb.toCsv()
    const lineas = csv.split('\n')
    expect(lineas[0]).toBe('t[s],t_rel[s],rpm[rpm],aceite[bar]')
    expect(lineas.length).toBe(bb.frames + 1)

    // Tiene que haber filas ANTES del disparo (t_rel negativo) y después.
    const rel = lineas.slice(1).map((l) => Number(l.split(',')[1]))
    expect(Math.min(...rel)).toBeLessThan(0)
    expect(Math.max(...rel)).toBeGreaterThanOrEqual(0)
  })

  it('el manifiesto describe la captura', () => {
    const f = fuentes()
    const bb = new BlackBox(cfgBase({ triggers: [] }), f)
    bb.arm()
    for (let i = 0; i < 10; i++) bb.record()
    const m = bb.toManifest() as Record<string, unknown>
    expect(m.formato).toBe('motorforge-blackbox/1')
    expect(m.estado).toBe('armado')
    expect(m.muestras).toBe(10)
    expect((m.canales as unknown[]).length).toBe(2)
  })
})

describe('BlackBox — contratos del banco', () => {
  it('un disparo sobre un canal inexistente falla al construir, no en marcha', () => {
    const f = fuentes()
    expect(
      () => new BlackBox(cfgBase({ triggers: [{ channel: 'noexiste', op: '>', threshold: 1 }] }), f)
    ).toThrow(/no existe/)
  })

  it('graba las tres capas: verdad, lo que la ECU cree y lo que ordenó', () => {
    const f = fuentes()
    const bb = new BlackBox(
      {
        channels: [
          { id: 'map_real', unit: 'Pa', src: Src.Truth, idx: Tap.ManifoldP },
          { id: 'map_ecu', unit: 'Pa', src: Src.Sensor, wire: 'map' },
          { id: 'inj', unit: '', src: Src.Actuator, wire: 'inj' },
          { id: 'cyl2_p', unit: 'Pa', src: Src.Cylinder, cyl: 1, idx: Cyl.Pressure }
        ],
        rateHz: TICK_RATE,
        preRollS: 1
      },
      f
    )
    bb.arm()
    f.truth[Tap.ManifoldP] = 101325
    f.sensorVal = 99000 // el sensor va retrasado y con ruido: NO coincide
    f.actVal = 0.42
    f.perCyl[1 * Cyl.STRIDE + Cyl.Pressure] = 5e6
    bb.record()

    const buf = new Float32Array(4)
    bb.frameAt(0, buf)
    expect(buf[0]!).toBeCloseTo(101325, 0)
    expect(buf[1]!).toBeCloseTo(99000, 0)
    expect(buf[2]!).toBeCloseTo(0.42, 5)
    expect(buf[3]!).toBeCloseTo(5e6, 0)
  })

  it('un canal cuyo cable no existe se graba como hueco, no revienta', () => {
    const f = fuentes()
    const bb = new BlackBox(
      { channels: [{ id: 'fantasma', unit: '', src: Src.Sensor, wire: 'no-cableado' }], rateHz: TICK_RATE, preRollS: 1 },
      f
    )
    bb.arm()
    expect(() => bb.record()).not.toThrow()
    const csv = bb.toCsv()
    expect(csv.split('\n')[1]).toMatch(/,$/) // celda vacía al final
  })

  it('el juego de banco cubre todos los cilindros', () => {
    const ch = bankChannels(6)
    expect(ch.filter((c) => c.id.startsWith('cyl')).length).toBe(18) // 6 × 3
    expect(ch.some((c) => c.id === 'rpm')).toBe(true)
    // Todos los disparos por defecto apuntan a canales que existen de verdad.
    const ids = new Set(ch.map((c) => c.id))
    for (const t of bankTriggers()) expect(ids.has(t.channel)).toBe(true)
  })
})

describe('BlackBox — ADR-001 §5: cero asignaciones en el tick', () => {
  it('record() no asigna memoria', () => {
    const f = fuentes()
    const bb = new BlackBox({ channels: bankChannels(4), triggers: bankTriggers(), rateHz: TICK_RATE, preRollS: 2 }, f)
    bb.arm()
    // Calentar para que V8 optimice y no cuente la compilación como asignación.
    for (let i = 0; i < 5000; i++) bb.record()
    bb.arm()

    const medir = (): number => {
      const g = (globalThis as { gc?: () => void }).gc
      if (g) g()
      return process.memoryUsage().heapUsed
    }
    const antes = medir()
    for (let i = 0; i < 100_000; i++) bb.record()
    const despues = medir()
    // Con 100k ticks, cualquier asignación por tick (un objeto, un array, una
    // closure) dispararía esto muy por encima. El margen cubre el ruido del
    // heap del propio proceso de test.
    expect(despues - antes).toBeLessThan(2_000_000)
  })
})

describe('BlackBox — habilitación de disparos', () => {
  it('un disparo deshabilitado no salta aunque se cumpla el umbral', () => {
    const f = fuentes()
    const bb = new BlackBox(
      cfgBase({
        triggers: [
          {
            channel: 'aceite', op: '<', threshold: 0.8, holdTicks: 3, label: 'aceite',
            gate: { channel: 'rpm', op: '>', threshold: 1200 }
          }
        ]
      }),
      f
    )
    bb.arm()
    // Arranque: aceite a cero (se cumple el umbral) pero el motor apenas gira.
    f.truth[Tap.OilP] = 0
    f.truth[Tap.CrankOmega] = (200 * 2 * Math.PI) / 60
    for (let i = 0; i < 500; i++) bb.record()
    expect(bb.estado).toBe('armado')

    // Ya en marcha y SIN presión: eso sí es una avería.
    f.truth[Tap.CrankOmega] = (3000 * 2 * Math.PI) / 60
    for (let i = 0; i < 3; i++) bb.record()
    expect(bb.estado).toBe('disparado')
    expect(bb.motivo).toBe('aceite')
  })

  it('al abrirse la habilitación la cuenta empieza de cero', () => {
    const f = fuentes()
    const bb = new BlackBox(
      cfgBase({
        triggers: [
          {
            channel: 'aceite', op: '<', threshold: 0.8, holdTicks: 10,
            gate: { channel: 'rpm', op: '>', threshold: 1200 }
          }
        ]
      }),
      f
    )
    bb.arm()
    f.truth[Tap.OilP] = 0
    f.truth[Tap.CrankOmega] = (200 * 2 * Math.PI) / 60
    for (let i = 0; i < 100; i++) bb.record() // 100 ticks cumpliendo el umbral, pero deshabilitado

    f.truth[Tap.CrankOmega] = (3000 * 2 * Math.PI) / 60
    for (let i = 0; i < 9; i++) bb.record() // 9 < holdTicks: aún no
    expect(bb.estado).toBe('armado')
    bb.record() // el décimo
    expect(bb.estado).toBe('disparado')
  })

  it('los disparos de banco no saltan durante un arranque', () => {
    const ch = bankChannels(4)
    const f = fuentes()
    const bb = new BlackBox({ channels: ch, triggers: bankTriggers(), rateHz: 60, preRollS: 5 }, f)
    bb.arm()
    // Motor girando con el motor de arranque: sin presión de aceite, sin escape
    // caliente, con golpes en el bloque. Nada de esto es una avería.
    f.truth[Tap.CrankOmega] = (250 * 2 * Math.PI) / 60
    f.truth[Tap.OilP] = 0
    f.truth[Tap.BlockKnockAccel] = 80
    for (let i = 0; i < 600; i++) bb.record()
    expect(bb.estado).toBe('armado')
  })
})

describe('BlackBox — los umbrales por defecto no saltan en marcha normal', () => {
  it('el umbral de escape queda por encima del rango medido del modelo', () => {
    const egt = bankTriggers().find((t) => t.label === 'temperatura de escape')!
    // 1358 K es el máximo observado entre ralentí y plena carga (ver la tabla en
    // bankTriggers). Si alguien baja este umbral por debajo, la caja se dispara
    // en cada ensayo y deja de servir.
    expect(egt.threshold).toBeGreaterThan(1358)
  })

  it('todos los disparos peligrosos en arranque llevan habilitación por rpm', () => {
    for (const t of bankTriggers()) {
      // El sobrerrégimen no la necesita: por definición solo ocurre girando.
      if (t.label === 'sobrerrégimen') continue
      expect(t.gate, `"${t.label}" sin habilitación`).toBeDefined()
      expect(t.gate!.channel).toBe('rpm')
    }
  })
})
