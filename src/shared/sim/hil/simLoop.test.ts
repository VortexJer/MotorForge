import { describe, expect, it } from 'vitest'
import { FUELS, resolveEngine, stockEngine } from '../index'
import { buildArchetype } from './archetype'
import { ActuatorBank } from './actuators'
import type { CoreConfig } from './engineCore'
import type { EcuCalib } from './ecu'
import { SimLoop } from './simLoop'
import { TICK_DT, defaultHarness } from './types'
import type { HarnessConfig } from './types'

const g95 = FUELS.gasolina95!

function stockCore(): CoreConfig {
  const engine = resolveEngine(stockEngine())
  return {
    geometry: engine.geometry,
    archetype: buildArchetype({
      geometry: engine.geometry,
      reciprocatingMass: engine.assembly.piston.spec.mass + 0.16,
      rotatingMassPerCyl: 0.35
    }),
    veCurve: engine.assembly.head.spec.veCurve,
    fuel: { stoichAFR: g95.stoichAFR, lhv: g95.lhv },
    injectorFlow: engine.assembly.injector.spec.staticFlow,
    injectorDutyMax: 0.85,
    turbo: { inertia: 6e-5, present: false },
    ambientP: 101325,
    ambientT: 298,
    humidity: 0.4
  }
}

function stockCalib(over: Partial<EcuCalib> = {}): EcuCalib {
  const engine = resolveEngine(stockEngine())
  return {
    idleRpm: 950,
    revLimit: 7200,
    lambdaBase: 1.0,
    lambdaWotDrop: 0.14,
    advIdle: 0.17,
    advMax: 0.56,
    advAtRpm: 7000,
    veEst: engine.assembly.head.spec.veCurve,
    injectorFlow: engine.assembly.injector.spec.staticFlow,
    injectorDutyMax: 0.85,
    stoichAFR: g95.stoichAFR,
    boostTarget: 0,
    ...over
  }
}

function run(loop: SimLoop, seconds: number, each?: (t: number) => void): void {
  const ticks = Math.round(seconds / TICK_DT)
  for (let t = 0; t < ticks; t++) {
    each?.(t)
    loop.tick(TICK_DT)
  }
}

describe('HIL fase 3: lazo cerrado ECU ↔ sensores ↔ actuadores', () => {
  it('la ECU arranca y gobierna el ralentí leyendo SOLO sensores', () => {
    const loop = new SimLoop(stockCore(), defaultHarness(11), stockCalib())
    loop.physical.ignitionKey = true
    run(loop, 6)
    // ralentí gobernado por histéresis sobre el régimen MEDIDO en el CKP
    expect(loop.core.rpm).toBeGreaterThan(700)
    expect(loop.core.rpm).toBeLessThan(1500)
    // y lo que la ECU cree medir se parece a la verdad (ruido+latencia incluidos)
    const err = Math.abs(loop.ecu.rpmMeasured - loop.core.rpm) / loop.core.rpm
    expect(err).toBeLessThan(0.2)
  })

  it('corte de régimen desde el CKP: sin acceso a variables del motor', () => {
    const loop = new SimLoop(stockCore(), defaultHarness(5), stockCalib({ revLimit: 3000 }))
    loop.physical.ignitionKey = true
    loop.physical.throttle = 1
    let rpmMax = 0
    run(loop, 6, () => {
      if (loop.core.rpm > rpmMax) rpmMax = loop.core.rpm
    })
    expect(rpmMax).toBeGreaterThan(2600) // llega al corte
    expect(rpmMax).toBeLessThan(3600) // y el corte (con latencia de sensor) lo frena
  })

  it('enriquecimiento en frío: el sensor ECT manda', () => {
    const duty = (ambientT: number): number => {
      const loop = new SimLoop({ ...stockCore(), ambientT }, defaultHarness(9), stockCalib())
      loop.physical.ignitionKey = true
      loop.physical.throttle = 0.4
      let load = 0
      run(loop, 4, () => {
        const err = loop.core.rpm - 3000
        load = Math.max(load + err * 0.002, 0)
        loop.physical.loadTorque = load + err * 0.1
      })
      return loop.actuators.actuator('inj')!.effective
    }
    const cold = duty(276)
    const warm = duty(320)
    expect(cold).toBeGreaterThan(warm * 1.04)
  })

  it('sensor MAP en fallo (open): la ECU empobrece y el motor pierde la potencia', () => {
    const power = (mapFail: boolean): number => {
      const harness: HarnessConfig = defaultHarness(4)
      if (mapFail) {
        const map = harness.sensors.find((s) => s.id === 'map')!
        map.failMode = 'open' // el ADC cae a su mínimo: 0.2 bar leídos
      }
      const loop = new SimLoop(stockCore(), harness, stockCalib())
      loop.physical.ignitionKey = true
      loop.physical.throttle = 1
      let load = 0
      run(loop, 6, () => {
        const err = loop.core.rpm - 3500
        load = Math.max(load + err * 0.002, 0)
        loop.physical.loadTorque = load + err * 0.1
      })
      // potencia sostenida ≈ par de freno absorbido a régimen constante
      return loop.physical.loadTorque
    }
    const healthy = power(false)
    const broken = power(true)
    expect(healthy).toBeGreaterThan(broken * 2)
  })

  it('DeadTime por tensión: con la batería baja el actuador responde tarde o nada', () => {
    const bank = new ActuatorBank(defaultHarness(1))
    const inj = bank.actuator('inj')!
    // a 13.8 V: dead ≈ 0.6 + 6/8.8 ≈ 1.3 ms → 0 ticks de retraso
    inj.command(0.5)
    bank.tick(13.8)
    expect(inj.effective).toBeCloseTo(0.5, 6)
    // a 6 V: dead ≈ 0.6 + 6/1 = 6.6 ms → ~2 ticks de retraso
    const bank2 = new ActuatorBank(defaultHarness(1))
    const inj2 = bank2.actuator('inj')!
    inj2.command(0.5)
    bank2.tick(6)
    expect(inj2.effective).toBe(0) // aún en el tubo
    bank2.tick(6)
    bank2.tick(6)
    expect(inj2.effective).toBeCloseTo(0.5, 6)
    // por debajo de vMin no abre
    const bank3 = new ActuatorBank(defaultHarness(1))
    const inj3 = bank3.actuator('inj')!
    inj3.command(1)
    for (let t = 0; t < 10; t++) bank3.tick(4.8)
    expect(inj3.effective).toBe(0)
  })

  it('fuerzas G: la lateral sostenida hunde la presión de aceite (verdad física)', () => {
    const loop = new SimLoop(stockCore(), defaultHarness(2), stockCalib())
    loop.physical.ignitionKey = true
    loop.physical.throttle = 0.5
    run(loop, 4)
    loop.tick(TICK_DT)
    const oilStraight = loop.sensors.truth[5 /* Tap.OilP */]!
    loop.physical.gy = 22 // ~2.2 g laterales
    run(loop, 0.5)
    const oilCornering = loop.sensors.truth[5]!
    expect(oilCornering).toBeLessThan(oilStraight * 0.85)
  })

  it('el lazo completo es determinista', () => {
    const runOnce = (): number => {
      const loop = new SimLoop(stockCore(), defaultHarness(77), stockCalib())
      loop.physical.ignitionKey = true
      loop.physical.throttle = 0.6
      run(loop, 3)
      return loop.core.omega + loop.core.manifoldP + loop.ecu.rpmMeasured
    }
    expect(runOnce()).toBe(runOnce())
  })
})

describe('HIL: caja negra enganchada al lazo real', () => {
  it('graba un arranque y las tres capas cuadran entre sí', () => {
    const loop = new SimLoop(stockCore(), defaultHarness(3), stockCalib())
    const bb = loop.attachBlackBox({ rateHz: 60, preRollS: 5, postRollS: 1 })
    loop.physical.ignitionKey = true
    run(loop, 3, () => {
      loop.physical.throttle = 0.35
    })

    expect(bb.frames).toBeGreaterThan(100)
    const csv = bb.toCsv()
    const cab = csv.split('\n')[0]!
    expect(cab).toContain('rpm[rpm]')
    expect(cab).toContain('map_real[bar]')
    expect(cab).toContain('map_ecu[bar]')
    expect(cab).toContain('cyl1_p[bar]')

    // El motor tiene que haber arrancado de verdad, no quedarse en ceros.
    const buf = new Float32Array(bb.channels.length)
    bb.frameAt(bb.frames - 1, buf)
    const iRpm = bb.channels.findIndex((c) => c.id === 'rpm')
    expect(buf[iRpm]!).toBeGreaterThan(500)

    // El sensor de MAP mide lo mismo que la verdad, pero NO exactamente: tiene
    // ruido, retraso y cuantización. Si coincidieran clavados, el HIL estaría
    // haciendo trampa y la caja negra no serviría para diagnosticar sensores.
    const iReal = bb.channels.findIndex((c) => c.id === 'map_real')
    const iEcu = bb.channels.findIndex((c) => c.id === 'map_ecu')
    expect(buf[iEcu]!).toBeCloseTo(buf[iReal]!, 0)
    expect(buf[iEcu]!).not.toBe(buf[iReal]!)
  })

  it('se dispara sola al pasarse de vueltas y conserva el ANTES del evento', () => {
    // Limitador muy alto para que el motor pueda sobrepasar el umbral de la caja.
    const loop = new SimLoop(stockCore(), defaultHarness(4), stockCalib({ revLimit: 9000 }))
    const bb = loop.attachBlackBox({
      rateHz: 60,
      preRollS: 4,
      postRollS: 0.5,
      triggers: [{ channel: 'rpm', op: '>', threshold: 4000, holdTicks: 2, label: 'sobrerrégimen' }]
    })
    loop.physical.ignitionKey = true
    run(loop, 8, () => {
      loop.physical.throttle = 1
    })

    expect(bb.estado).toBe('congelado')
    expect(bb.motivo).toBe('sobrerrégimen')
    expect(bb.tiempoDisparo).toBeGreaterThan(0)

    // La razón de ser de una caja negra: hay muestras ANTERIORES al disparo.
    const filas = bb.toCsv().split('\n').slice(1)
    const rel = filas.map((l) => Number(l.split(',')[1]))
    expect(rel.filter((r) => r < 0).length).toBeGreaterThan(30)
    expect(rel.filter((r) => r >= 0).length).toBeGreaterThan(10)
  })

  it('sin caja enganchada el lazo funciona igual', () => {
    const loop = new SimLoop(stockCore(), defaultHarness(3), stockCalib())
    expect(loop.blackBox).toBeNull()
    loop.physical.ignitionKey = true
    expect(() => run(loop, 1)).not.toThrow()
  })
})
