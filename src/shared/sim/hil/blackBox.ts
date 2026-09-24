import { TICK_RATE, Tap, St, Cyl } from './types'
import type { SensorInstance, ActuatorPort } from './types'

/**
 * Caja negra: el registrador de datos del banco.
 *
 * Funciona como la de un avión, no como un `console.log`. La diferencia está en
 * el PRE-DISPARO: graba SIEMPRE en un anillo circular, así que cuando algo
 * revienta ya tienes los segundos ANTERIORES al fallo. Un log que empiezas
 * cuando ves el problema llega tarde por definición: lo interesante pasó antes.
 *
 * Ciclo de vida:
 *
 *   parado ──arm()──> armado ──(condición de disparo)──> disparado
 *                        ↑                                   │
 *                        │                         (postRoll ticks)
 *                        └──────── arm() ─────── congelado <─┘
 *
 * En `armado` graba en bucle y va machacando lo más viejo. Al dispararse sigue
 * grabando `postRollS` segundos más y se CONGELA: a partir de ahí no se pisa
 * nada, que es justo lo que hace útil a una caja negra. La ventana congelada
 * contiene `preRollS` segundos antes del evento y `postRollS` después.
 *
 * Zero-allocation (ADR-001 §5): `record()` no crea objetos, arrays ni closures.
 * Todo se reserva en el constructor. `toCsv()` sí asigna, pero se llama una vez
 * al exportar, nunca dentro del tick.
 */

/** De dónde sale el valor de un canal. */
export const enum Src {
  /** Verdad física del bus (indexado por Tap). Lo que el motor HACE. */
  Truth = 0,
  /** Escalar del estado interno del núcleo (indexado por St). */
  Scalar,
  /** Campo por cilindro (indexado por Cyl, con nº de cilindro). */
  Cylinder,
  /** Lectura de un sensor: lo que la ECU CREE. Con ruido, retraso y ADC. */
  Sensor,
  /** Salida efectiva de un actuador, tras el DeadTime. */
  Actuator
}

export interface ChannelSpec {
  /** Nombre del canal en la cabecera del CSV. */
  id: string
  /** Unidad, para la cabecera. Vacía si es adimensional. */
  unit: string
  src: Src
  /** Tap | St | Cyl según `src`. Ignorado en Sensor/Actuator. */
  idx?: number
  /** Nº de cilindro (solo Src.Cylinder). */
  cyl?: number
  /** Id de cableado (solo Src.Sensor / Src.Actuator). */
  wire?: string
  /**
   * Factor de presentación aplicado AL GRABAR. El núcleo trabaja en SI, pero
   * una caja negra la lee un humano: rad/s a rpm, Pa a bar. La conversión va
   * aquí y no en el visor para que el CSV exportado ya salga en unidades de
   * taller, que es como se comparan dos ensayos.
   */
  scale?: number
}

export type Comparacion = '>' | '<'

export interface TriggerSpec {
  /** Id de un canal ya declarado. */
  channel: string
  op: Comparacion
  /** Umbral EN LAS UNIDADES DEL CANAL (con `scale` ya aplicado). */
  threshold: number
  /**
   * Ticks consecutivos que debe cumplirse antes de disparar. Un pico de un
   * solo tick en el acelerómetro de picado es ruido, no una detonación.
   */
  holdTicks?: number
  /** Texto que se guarda con la captura ("sobrerrégimen", "presión de aceite"). */
  label?: string
  /**
   * Condición de HABILITACIÓN: el disparo solo se evalúa mientras esto se
   * cumpla. Sin ella, media lista de umbrales salta en cada arranque — la
   * presión de aceite es baja de verdad con el motor girando a 200 rpm, y eso
   * no es una avería, es un motor arrancando. Es lo mismo que hace un cuadro
   * real, que no enciende el testigo de aceite mientras das al contacto.
   */
  gate?: { channel: string; op: Comparacion; threshold: number }
}

export interface BlackBoxConfig {
  channels: ChannelSpec[]
  triggers?: TriggerSpec[]
  /** Segundos ANTES del disparo que se conservan. */
  preRollS?: number
  /** Segundos DESPUÉS del disparo que se siguen grabando. */
  postRollS?: number
  /**
   * Frecuencia de grabación (Hz). Se diezma respecto al tick de 240 Hz. Grabar
   * a 240 todos los canales durante un minuto son millones de muestras que
   * nadie mira; 60 Hz basta para ver un transitorio y ocupa la cuarta parte.
   * Ojo: el picado necesita 240 — si lo vas a analizar, súbelo.
   */
  rateHz?: number
}

export type EstadoCaja = 'parado' | 'armado' | 'disparado' | 'congelado'

/** Fuentes que la caja necesita para leer. Se pasan una vez, en el constructor. */
export interface BlackBoxSources {
  truth: Float64Array
  scalars: Float64Array
  perCyl: Float64Array
  sensor(id: string): SensorInstance | null
  actuator(id: string): ActuatorPort | null
}

export class BlackBox {
  readonly channels: readonly ChannelSpec[]
  readonly capacity: number
  readonly rateHz: number

  /** Muestras: capacity × nCanales, f32 (ADR-001 §3: anillo grande, se recorre en bloque). */
  private readonly data: Float32Array
  /** Nº de tick de cada fila, para reconstruir el tiempo exacto y ver huecos. */
  private readonly tickOf: Float64Array

  private readonly nCh: number
  private readonly srcKind: Uint8Array
  private readonly srcIdx: Int32Array
  private readonly srcCyl: Int32Array
  private readonly scale: Float64Array
  private readonly sensorRef: Array<SensorInstance | null>
  private readonly actuatorRef: Array<ActuatorPort | null>

  private readonly trigCh: Int32Array
  private readonly trigOp: Int8Array // 1 = '>', -1 = '<'
  private readonly trigThr: Float64Array
  private readonly trigHold: Int32Array
  private readonly trigCount: Int32Array
  private readonly trigLabels: string[]
  /** Habilitación por disparo: canal (-1 = sin condición), sentido y umbral. */
  private readonly gateCh: Int32Array
  private readonly gateOp: Int8Array
  private readonly gateThr: Float64Array

  private readonly src: BlackBoxSources

  /** Escalares mutables en un Float64Array: evita HeapNumbers en V8. */
  private readonly st = new Float64Array(6)
  private static readonly WRITE = 0 // cursor de escritura
  private static readonly LLENAS = 1 // filas válidas
  private static readonly TICK = 2 // contador de ticks
  private static readonly DIEZMA = 3 // acumulador de diezmado
  private static readonly POST = 4 // ticks restantes de post-disparo
  private static readonly TICK_DISPARO = 5

  private estadoActual: EstadoCaja = 'parado'
  private motivoActual = ''
  private readonly cadaNTicks: number
  private readonly postRollFrames: number

  constructor(cfg: BlackBoxConfig, src: BlackBoxSources) {
    this.src = src
    this.channels = cfg.channels
    this.nCh = cfg.channels.length

    const rate = Math.min(Math.max(cfg.rateHz ?? 60, 1), TICK_RATE)
    // El diezmado tiene que ser entero: si no, el intervalo entre muestras
    // baila y el CSV deja de ser una rejilla regular.
    this.cadaNTicks = Math.max(1, Math.round(TICK_RATE / rate))
    this.rateHz = TICK_RATE / this.cadaNTicks

    const pre = Math.max(0, cfg.preRollS ?? 10)
    const post = Math.max(0, cfg.postRollS ?? 2)
    this.postRollFrames = Math.ceil(post * this.rateHz)
    this.capacity = Math.max(2, Math.ceil((pre + post) * this.rateHz) + 1)

    this.data = new Float32Array(this.capacity * this.nCh)
    this.tickOf = new Float64Array(this.capacity)

    this.srcKind = new Uint8Array(this.nCh)
    this.srcIdx = new Int32Array(this.nCh)
    this.srcCyl = new Int32Array(this.nCh)
    this.scale = new Float64Array(this.nCh)
    this.sensorRef = new Array(this.nCh).fill(null)
    this.actuatorRef = new Array(this.nCh).fill(null)

    for (let i = 0; i < this.nCh; i++) {
      const c = cfg.channels[i]!
      this.srcKind[i] = c.src
      this.srcIdx[i] = c.idx ?? 0
      this.srcCyl[i] = c.cyl ?? 0
      this.scale[i] = c.scale ?? 1
      // Resolver el cableado AQUÍ y cachear la referencia: buscar por id dentro
      // del tick está prohibido (ADR-001 §5, misma regla que la ECU).
      if (c.src === Src.Sensor) this.sensorRef[i] = src.sensor(c.wire ?? c.id)
      if (c.src === Src.Actuator) this.actuatorRef[i] = src.actuator(c.wire ?? c.id)
    }

    const trg = cfg.triggers ?? []
    this.trigCh = new Int32Array(trg.length)
    this.trigOp = new Int8Array(trg.length)
    this.trigThr = new Float64Array(trg.length)
    this.trigHold = new Int32Array(trg.length)
    this.trigCount = new Int32Array(trg.length)
    this.trigLabels = new Array(trg.length)
    this.gateCh = new Int32Array(trg.length).fill(-1)
    this.gateOp = new Int8Array(trg.length)
    this.gateThr = new Float64Array(trg.length)
    for (let i = 0; i < trg.length; i++) {
      const t = trg[i]!
      const idx = cfg.channels.findIndex((c) => c.id === t.channel)
      if (idx < 0) throw new Error(`Disparo sobre un canal que no existe: "${t.channel}"`)
      this.trigCh[i] = idx
      this.trigOp[i] = t.op === '>' ? 1 : -1
      this.trigThr[i] = t.threshold
      this.trigHold[i] = Math.max(1, t.holdTicks ?? 1)
      this.trigLabels[i] = t.label ?? `${t.channel} ${t.op} ${t.threshold}`
      if (t.gate) {
        const g = cfg.channels.findIndex((c) => c.id === t.gate!.channel)
        if (g < 0) throw new Error(`Habilitación sobre un canal que no existe: "${t.gate.channel}"`)
        this.gateCh[i] = g
        this.gateOp[i] = t.gate.op === '>' ? 1 : -1
        this.gateThr[i] = t.gate.threshold
      }
    }
  }

  get estado(): EstadoCaja {
    return this.estadoActual
  }

  /** Qué disparó la captura congelada. Vacío si no se ha disparado. */
  get motivo(): string {
    return this.motivoActual
  }

  /** Segundo de simulación en que se disparó. NaN si no se ha disparado. */
  get tiempoDisparo(): number {
    const t = this.st[BlackBox.TICK_DISPARO]!
    return t < 0 ? Number.NaN : t / TICK_RATE
  }

  get frames(): number {
    return this.st[BlackBox.LLENAS]!
  }

  /** Empieza (o reinicia) a grabar. Descarta la captura anterior. */
  arm(): void {
    this.st.fill(0)
    this.st[BlackBox.TICK_DISPARO] = -1
    this.trigCount.fill(0)
    this.estadoActual = 'armado'
    this.motivoActual = ''
  }

  /** Deja de grabar sin congelar (parada limpia del ensayo). */
  stop(): void {
    if (this.estadoActual !== 'parado') this.estadoActual = 'congelado'
  }

  /**
   * Marca manual, como el botón de evento del piloto: dispara la captura
   * aunque no se cumpla ninguna condición automática. Sirve para "esto que
   * acaba de sonar raro, guárdalo".
   */
  markEvent(label = 'marca manual'): void {
    if (this.estadoActual === 'armado') this.dispararse(label)
  }

  private dispararse(label: string): void {
    this.estadoActual = 'disparado'
    this.motivoActual = label
    this.st[BlackBox.TICK_DISPARO] = this.st[BlackBox.TICK]!
    this.st[BlackBox.POST] = this.postRollFrames
  }

  /** Lee un canal de las fuentes vivas. Sin asignaciones. */
  private leer(i: number): number {
    const k = this.srcKind[i]!
    let v = 0
    if (k === Src.Truth) {
      v = this.src.truth[this.srcIdx[i]!]!
    } else if (k === Src.Scalar) {
      v = this.src.scalars[this.srcIdx[i]!]!
    } else if (k === Src.Cylinder) {
      v = this.src.perCyl[this.srcCyl[i]! * Cyl.STRIDE + this.srcIdx[i]!]!
    } else if (k === Src.Sensor) {
      const s = this.sensorRef[i]
      v = s ? s.read() : Number.NaN
    } else {
      const a = this.actuatorRef[i]
      v = a ? a.effective : Number.NaN
    }
    return v * this.scale[i]!
  }

  /**
   * Un tick del registrador. Se llama DESPUÉS de la física, cuando la verdad y
   * las lecturas de sensores del tick ya están puestas.
   */
  record(): void {
    const estado = this.estadoActual
    if (estado === 'parado' || estado === 'congelado') return

    this.st[BlackBox.TICK]! += 1
    this.st[BlackBox.DIEZMA]! += 1
    if (this.st[BlackBox.DIEZMA]! < this.cadaNTicks) return
    this.st[BlackBox.DIEZMA] = 0

    const w = this.st[BlackBox.WRITE]!
    const base = w * this.nCh
    for (let i = 0; i < this.nCh; i++) {
      this.data[base + i] = this.leer(i)
    }
    this.tickOf[w] = this.st[BlackBox.TICK]!

    this.st[BlackBox.WRITE] = (w + 1) % this.capacity
    if (this.st[BlackBox.LLENAS]! < this.capacity) this.st[BlackBox.LLENAS]! += 1

    if (estado === 'armado') {
      // Las condiciones se evalúan sobre la MUESTRA RECIÉN GRABADA, no sobre
      // las fuentes: así el umbral se compara contra exactamente el mismo
      // número que luego aparece en el CSV.
      for (let t = 0; t < this.trigCh.length; t++) {
        const gc = this.gateCh[t]!
        if (gc >= 0) {
          const gv = this.data[base + gc]!
          const abierta = this.gateOp[t]! > 0 ? gv > this.gateThr[t]! : gv < this.gateThr[t]!
          if (!abierta) {
            // Deshabilitado: además de no disparar, se reinicia la cuenta. Si no,
            // el umbral acumularía ticks del arranque y saltaría al primer tick
            // en que el motor cruzase la condición de habilitación.
            this.trigCount[t] = 0
            continue
          }
        }
        const v = this.data[base + this.trigCh[t]!]!
        const supera = this.trigOp[t]! > 0 ? v > this.trigThr[t]! : v < this.trigThr[t]!
        if (supera) {
          this.trigCount[t]! += 1
          if (this.trigCount[t]! >= this.trigHold[t]!) {
            this.dispararse(this.trigLabels[t]!)
            break
          }
        } else {
          this.trigCount[t] = 0
        }
      }
    } else {
      // disparado: seguir grabando el post-disparo y congelar al agotarlo
      this.st[BlackBox.POST]! -= 1
      if (this.st[BlackBox.POST]! <= 0) this.estadoActual = 'congelado'
    }
  }

  /**
   * Fila `n` en orden cronológico (0 = la más antigua conservada). Escribe en
   * `destino` para no asignar. Devuelve el instante de la muestra, en segundos.
   */
  frameAt(n: number, destino: Float32Array): number {
    const llenas = this.st[BlackBox.LLENAS]!
    if (n < 0 || n >= llenas) return Number.NaN
    // Con el anillo lleno, la fila más antigua es la siguiente a la de escritura.
    const inicio = llenas < this.capacity ? 0 : this.st[BlackBox.WRITE]!
    const fila = (inicio + n) % this.capacity
    const base = fila * this.nCh
    for (let i = 0; i < this.nCh; i++) destino[i] = this.data[base + i]!
    return this.tickOf[fila]! / TICK_RATE
  }

  /**
   * Exporta la captura a CSV. Cabecera `nombre[unidad]` y tiempo en la primera
   * columna, que es lo que esperan Excel, pandas o cualquier visor de ensayos.
   *
   * El tiempo se da en dos columnas: `t` absoluto de simulación y `t_rel`
   * relativo al disparo (negativo ANTES del evento). La segunda es la que se
   * mira de verdad: dice "esto pasó 0,3 s antes de romperse".
   */
  toCsv(): string {
    const llenas = this.st[BlackBox.LLENAS]!
    const filas: string[] = []
    const cab: string[] = ['t[s]', 't_rel[s]']
    for (const c of this.channels) cab.push(c.unit ? `${c.id}[${c.unit}]` : c.id)
    filas.push(cab.join(','))

    const tDisparo = this.tiempoDisparo
    const buf = new Float32Array(this.nCh)
    const celdas: string[] = new Array(this.nCh + 2)
    for (let n = 0; n < llenas; n++) {
      const t = this.frameAt(n, buf)
      celdas[0] = t.toFixed(5)
      celdas[1] = Number.isNaN(tDisparo) ? '' : (t - tDisparo).toFixed(5)
      for (let i = 0; i < this.nCh; i++) {
        const v = buf[i]!
        // 6 cifras significativas: más es ruido de float32, menos pierde detalle
        celdas[i + 2] = Number.isFinite(v) ? Number(v.toPrecision(6)).toString() : ''
      }
      filas.push(celdas.join(','))
    }
    return filas.join('\n')
  }

  /** Metadatos de la captura, para guardar junto al CSV. */
  toManifest(): Record<string, unknown> {
    return {
      formato: 'motorforge-blackbox/1',
      estado: this.estadoActual,
      motivo: this.motivoActual,
      disparoEnS: Number.isNaN(this.tiempoDisparo) ? null : this.tiempoDisparo,
      frecuenciaHz: this.rateHz,
      muestras: this.frames,
      capacidad: this.capacity,
      canales: this.channels.map((c) => ({ id: c.id, unidad: c.unit }))
    }
  }
}

/**
 * Juego de canales "de banco": lo que un técnico querría tener delante cuando
 * un motor se rompe. Mezcla a propósito las tres capas, porque la mitad de los
 * fallos reales se diagnostican comparándolas:
 *
 *   - VERDAD: lo que el motor hace de verdad.
 *   - SENSOR: lo que la ECU cree que pasa (con ruido, retraso y ADC).
 *   - ACTUADOR: lo que la ECU ordenó hacer.
 *
 * Un MAP que se separa de la presión real es un sensor muriéndose; una
 * inyección que no sigue a la orden es un problema de tensión o de bomba.
 */
export function bankChannels(nCyl: number): ChannelSpec[] {
  const RAD_S_A_RPM = 60 / (2 * Math.PI)
  const PA_A_BAR = 1e-5

  const ch: ChannelSpec[] = [
    // --- verdad física ---
    { id: 'rpm', unit: 'rpm', src: Src.Truth, idx: Tap.CrankOmega, scale: RAD_S_A_RPM },
    { id: 'map_real', unit: 'bar', src: Src.Truth, idx: Tap.ManifoldP, scale: PA_A_BAR },
    { id: 'egt_real', unit: 'K', src: Src.Truth, idx: Tap.ExhaustT },
    { id: 'ect_real', unit: 'K', src: Src.Truth, idx: Tap.CoolantT },
    { id: 'oilp_real', unit: 'bar', src: Src.Truth, idx: Tap.OilP, scale: PA_A_BAR },
    { id: 'railp_real', unit: 'bar', src: Src.Truth, idx: Tap.RailP, scale: PA_A_BAR },
    { id: 'knock_accel', unit: 'm/s2', src: Src.Truth, idx: Tap.BlockKnockAccel },
    { id: 'turbo_rpm', unit: 'rpm', src: Src.Truth, idx: Tap.TurboOmega, scale: RAD_S_A_RPM },
    { id: 'iat_real', unit: 'K', src: Src.Truth, idx: Tap.IntakeAirT },
    { id: 'vbatt_real', unit: 'V', src: Src.Truth, idx: Tap.BatteryV },
    { id: 'gx', unit: 'm/s2', src: Src.Truth, idx: Tap.VehicleGx },

    // --- lo que la ECU cree ---
    { id: 'map_ecu', unit: 'bar', src: Src.Sensor, wire: 'map', scale: PA_A_BAR },
    { id: 'ect_ecu', unit: 'K', src: Src.Sensor, wire: 'ect' },
    { id: 'iat_ecu', unit: 'K', src: Src.Sensor, wire: 'iat' },
    { id: 'oilp_ecu', unit: 'bar', src: Src.Sensor, wire: 'oilp', scale: PA_A_BAR },
    { id: 'tps_ecu', unit: '', src: Src.Sensor, wire: 'tps' },
    { id: 'vbatt_ecu', unit: 'V', src: Src.Sensor, wire: 'vbatt' },

    // --- lo que la ECU ordenó ---
    { id: 'inj', unit: '', src: Src.Actuator, wire: 'inj' },
    { id: 'coil', unit: '', src: Src.Actuator, wire: 'coil' },
    { id: 'wastegate', unit: '', src: Src.Actuator, wire: 'wg' },
    { id: 'fuelpump', unit: '', src: Src.Actuator, wire: 'fp' },

    // --- estado interno ---
    { id: 'block_temp', unit: 'K', src: Src.Scalar, idx: St.BlockTemp },
    { id: 'throttle', unit: '', src: Src.Scalar, idx: St.Throttle }
  ]

  // Por cilindro: presión de cámara, picado y daño acumulado. Son las tres que
  // dicen QUÉ cilindro se rompió, no solo que el motor se rompió.
  for (let c = 0; c < nCyl; c++) {
    ch.push({ id: `cyl${c + 1}_p`, unit: 'bar', src: Src.Cylinder, cyl: c, idx: Cyl.Pressure, scale: PA_A_BAR })
    ch.push({ id: `cyl${c + 1}_knock`, unit: '', src: Src.Cylinder, cyl: c, idx: Cyl.KnockIndex })
    ch.push({ id: `cyl${c + 1}_fatiga`, unit: '', src: Src.Cylinder, cyl: c, idx: Cyl.FatigueScore })
  }
  return ch
}

/**
 * Disparos de banco por defecto.
 *
 * Los umbrales están calibrados contra lo que ESTE modelo produce, no contra
 * números de manual. Medido sobre el motor de serie, entre ralentí y plena
 * carga y descartando los 2 primeros segundos de arranque:
 *
 *     acelerador   rpm máx   EGT máx        aceite mín   picado máx
 *     0.00           1454    1230 K (957°C)   6.00 bar      0.0
 *     0.20           7502    1358 K (1085°C)  6.00 bar      0.0
 *     1.00           7500    1344 K (1071°C)  6.00 bar      0.0
 *
 * El primer umbral de escape que puse (1223 K, los ~950°C de la literatura)
 * quedaba POR DEBAJO del ralentí de este modelo y disparaba en cada ensayo.
 * Un disparo que salta siempre es peor que no tener disparo, porque enseña a
 * ignorarlo. Ahora va a 1420 K, holgado sobre el máximo observado.
 *
 * OJO, y merece mirarse aparte: 957 °C de escape AL RALENTÍ es altísimo para un
 * gasolina atmosférico (lo normal en el colector son 300-400 °C). Parece que el
 * modelo devuelve una temperatura cercana a la de combustión y no la del gas ya
 * mezclado en el colector, que es lo que mediría una sonda EGT real. No lo toco
 * porque es física del núcleo, no del registrador — pero si algún día se
 * corrige, este umbral hay que bajarlo con ella.
 */
export function bankTriggers(rpmMax = 8500): TriggerSpec[] {
  return [
    { channel: 'rpm', op: '>', threshold: rpmMax, holdTicks: 3, label: 'sobrerrégimen' },
    // Presión de aceite: SOLO con el motor ya girando por encima de ralentí.
    // Sin la habilitación esto salta en cada arranque, porque a 200 rpm la
    // presión es baja de verdad — comprobado, disparaba a los 1,5 s de dar al
    // contacto. Y además tiene que sostenerse medio segundo.
    {
      channel: 'oilp_real', op: '<', threshold: 0.8, holdTicks: 30,
      label: 'presión de aceite', gate: { channel: 'rpm', op: '>', threshold: 1200 }
    },
    {
      channel: 'egt_real', op: '>', threshold: 1420, holdTicks: 10,
      label: 'temperatura de escape', gate: { channel: 'rpm', op: '>', threshold: 800 }
    },
    // El acelerómetro del bloque también recoge el golpe del arranque, así que
    // el picado solo se vigila con el motor en marcha.
    {
      channel: 'knock_accel', op: '>', threshold: 45, holdTicks: 2,
      label: 'picado severo', gate: { channel: 'rpm', op: '>', threshold: 1000 }
    }
  ]
}
