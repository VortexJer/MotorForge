import type { ActuatorPort, EcuPort, SensorInstance } from './types'

/**
 * ECU virtual (Fase 3): CAJA NEGRA LÓGICA.
 *
 * No recibe EngineState, ni SimCore, ni geometría — SOLO un EcuPort. Todo lo
 * que "sabe" del motor lo deduce de sensores con ruido, latencia y ADC:
 *  - régimen: DERIVADA del ángulo del CKP entre lecturas (filtrada EMA)
 *  - carga: sensor MAP  ·  pedal: sensor TPS  ·  frío: sensor ECT
 *  - compensación de inyector: sensor de batería (¡si miente, la mezcla sale mal!)
 * Y todo lo que "hace" sale por actuadores con DeadTime real: duty de
 * inyector (speed-density), avance por la bobina, wastegate PI y bomba.
 *
 * Zero-allocation: referencias de sensores/actuadores resueltas y cacheadas
 * en el constructor; tick() no asigna.
 */

export interface EcuCalib {
  idleRpm: number
  revLimit: number
  /** λ objetivo = base − enriquecimiento por TPS. */
  lambdaBase: number
  lambdaWotDrop: number
  /** Avance (rad): lineal con el régimen medido. */
  advIdle: number
  advMax: number
  advAtRpm: number
  /** Estimación de VE de la calibración (tabla plana rpm→ve). */
  veEst: Array<[number, number]>
  /** Datos de inyector que la ECU tiene calibrados. */
  injectorFlow: number
  injectorDutyMax: number
  stoichAFR: number
  /** Objetivo de boost (Pa relativos); 0 = motor atmosférico. */
  boostTarget: number
}

export class VirtualEcu {
  private readonly calib: EcuCalib
  // sensores cableados (resueltos una vez)
  private readonly sCkp: SensorInstance | null
  private readonly sMap: SensorInstance | null
  private readonly sTps: SensorInstance | null
  private readonly sEct: SensorInstance | null
  private readonly sIat: SensorInstance | null
  private readonly sVbat: SensorInstance | null
  // actuadores
  private readonly aInj: ActuatorPort | null
  private readonly aCoil: ActuatorPort | null
  private readonly aWg: ActuatorPort | null
  private readonly aFp: ActuatorPort | null
  // estado interno (preasignado)
  private prevCkp = 0
  private omegaMeas = 0
  private wgInteg = 0
  private fuelCutLatch = false
  /** VE aplanada de la calibración. */
  private readonly veRpm: Float64Array
  private readonly veVal: Float64Array

  /** Encendido de contacto (llave): entrada humana, no del motor. */
  ignitionSwitch = false

  constructor(port: EcuPort, calib: EcuCalib) {
    this.calib = calib
    this.sCkp = port.sensor('ckp')
    this.sMap = port.sensor('map')
    this.sTps = port.sensor('tps')
    this.sEct = port.sensor('ect')
    this.sIat = port.sensor('iat')
    this.sVbat = port.sensor('vbatt')
    this.aInj = port.actuator('inj')
    this.aCoil = port.actuator('coil')
    this.aWg = port.actuator('wg')
    this.aFp = port.actuator('fp')
    this.veRpm = new Float64Array(calib.veEst.length)
    this.veVal = new Float64Array(calib.veEst.length)
    for (let i = 0; i < calib.veEst.length; i++) {
      this.veRpm[i] = calib.veEst[i]![0]
      this.veVal[i] = calib.veEst[i]![1]
    }
    this.prevCkp = this.sCkp ? this.sCkp.read() : 0
  }

  /** RPM que la ECU CREE tener (derivada filtrada del CKP). */
  get rpmMeasured(): number {
    return (this.omegaMeas * 60) / (2 * Math.PI)
  }

  private veAt(rpm: number): number {
    const xs = this.veRpm
    const ys = this.veVal
    if (xs.length === 0) return 0.85
    if (rpm <= xs[0]!) return ys[0]!
    const last = xs.length - 1
    if (rpm >= xs[last]!) return ys[last]!
    for (let i = 1; i <= last; i++) {
      if (rpm <= xs[i]!) {
        const t = (rpm - xs[i - 1]!) / (xs[i]! - xs[i - 1]!)
        return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!)
      }
    }
    return ys[last]!
  }

  tick(dt: number): void {
    const c = this.calib

    // ---- régimen desde el CKP: derivada del ángulo con filtro EMA ----
    if (this.sCkp) {
      const ckp = this.sCkp.read()
      const raw = (ckp - this.prevCkp) / dt
      this.prevCkp = ckp
      // descarta saltos absurdos (glitch de sensor) y filtra
      if (raw > -50 && raw < 2200) this.omegaMeas += (raw - this.omegaMeas) * 0.18
    }
    const rpm = this.rpmMeasured

    // ---- lecturas de gestión ----
    const tps = this.sTps ? Math.min(Math.max(this.sTps.read(), 0), 1) : 0
    const pMap = this.sMap ? this.sMap.read() : 1e5
    const ect = this.sEct ? this.sEct.read() : 360
    const iat = this.sIat ? this.sIat.read() : 300
    const vbat = this.sVbat ? this.sVbat.read() : 13.8

    // ---- bomba de gasolina: con contacto ----
    if (this.aFp) this.aFp.command(this.ignitionSwitch ? 1 : 0)

    // ---- corte: límite de régimen + gobernador de ralentí (histéresis) ----
    if (rpm >= c.revLimit) this.fuelCutLatch = true
    else if (rpm < c.revLimit * 0.985) {
      if (tps < 0.04) {
        if (rpm > c.idleRpm * 1.3) this.fuelCutLatch = true
        else if (rpm < c.idleRpm * 1.05) this.fuelCutLatch = false
      } else this.fuelCutLatch = false
    }
    const cut = !this.ignitionSwitch || this.fuelCutLatch

    // ---- speed-density: masa de aire estimada CON LO QUE VE ----
    const veE = this.veAt(rpm)
    // Vd por cilindro no lo "sabe": va embebido en la calibración de VE·Vd
    // → usamos flujo por ciclo normalizado con la constante de calibración
    const rhoEst = pMap / (287 * Math.max(iat, 230))
    const mAirEst = veE * rhoEst * this.vdCal
    // λ objetivo: base − caída por pedal − enriquecimiento en frío
    const coldEnrich = ect < 330 ? ((330 - ect) / 90) * 0.12 : 0
    const lambdaT = Math.max(c.lambdaBase - c.lambdaWotDrop * tps - coldEnrich, 0.75)
    const mFuel = mAirEst / (c.stoichAFR * lambdaT)
    const cycleTime = rpm > 100 ? 120 / rpm : 1.2
    let duty = mFuel / (c.injectorFlow * cycleTime)
    // compensación de DeadTime por batería (tabla clásica): si el sensor de
    // batería miente, esta compensación sale MAL y la mezcla se resiente
    const deadComp = Math.min(0.02 + 0.06 / Math.max(vbat - 5, 0.5), 0.08)
    duty = Math.min(Math.max(duty + deadComp * (rpm / 6000), 0), c.injectorDutyMax)
    if (this.aInj) this.aInj.command(cut ? 0 : duty)

    // ---- avance por la bobina (el valor viaja con el retardo de encendido) ----
    const adv = c.advIdle + (c.advMax - c.advIdle) * Math.min(rpm / c.advAtRpm, 1)
    if (this.aCoil) this.aCoil.command(cut ? c.advIdle : adv)

    // ---- wastegate PI sobre el MAP medido ----
    if (this.aWg) {
      if (c.boostTarget > 0) {
        const boostMeas = pMap - 101325
        const err = boostMeas - c.boostTarget
        this.wgInteg = Math.min(Math.max(this.wgInteg + err * dt * 4e-6, 0), 1)
        const wg = Math.min(Math.max(err * 8e-6 + this.wgInteg, 0), 1)
        this.aWg.command(wg)
      } else {
        this.aWg.command(0)
      }
    }
  }

  /** Constante de calibración VE·Vd por cilindro (m³): "sabe" el motor que
   *  le cargaron en fábrica, no el que tiene delante. */
  vdCal = 5.0e-4
}
