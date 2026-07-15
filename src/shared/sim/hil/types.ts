/**
 * HIL virtual (gemelo digital): contratos del bus de señales.
 *
 * ============================ ADR-001 (Fase 1) ============================
 * Decisiones de arquitectura fijadas con el usuario (2026-07-15):
 *
 * 1. TICK a dt fijo = 1/240 s. El loop de render (60 Hz) alimenta un
 *    acumulador; la física SIEMPRE integra a 240 Hz. El SimLoop vivirá en un
 *    Web Worker dedicado: aísla la física del hilo de render y permite que
 *    el MISMO código corra headless en Node para el test de rendimiento de
 *    Fase 4 (10.000 ticks sin Electron).
 *
 * 2. INTEGRADORES: RK4 para las EDOs suaves y baratas de evaluar (rotor del
 *    turbo, térmica del bloque/heat-soak, presión de raíl). Euler
 *    semi-implícito para la dinámica rotacional del cigüeñal: su RHS integra
 *    la presión de cámara resuelta por ángulo (caro), es no-stiff a
 *    dt=1/240, y RK4 cuadruplicaría el coste sin ganancia práctica.
 *
 * 3. Float64Array PARA ESTADO FÍSICO, Float32Array PARA RINGS DE SENSORES.
 *    Desviación razonada del pliego (que pedía Float32): en V8 los
 *    Float32Array NO aceleran el cómputo — internamente todo se opera como
 *    double y cada lectura/escritura f32 añade una conversión. Solo ahorran
 *    memoria/ancho de banda de caché. El estado físico son pocas decenas de
 *    escalares leídos/escritos cada tick: ahí la precisión de float64 vale
 *    más que el ahorro. Los rings de sensores sí son arrays grandes que se
 *    recorren en bloque: ahí Float32 aprovecha la caché y el ruido de
 *    cuantización de f32 queda por debajo del NoiseFloor eléctrico simulado.
 *
 * 4. CABLEADO DECLARATIVO: HarnessConfig viaja en el proyecto
 *    (.mforge.json, campo `harness`), con preset de serie. UI interactiva de
 *    cableado: BACKLOG, fuera de esta iteración.
 *
 * 5. ZERO-ALLOCATION: dentro de tick()/read() y todo lo que invoquen está
 *    prohibido new/[]/{}/map/filter. Toda asignación ocurre en el
 *    constructor/setup. La validación formal con heap profiling es criterio
 *    de aceptación de Fase 4.
 * ==========================================================================
 */

/** Frecuencia del tick de física (Hz). dt = 1/TICK_RATE. */
export const TICK_RATE = 240
export const TICK_DT = 1 / TICK_RATE

/**
 * Tomas físicas medibles ("verdad" del motor). La física escribe una vez por
 * tick en un Float64Array indexado por este enum; los sensores muestrean DE
 * AQUÍ, nunca del estado interno. Unidades SI.
 */
export const enum Tap {
  CrankAngle = 0, // rad (acumulado, 4π por ciclo)
  CrankOmega, // rad/s
  ManifoldP, // Pa absolutos
  ManifoldT, // K
  CoolantT, // K
  OilP, // Pa
  RailP, // Pa relativos
  ExhaustT, // K
  BlockKnockAccel, // m/s² (acelerómetro piezo del bloque)
  BatteryV, // V
  IntakeAirT, // K (IAT: sube con heat-soak)
  TurboOmega, // rad/s del rotor
  CamPhase, // rad (CMP)
  VehicleGx, // m/s² longitudinal
  VehicleGy, // m/s² lateral
  VehicleGz, // m/s² vertical
  /** Centinela: nº de tomas. Mantener SIEMPRE al final. */
  COUNT
}

export type FailMode = 'none' | 'stuck' | 'open' | 'noisy'

export interface SensorSpec {
  /** Identificador de cableado: 'ckp', 'map', 'ect'… (único en el arnés). */
  id: string
  /** Qué magnitud física mide. */
  tap: Tap
  /** Frecuencia de muestreo del sensor (Hz). Se satura a TICK_RATE. */
  sampleRateHz: number
  /** Retraso de transporte (ms): buffer circular preasignado. */
  latencyMs: number
  /** σ del ruido eléctrico gaussiano, en unidades SI de la señal. */
  noiseFloor: number
  /** Cuantización ADC opcional (rango físico → escalones digitales). */
  adc?: { min: number; max: number; bits: number }
  failMode: FailMode
}

export interface ActuatorSpec {
  id: string
  kind: 'injector' | 'coil' | 'wastegate' | 'fuelPump'
  /**
   * DeadTime dependiente de tensión: deadMs(V) = baseMs + k / (V − vMin).
   * Se recalcula cada tick con la tensión de batería real (con su ruido).
   */
  deadTime: { baseMs: number; k: number; vMin: number }
}

/** Cableado declarativo del arnés (viaja en el proyecto .mforge.json). */
export interface HarnessConfig {
  sensors: SensorSpec[]
  actuators: ActuatorSpec[]
  /** Semilla del ruido: misma semilla ⇒ misma simulación (determinismo). */
  seed: number
}

/**
 * Lo ÚNICO que un sensor expone a la ECU. read() devuelve el último
 * muestreo (con latencia, ruido, ADC y modo de fallo aplicados) sin asignar
 * memoria.
 */
export interface SensorInstance {
  readonly spec: SensorSpec
  read(): number
}

/** Mando de actuador visto desde la ECU: tensión → efecto con DeadTime. */
export interface ActuatorPort {
  readonly spec: ActuatorSpec
  /** La ECU manda tensión (V). */
  command(volts: number): void
  /** Estado efectivo tras el DeadTime (0..1), que consume la física. */
  readonly effective: number
}

/**
 * Puerto de la ECU: SU ÚNICA VENTANA AL MUNDO. La ECU no recibe EngineState
 * ni ResolvedEngine — solo este puerto. Resolver ids en el arranque de la
 * ECU y cachear las referencias (resolver dentro del tick está prohibido).
 */
export interface EcuPort {
  sensor(id: string): SensorInstance | null
  actuator(id: string): ActuatorPort | null
}

// ---------------------------------------------------------------------------
// Estado del motor (SoA, preasignado). Fase 1 fija el layout; Fase 2 lo puebla.

/** Índices del vector de escalares del estado físico. */
export const enum St {
  CrankAngle = 0,
  CrankOmega,
  BlockTemp, // K — capacidad calorífica del bloque (heat-soak)
  IntakeAirT, // K
  TurboOmega, // rad/s
  OilPressure, // Pa
  RailPressure, // Pa relativos
  BatteryV, // V
  Throttle, // 0..1 (pedal físico; la ECU verá su sensor TPS)
  AmbientP, // Pa — entorno
  AmbientT, // K
  Humidity, // 0..1
  Gx,
  Gy,
  Gz,
  COUNT
}

/** Stride del bloque por-cilindro dentro de EngineStateBuffers.perCyl. */
export const enum Cyl {
  Phase = 0, // rad dentro del ciclo 4π (con desfase de encendido)
  AirMass, // kg atrapados este ciclo
  FuelMass, // kg inyectados este ciclo
  Pressure, // Pa instantáneos en cámara
  WallTemp, // K
  KnockIndex,
  FatigueScore, // acumulador de daño por knock (pliego §3)
  EffectiveRodArea, // m² — la deformación ESCRIBE aquí (geometría en caliente)
  STRIDE
}

export interface EngineStateBuffers {
  /** Escalares globales, indexados por St. */
  scalars: Float64Array
  /** nCilindros × Cyl.STRIDE. */
  perCyl: Float64Array
}

/** Entorno externo (pliego §3): afecta densidad de aire y fuerzas G. */
export interface Environment {
  ambientP: number // Pa
  ambientT: number // K
  humidity: number // 0..1
}

/** Preset de arnés "de serie": el cableado por defecto de un motor OEM. */
export function defaultHarness(seed = 1): HarnessConfig {
  return {
    seed,
    sensors: [
      { id: 'ckp', tap: Tap.CrankAngle, sampleRateHz: 240, latencyMs: 0.5, noiseFloor: 0.002, failMode: 'none' },
      { id: 'cmp', tap: Tap.CamPhase, sampleRateHz: 120, latencyMs: 1, noiseFloor: 0.004, failMode: 'none' },
      { id: 'map', tap: Tap.ManifoldP, sampleRateHz: 100, latencyMs: 2, noiseFloor: 400, adc: { min: 2e4, max: 4e5, bits: 10 }, failMode: 'none' },
      { id: 'iat', tap: Tap.IntakeAirT, sampleRateHz: 10, latencyMs: 15, noiseFloor: 0.4, adc: { min: 233, max: 423, bits: 8 }, failMode: 'none' },
      { id: 'ect', tap: Tap.CoolantT, sampleRateHz: 5, latencyMs: 20, noiseFloor: 0.3, adc: { min: 233, max: 423, bits: 8 }, failMode: 'none' },
      { id: 'oilp', tap: Tap.OilP, sampleRateHz: 50, latencyMs: 5, noiseFloor: 4000, failMode: 'none' },
      { id: 'railp', tap: Tap.RailP, sampleRateHz: 100, latencyMs: 2, noiseFloor: 6000, failMode: 'none' },
      { id: 'egt', tap: Tap.ExhaustT, sampleRateHz: 2, latencyMs: 250, noiseFloor: 2.5, failMode: 'none' },
      { id: 'knock', tap: Tap.BlockKnockAccel, sampleRateHz: 240, latencyMs: 1, noiseFloor: 1.5, failMode: 'none' },
      { id: 'vbatt', tap: Tap.BatteryV, sampleRateHz: 20, latencyMs: 5, noiseFloor: 0.03, failMode: 'none' }
    ],
    actuators: [
      { id: 'inj', kind: 'injector', deadTime: { baseMs: 0.6, k: 6, vMin: 5 } },
      { id: 'coil', kind: 'coil', deadTime: { baseMs: 0.2, k: 3, vMin: 5 } },
      { id: 'wg', kind: 'wastegate', deadTime: { baseMs: 4, k: 30, vMin: 4 } },
      { id: 'fp', kind: 'fuelPump', deadTime: { baseMs: 8, k: 40, vMin: 6 } }
    ]
  }
}
