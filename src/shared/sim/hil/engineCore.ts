import type { ResolvedGeometry } from '../types'
import { Cyl, St, Tap } from './types'
import type { EngineArchetype } from './archetype'

/**
 * Núcleo de física de primeros principios (Fase 2).
 *
 * Nada de curvas de par: la presión en cámara se integra con la EDO
 * monozona clásica  dp = [ (γ−1)·dQ − γ·p·dV ] / V  (liberación de calor de
 * Wiebe + trabajo de expansión), la fuerza de gas e inercia alternativa se
 * proyectan al cigüeñal por la cinemática biela-manivela exacta (dS/dθ), y
 * la velocidad del motor emerge de  I·dω/dt = ΣT_cil − T_fricción − T_carga.
 *
 * Integradores (ADR-001): Euler semi-implícito con SUB-PASOS de ≤~1.7° de
 * cigüeñal para el conjunto cilindros+cigüeñal (RHS caro, no-stiff), y RK4 a
 * nivel de tick para los estados lentos [ω_turbo, p_colector, T_bloque, IAT].
 * El freno motor con mariposa cerrada NO está programado: emerge del lazo de
 * bombeo (admisión a depresión).
 *
 * Fricción: Chen-Flynn  FMEP = C1 + Cp·p_pico + C2·v̄p + C3·v̄p²  escalada por
 * viscosidad de aceite con la ecuación de VOGEL  μ(T)=A·exp(B/(T−C)).
 *
 * Zero-allocation: toda la memoria vive en el constructor; tick() y los
 * getters no asignan.
 */

const GAMMA = 1.32
const R_GAS = 287
const CP_EXH = 1090
const CP_AIR = 1005
const P_STD = 101325

// Chen-Flynn (Pa, con v̄p en m/s)
const CF_C1 = 0.25e5
const CF_CP = 0.006
const CF_C2 = 500
const CF_C3 = 12

// Vogel para un 10W-40: μ(T) = A·exp(B/(T − C)); solo usamos el COCIENTE
// respecto a T_ref=90 °C, así que A se cancela.
const VOGEL_B = 780
const VOGEL_C = 178
const VOGEL_TREF = 363

/** Sub-paso máximo del cigüeñal (rad): ~1.7° para resolver el Wiebe. */
const DTHETA_MAX = 0.03
const MAX_SUBSTEPS = 480

const TAU_INTAKE = 0.0022
const TAU_EXHAUST = 0.0018

export interface CoreInputs {
  throttle: number // 0..1 (mariposa física)
  ignition: boolean
  starter: boolean
  /** Corte de inyección (lo decide la ECU, no el núcleo). */
  fuelCut: boolean
  /** Duty de inyector mandado por la ECU (0..1): la cantidad de combustible
   *  ES el ancho de pulso — así el DeadTime del actuador tiene efecto real. */
  injDuty: number
  sparkAdvance: number
  /** Apertura de wastegate 0..1 (1 = sangra toda la turbina). */
  wastegate: number
  coolantFlow: number // 0..1
  /** Par de carga externo (freno de banco), N·m. */
  loadTorque: number
}

export interface CoreConfig {
  geometry: ResolvedGeometry
  archetype: EngineArchetype
  /** Curva VE de la culata (dato físico de la pieza, ver decisión #2). */
  veCurve: Array<[number, number]>
  fuel: { stoichAFR: number; lhv: number }
  /** Caudal estático de UN inyector (kg/s) y su duty máximo. */
  injectorFlow: number
  injectorDutyMax: number
  turbo: { inertia: number; present: boolean }
  ambientP: number
  ambientT: number
  humidity: number // 0..1
}

// scratch por cilindro (privado del núcleo)
const enum SC {
  Pressure = 0, // Pa
  Vprev, // m³
  TrappedMass, // kg
  QTotal, // J de este ciclo
  PrevXb, // fracción quemada acumulada
  PeakP, // pico del ciclo en curso
  PeakPHold, // pico del último ciclo completado
  Region, // 0 power, 1 escape, 2 admisión, 3 compresión
  STRIDE
}

const region = (thC: number): number => {
  if (thC < Math.PI) return 0
  if (thC < 2 * Math.PI) return 1
  if (thC < 3 * Math.PI) return 2
  return 3
}

export class SimCore {
  readonly scalars: Float64Array
  readonly perCyl: Float64Array
  readonly inputs: CoreInputs

  private readonly cfg: CoreConfig
  private readonly sc: Float64Array
  private readonly n: number
  private readonly area: number
  private readonly r: number
  private readonly l: number
  private readonly lambdaR: number
  private readonly vDispCyl: number
  private readonly vClear: number
  private readonly vManifold: number
  private readonly throttleArea: number
  private readonly rGasMoist: number
  // curva VE aplanada (sin asignar en tick)
  private readonly veRpm: Float64Array
  private readonly veVal: Float64Array
  // RK4 preasignado para [ω_turbo, p_man, T_bloque, IAT]
  private readonly k1 = new Float64Array(4)
  private readonly k2 = new Float64Array(4)
  private readonly k3 = new Float64Array(4)
  private readonly k4 = new Float64Array(4)
  private readonly ytmp = new Float64Array(4)
  // salidas filtradas
  private torqueFilt = 0
  private egt = 500
  private heatRate = 0 // W medios de calor liberado (para T_bloque)

  constructor(cfg: CoreConfig) {
    this.cfg = cfg
    const g = cfg.geometry
    this.n = g.cylinders
    this.area = (Math.PI * g.bore * g.bore) / 4
    this.r = g.stroke / 2
    this.l = g.rodLength
    this.lambdaR = this.r / this.l
    this.vDispCyl = this.area * g.stroke
    this.vClear = g.clearanceVolume
    this.vManifold = 1.5 * this.vDispCyl * this.n
    this.throttleArea = 0.0028 // m² de mariposa 60 mm — brida estándar
    // aire húmedo: R sube con el vapor (R_v=461); q ≈ 0.012·HR a 25 °C
    this.rGasMoist = R_GAS * (1 + 0.61 * 0.012 * cfg.humidity)

    this.veRpm = new Float64Array(cfg.veCurve.length)
    this.veVal = new Float64Array(cfg.veCurve.length)
    for (let i = 0; i < cfg.veCurve.length; i++) {
      this.veRpm[i] = cfg.veCurve[i]![0]
      this.veVal[i] = cfg.veCurve[i]![1]
    }

    this.scalars = new Float64Array(St.COUNT)
    this.perCyl = new Float64Array(this.n * Cyl.STRIDE)
    this.sc = new Float64Array(this.n * SC.STRIDE)

    const s = this.scalars
    s[St.BlockTemp] = cfg.ambientT
    s[St.IntakeAirT] = cfg.ambientT
    s[St.AmbientP] = cfg.ambientP
    s[St.AmbientT] = cfg.ambientT
    s[St.Humidity] = cfg.humidity
    s[St.BatteryV] = 13.8
    s[St.OilPressure] = 0
    // colector arranca a ambiente; cilindros a presión ambiente
    s[St.CrankAngle] = 0
    s[St.CrankOmega] = 0
    s[St.Throttle] = 0
    // p_man vive en el vector RK4; espejo en scalars para taps
    this.y[1] = cfg.ambientP
    this.y[2] = cfg.ambientT
    this.y[3] = cfg.ambientT

    for (let i = 0; i < this.n; i++) {
      const b = i * SC.STRIDE
      this.sc[b + SC.Pressure] = cfg.ambientP
      this.sc[b + SC.Vprev] = this.volumeAt(this.cycleAngle(i))
      this.sc[b + SC.Region] = region(this.cycleAngle(i))
      this.perCyl[i * Cyl.STRIDE + Cyl.EffectiveRodArea] = 3.0e-4
    }

    this.inputs = {
      throttle: 0,
      ignition: false,
      starter: false,
      fuelCut: false,
      injDuty: 0,
      sparkAdvance: 0.26,
      wastegate: 0,
      coolantFlow: 1,
      loadTorque: 0
    }
  }

  /** Estados lentos [ω_turbo, p_man, T_bloque, IAT] integrados con RK4. */
  private readonly y = new Float64Array([0, P_STD, 293, 293])

  // ---------------------------------------------------------- cinemática
  private cycleAngle(i: number): number {
    const fourPi = 4 * Math.PI
    const th = this.scalars[St.CrankAngle]! + this.cfg.archetype.cyclePhase[i]! + this.cfg.archetype.bankOffset[i]!
    return ((th % fourPi) + fourPi) % fourPi
  }

  private pistonPos(thC: number): number {
    const s = Math.sin(thC)
    return this.r * (1 - Math.cos(thC)) + this.l * (1 - Math.sqrt(1 - this.lambdaR * this.lambdaR * s * s))
  }

  private volumeAt(thC: number): number {
    return this.vClear + this.area * this.pistonPos(thC)
  }

  /** dS/dθ exacto: brazo de par de la biela-manivela. */
  private dSdTheta(thC: number): number {
    const s = Math.sin(thC)
    const root = Math.sqrt(Math.max(1 - this.lambdaR * this.lambdaR * s * s, 1e-9))
    return this.r * s + (this.r * this.lambdaR * s * Math.cos(thC)) / root
  }

  private ve(rpm: number): number {
    const xs = this.veRpm
    const ys = this.veVal
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

  /** Wiebe acumulada sobre φ∈[φ0, φ0+dur] alrededor del PMS (φ=0). */
  private wiebeX(phi: number, phi0: number, dur: number): number {
    if (phi <= phi0) return 0
    const x = (phi - phi0) / dur
    if (x >= 1) return 1
    return 1 - Math.exp(-5 * Math.pow(x, 3))
  }

  // ---------------------------------------------------------- tick
  tick(dt: number): void {
    const s = this.scalars
    const inp = this.inputs
    const g = this.cfg.geometry
    const arch = this.cfg.archetype

    s[St.Throttle] = inp.throttle
    const pMan = this.y[1]!
    const iat = this.y[3]!
    const omega0 = s[St.CrankOmega]!
    const rpm = (omega0 * 60) / (2 * Math.PI)

    // ---- fricción del tick (Chen-Flynn × Vogel) ----
    const vp = (2 * g.stroke * rpm) / 60
    let peakAvg = 0
    for (let i = 0; i < this.n; i++) peakAvg += this.sc[i * SC.STRIDE + SC.PeakPHold]!
    peakAvg = peakAvg / this.n
    const tOil = this.y[2]! // el aceite sigue al bloque
    const visc = Math.exp(VOGEL_B / (tOil - VOGEL_C) - VOGEL_B / (VOGEL_TREF - VOGEL_C))
    const viscFactor = Math.pow(Math.min(Math.max(visc, 0.5), 40), 0.35)
    const fmep = (CF_C1 + CF_CP * peakAvg + CF_C2 * vp + CF_C3 * vp * vp) * viscFactor
    const tFriction = (fmep * this.vDispCyl * this.n) / (4 * Math.PI)

    // ---- sub-pasos del cigüeñal + cilindros ----
    let omega = omega0
    let theta = s[St.CrankAngle]!
    const steps = Math.min(Math.max(Math.ceil((Math.abs(omega) * dt) / DTHETA_MAX), 1), MAX_SUBSTEPS)
    const h = dt / steps
    let torqueAccum = 0
    let heatAccum = 0

    for (let st = 0; st < steps; st++) {
      // par instantáneo con el estado actual
      let tGas = 0
      for (let i = 0; i < this.n; i++) {
        const b = i * SC.STRIDE
        const thC = this.cycAngleOf(theta, i)
        const p = this.sc[b + SC.Pressure]!
        const fGas = (p - this.cfg.ambientP) * this.area
        const aRecip = omega * omega * this.r * (Math.cos(thC) + this.lambdaR * Math.cos(2 * thC))
        const f = fGas - arch.reciprocatingMass * aRecip
        tGas += f * this.dSdTheta(thC)
      }
      // par de arranque efectivo (motor + reductora ~10:1): debe vencer la
      // primera compresión, como en la realidad
      let tStarter = 0
      if (inp.starter && omega < 100) tStarter = 140 * (1 - omega / 100)
      const fricNow = omega > 1 ? tFriction : tFriction * omega // sin ω no hay fricción viscosa
      const tNet = tGas + tStarter - fricNow - inp.loadTorque
      omega += (tNet / arch.crankInertia) * h
      if (omega < 0 && !inp.starter) omega = 0
      theta += omega * h
      torqueAccum += tNet * h

      // avanzar termodinámica de cada cilindro al nuevo ángulo
      for (let i = 0; i < this.n; i++) {
        heatAccum += this.stepCylinder(i, theta, pMan, iat, omega, h)
      }
    }

    s[St.CrankOmega] = omega
    s[St.CrankAngle] = theta
    this.torqueFilt += ((torqueAccum / dt) - this.torqueFilt) * Math.min(1, dt * 12)
    this.heatRate += ((heatAccum / dt) - this.heatRate) * Math.min(1, dt * 4)

    // ---- estados lentos con RK4 ----
    this.rk4(dt, omega)

    // espejo a scalars (taps y telemetría)
    s[St.TurboOmega] = this.y[0]!
    s[St.BlockTemp] = this.y[2]!
    s[St.IntakeAirT] = this.y[3]!
    // presión de aceite ∝ régimen × viscosidad (bomba volumétrica);
    // §3: las G laterales descuelgan la película (multiplicador destructivo)
    const gyAbs = Math.abs(s[St.Gy]!)
    const gStarve = gyAbs > 9.8 ? Math.max(0.25, 1 - (gyAbs - 9.8) * 0.08) : 1
    s[St.OilPressure] = Math.min(6e5, 900 * omega * Math.min(visc, 8)) * gStarve
    // batería: cae en arranque (el motor de arranque chupa), sube con alternador
    s[St.BatteryV] = inp.starter && omega < 100 ? 10.2 : rpm > 500 ? 13.9 : 12.5
    // EGT filtrada hacia la última muestra de escape
    // (la muestra se actualiza en el evento EVO de cada cilindro)
    for (let i = 0; i < this.n; i++) {
      this.perCyl[i * Cyl.STRIDE + Cyl.Pressure] = this.sc[i * SC.STRIDE + SC.Pressure]!
    }
  }

  private cycAngleOf(theta: number, i: number): number {
    const fourPi = 4 * Math.PI
    const th = theta + this.cfg.archetype.cyclePhase[i]! + this.cfg.archetype.bankOffset[i]!
    return ((th % fourPi) + fourPi) % fourPi
  }

  /** Devuelve el calor liberado (J) en el sub-paso. */
  private stepCylinder(i: number, theta: number, pMan: number, iat: number, omega: number, h: number): number {
    const b = i * SC.STRIDE
    const sc = this.sc
    const thC = this.cycAngleOf(theta, i)
    const reg = region(thC)
    const prevReg = sc[b + SC.Region]!
    const vNew = this.volumeAt(thC)
    const vOld = sc[b + SC.Vprev]!
    let p = sc[b + SC.Pressure]!
    let dQ = 0

    if (reg !== prevReg) {
      if (reg === 3) {
        // IVC: atrapa masa y decide el combustible del ciclo (provisional
        // hasta que la ECU de Fase 3 mande por actuadores)
        const rpm = (omega * 60) / (2 * Math.PI)
        const m = this.ve(rpm) * (pMan / (this.rGasMoist * iat)) * this.vDispCyl
        sc[b + SC.TrappedMass] = m
        p = pMan
        sc[b + SC.PrevXb] = 0
        let q = 0
        if (this.inputs.ignition && !this.inputs.fuelCut && omega > 5) {
          const cycleTime = (4 * Math.PI) / Math.max(omega, 1)
          const duty = Math.min(Math.max(this.inputs.injDuty, 0), this.cfg.injectorDutyMax)
          const mFuel = this.cfg.injectorFlow * duty * cycleTime
          const burnable = Math.min(mFuel, m / this.cfg.fuel.stoichAFR)
          q = burnable * this.cfg.fuel.lhv * 0.9
        }
        sc[b + SC.QTotal] = q
      } else if (reg === 1) {
        // EVO: muestra de EGT del gas al final de la expansión
        const m = Math.max(sc[b + SC.TrappedMass]!, 1e-7)
        const tGas = (p * vOld) / (m * R_GAS)
        this.egt += (Math.min(Math.max(tGas, 400), 1400) - this.egt) * 0.25
        sc[b + SC.PeakPHold] = sc[b + SC.PeakP]!
        sc[b + SC.PeakP] = 0
      }
      sc[b + SC.Region] = reg
    }

    if (reg === 3 || reg === 0) {
      // ciclo cerrado: EDO monozona dp = [(γ−1)dQ − γ p dV]/V
      const phi = thC < Math.PI ? thC : thC - 4 * Math.PI // φ=0 en el PMS de encendido
      const dur = 0.65 + 0.3 * Math.min(omega / 900, 1)
      const phi0 = -this.inputs.sparkAdvance
      const x1 = this.wiebeX(phi, phi0, dur)
      dQ = sc[b + SC.QTotal]! * Math.max(0, x1 - sc[b + SC.PrevXb]!)
      sc[b + SC.PrevXb] = Math.max(sc[b + SC.PrevXb]!, x1)
      const dV = vNew - vOld
      p += ((GAMMA - 1) * dQ - GAMMA * p * dV) / Math.max(vNew, 1e-7)
      // blow-by de segmentos: fuga leve (τ≈0.9 s) — despreciable a régimen,
      // pero al girar despacio evita que la compresión rebote como un muelle
      p += (this.cfg.ambientP - p) * Math.min(1, h / 0.9)
      if (p < 2000) p = 2000
      if (p > sc[b + SC.PeakP]!) sc[b + SC.PeakP] = p
    } else if (reg === 1) {
      const pExh = this.cfg.ambientP + this.exhaustBackpressure()
      p += (pExh - p) * Math.min(1, h / TAU_EXHAUST)
    } else {
      p += (pMan - p) * Math.min(1, h / TAU_INTAKE)
    }

    sc[b + SC.Pressure] = p
    sc[b + SC.Vprev] = vNew
    return dQ
  }

  private exhaustBackpressure(): number {
    // restricción de la turbina: crece con el flujo de escape
    const mdot = this.engineAirflow(this.y[1]!, this.y[3]!, this.scalars[St.CrankOmega]!) * 1.07
    return this.cfg.turbo.present ? 5.5e5 * mdot * (1 - 0.6 * this.inputs.wastegate) : 1.2e5 * mdot * 0.3
  }

  private engineAirflow(pMan: number, iat: number, omega: number): number {
    const rpm = (omega * 60) / (2 * Math.PI)
    return this.ve(rpm) * (pMan / (this.rGasMoist * iat)) * this.vDispCyl * this.n * (omega / (4 * Math.PI))
  }

  // ---------------------------------------------------------- RK4 lento
  /** RHS de [ω_turbo, p_man, T_bloque, IAT] → escribe en out. */
  private rhs(out: Float64Array, y: Float64Array, omega: number): void {
    const cfg = this.cfg
    const wt = y[0]!
    const pMan = y[1]!
    const tBlock = y[2]!
    const iat = y[3]!
    const pAmb = cfg.ambientP

    // compresor centrífugo simplificado: PR = 1 + k·ω² (k: PR 2.2 a 13k rad/s)
    const prC = cfg.turbo.present ? 1 + (wt * wt) / 1.3e8 : 1
    const pUp = pAmb * prC
    const tComp = cfg.ambientT * (Math.pow(prC, 0.286) - 1) / 0.72
    const tUp = cfg.ambientT + tComp * 0.25 // intercooler ~75% eficaz
    const rhoUp = pUp / (R_GAS * tUp)

    // mariposa: tobera isentrópica CON BLOQUEO SÓNICO (pr crítica 0.528) —
    // sin esto, a gas parcial el caudal crece sin límite y el motor se embala
    const aThr = this.throttleArea * Math.max(this.inputs.throttle, 0.012)
    let mdotIn: number
    if (pMan < pUp) {
      const pr = Math.max(pMan / pUp, 1e-3)
      const gAir = 1.4
      if (pr < 0.5283) {
        // bloqueada: caudal máximo independiente de pMan
        mdotIn = 0.82 * aThr * pUp * Math.sqrt(gAir / (R_GAS * tUp)) * 0.5787
      } else {
        const flux = Math.sqrt(
          ((2 * gAir) / (R_GAS * tUp * (gAir - 1))) *
            (Math.pow(pr, 2 / gAir) - Math.pow(pr, (gAir + 1) / gAir))
        )
        mdotIn = 0.82 * aThr * pUp * flux
      }
    } else {
      // reflujo suave (sobrepresión de colector)
      mdotIn = -0.82 * aThr * Math.sqrt(2 * rhoUp * (pMan - pUp))
    }
    const mdotOut = this.engineAirflow(pMan, iat, omega)
    out[1] = ((R_GAS * iat) / this.vManifold) * (mdotIn - mdotOut)

    // rotor del turbo: dω = (T_turb − T_comp − T_fric)/I  (pliego §1)
    if (cfg.turbo.present) {
      const mdotEx = mdotOut * 1.07
      const prT = 1 + (6.5 * mdotEx * this.egt) / 900
      const pTurb = 0.55 * mdotEx * CP_EXH * this.egt * (1 - Math.pow(prT, -0.26)) * (1 - this.inputs.wastegate)
      const pComp = Math.max(mdotIn, 0) * CP_AIR * cfg.ambientT * (Math.pow(prC, 0.286) - 1) / 0.72
      const wSafe = Math.max(wt, 120)
      const tFric = 1.3e-6 * wt
      out[0] = (pTurb / wSafe - pComp / wSafe - tFric) / cfg.turbo.inertia
    } else {
      out[0] = -wt
    }

    // bloque: retiene el calor de combustión y lo cede al refrigerante (Newton)
    const cBlock = 90000 // J/K — capacidad calorífica del bloque
    const qIn = 0.22 * this.heatRate
    const qCoolant = (1500 * this.inputs.coolantFlow + 45) * (tBlock - cfg.ambientT)
    out[2] = (qIn - qCoolant) / cBlock

    // IAT con heat-soak (Newton): con flujo, el aire fresco barre hacia tUp;
    // parado, el bloque cuece el colector con τ configurable
    out[3] = (0.9 * (tBlock - iat) - (iat - tUp) * (0.35 + 260 * Math.max(mdotIn, 0))) / 60
  }

  private rk4(dt: number, omega: number): void {
    const y = this.y
    const { k1, k2, k3, k4, ytmp } = this
    this.rhs(k1, y, omega)
    for (let j = 0; j < 4; j++) ytmp[j] = y[j]! + 0.5 * dt * k1[j]!
    this.rhs(k2, ytmp, omega)
    for (let j = 0; j < 4; j++) ytmp[j] = y[j]! + 0.5 * dt * k2[j]!
    this.rhs(k3, ytmp, omega)
    for (let j = 0; j < 4; j++) ytmp[j] = y[j]! + dt * k3[j]!
    this.rhs(k4, ytmp, omega)
    for (let j = 0; j < 4; j++) {
      y[j] = y[j]! + (dt / 6) * (k1[j]! + 2 * k2[j]! + 2 * k3[j]! + k4[j]!)
    }
    if (y[0]! < 0) y[0] = 0
    if (y[1]! < 2000) y[1] = 2000
    if (y[2]! < this.cfg.ambientT) y[2] = this.cfg.ambientT
    if (y[3]! < this.cfg.ambientT) y[3] = this.cfg.ambientT
  }

  // ---------------------------------------------------------- lecturas
  get omega(): number {
    return this.scalars[St.CrankOmega]!
  }
  get rpm(): number {
    return (this.scalars[St.CrankOmega]! * 60) / (2 * Math.PI)
  }
  get manifoldP(): number {
    return this.y[1]!
  }
  get boost(): number {
    return Math.max(0, this.y[1]! - this.cfg.ambientP)
  }
  get turboOmega(): number {
    return this.y[0]!
  }
  get blockTemp(): number {
    return this.y[2]!
  }
  get intakeAirT(): number {
    return this.y[3]!
  }
  get exhaustTemp(): number {
    return this.egt
  }
  get meanTorque(): number {
    return this.torqueFilt
  }
  /** Pico de presión medio del último ciclo (Pa) — para los chequeos de fallo. */
  get peakPressure(): number {
    let acc = 0
    for (let i = 0; i < this.n; i++) acc += this.sc[i * SC.STRIDE + SC.PeakPHold]!
    return acc / this.n
  }

  /**
   * Vuelca la "verdad" física a las tomas del bus (cero asignaciones).
   * ESTE es el único camino de la física hacia los sensores.
   */
  writeTruth(truth: Float64Array): void {
    const s = this.scalars
    truth[Tap.CrankAngle] = s[St.CrankAngle]!
    truth[Tap.CrankOmega] = s[St.CrankOmega]!
    truth[Tap.ManifoldP] = this.y[1]!
    truth[Tap.ManifoldT] = this.y[3]!
    truth[Tap.CoolantT] = this.y[2]!
    truth[Tap.OilP] = s[St.OilPressure]!
    truth[Tap.RailP] = 3.5e5 + Math.max(this.y[1]! - this.cfg.ambientP, 0)
    truth[Tap.ExhaustT] = this.egt
    truth[Tap.BlockKnockAccel] = 0 // acoplamiento con el modelo de picado: futuro
    truth[Tap.BatteryV] = s[St.BatteryV]!
    truth[Tap.IntakeAirT] = this.y[3]!
    truth[Tap.TurboOmega] = this.y[0]!
    truth[Tap.CamPhase] = (s[St.CrankAngle]! / 2) % (2 * Math.PI)
    truth[Tap.ThrottlePos] = this.inputs.throttle
    truth[Tap.VehicleGx] = s[St.Gx]!
    truth[Tap.VehicleGy] = s[St.Gy]!
    truth[Tap.VehicleGz] = s[St.Gz]!
  }
}
