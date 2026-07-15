import { SensorManager } from './sensorManager'
import { ActuatorBank } from './actuators'
import { VirtualEcu } from './ecu'
import type { EcuCalib } from './ecu'
import { SimCore } from './engineCore'
import type { CoreConfig } from './engineCore'
import { St, Tap } from './types'
import type { HarnessConfig } from './types'

/**
 * SimLoop (Fase 3): el lazo HIL completo por tick, en este orden estricto:
 *
 *   física → writeTruth → SensorManager → ECU (solo sensores) →
 *   ActuatorBank (DeadTime con la batería REAL) → entradas de la física
 *
 * La ECU jamás toca SimCore: si quitas un cable del arnés, se queda ciega.
 * Las entradas "humanas"/de entorno (pedal, llave, G, caudales, freno de
 * banco) entran por `physical` — son el mundo, no el motor.
 */

export interface PhysicalInputs {
  throttle: number // pedal 0..1 (cable físico a la mariposa)
  ignitionKey: boolean
  coolantFlow: number
  loadTorque: number
  gx: number // m/s² longitudinal (+ = aceleración)
  gy: number // m/s² lateral
  gz: number
}

export class SimLoop {
  readonly core: SimCore
  readonly sensors: SensorManager
  readonly actuators: ActuatorBank
  readonly ecu: VirtualEcu
  readonly physical: PhysicalInputs

  constructor(coreCfg: CoreConfig, harness: HarnessConfig, calib: EcuCalib) {
    this.core = new SimCore(coreCfg)
    this.sensors = new SensorManager(harness)
    this.actuators = new ActuatorBank(harness)
    this.ecu = new VirtualEcu(
      {
        sensor: (id) => this.sensors.sensor(id),
        actuator: (id) => this.actuators.actuator(id)
      },
      calib
    )
    this.physical = {
      throttle: 0,
      ignitionKey: false,
      coolantFlow: 1,
      loadTorque: 0,
      gx: 0,
      gy: 0,
      gz: 0
    }
  }

  tick(dt: number): void {
    const core = this.core
    const phys = this.physical

    // ---- 1. mundo físico → núcleo (pedal por cable, entorno, banco) ----
    core.inputs.throttle = phys.throttle
    core.inputs.coolantFlow = phys.coolantFlow
    core.inputs.loadTorque = phys.loadTorque
    core.scalars[St.Gx] = phys.gx
    core.scalars[St.Gy] = phys.gy
    core.scalars[St.Gz] = phys.gz

    // ---- 2. verdad → bus de sensores ----
    core.writeTruth(this.sensors.truth)
    this.sensors.tick(dt)

    // ---- 3. ECU: caja negra leyendo SOLO sensores ----
    this.ecu.ignitionSwitch = phys.ignitionKey
    this.ecu.tick(dt)

    // ---- 4. actuadores con la tensión de batería REAL ----
    const vBatt = this.sensors.truth[Tap.BatteryV]!
    this.actuators.tick(vBatt)

    // ---- 5. efectos de actuador → entradas del núcleo ----
    const inj = this.actuators.actuator('inj')
    const coil = this.actuators.actuator('coil')
    const wg = this.actuators.actuator('wg')
    const fp = this.actuators.actuator('fp')

    let duty = inj ? inj.effective : 0
    // §3 fuerzas G: la aceleración longitudinal sostenida arrastra burbujas
    // en la línea — picos pobres (lean spikes) por encima de ~0.8 g
    const gAbs = Math.abs(phys.gx)
    if (gAbs > 7.8) duty *= Math.max(0.55, 1 - (gAbs - 7.8) * 0.06)
    // sin bomba de gasolina no hay presión de raíl: no hay inyección
    if (!fp || fp.effective < 0.5) duty = 0
    core.inputs.injDuty = duty
    core.inputs.fuelCut = duty <= 0.005
    core.inputs.ignition = phys.ignitionKey
    core.inputs.sparkAdvance = coil ? coil.effective : 0.2
    core.inputs.wastegate = wg ? wg.effective : 0
    // arranque: llave girada con motor casi parado
    core.inputs.starter = phys.ignitionKey && core.rpm < 320

    // (las G laterales las aplica el propio núcleo sobre la presión de
    // aceite: viven en St.Gy y el tick las recalcula cada paso)

    // ---- 6. física ----
    core.tick(dt)
  }
}
