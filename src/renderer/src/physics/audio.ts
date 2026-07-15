/**
 * Sintetizador procedimental (pliego §6): nada de samples pregrabados.
 * Oscilador sawtooth cuya frecuencia sale de las revoluciones físicas del
 * cigüeñal, filtro de paso bajo que se abre con el acelerador y la carga,
 * ruido blanco filtrado en paso alto para el silbido del turbo, y un
 * "¡CLANK!" de distorsión grave al romper o gripar, seguido de silencio.
 */

export class EngineAudio {
  private ctx: AudioContext | null = null
  private osc: OscillatorNode | null = null
  private oscGain: GainNode | null = null
  private lowpass: BiquadFilterNode | null = null
  private noiseGain: GainNode | null = null
  private master: GainNode | null = null
  private dead = false

  start(): void {
    if (this.ctx) return
    const ctx = new AudioContext()
    this.ctx = ctx
    this.dead = false

    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.master.connect(ctx.destination)

    // Motor: sawtooth → paso bajo (más carga = corte más alto = más rudo)
    this.osc = ctx.createOscillator()
    this.osc.type = 'sawtooth'
    this.osc.frequency.value = 30
    this.lowpass = ctx.createBiquadFilter()
    this.lowpass.type = 'lowpass'
    this.lowpass.frequency.value = 220
    this.lowpass.Q.value = 1.1
    this.oscGain = ctx.createGain()
    this.oscGain.gain.value = 0.16
    this.osc.connect(this.lowpass).connect(this.oscGain).connect(this.master)
    this.osc.start()

    // Turbo: ruido blanco → paso alto (silbido del compresor)
    const noiseLen = ctx.sampleRate * 2
    const buffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < noiseLen; i++) data[i] = Math.random() * 2 - 1
    const noise = ctx.createBufferSource()
    noise.buffer = buffer
    noise.loop = true
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 3800
    this.noiseGain = ctx.createGain()
    this.noiseGain.gain.value = 0
    noise.connect(highpass).connect(this.noiseGain).connect(this.master)
    noise.start()
  }

  /**
   * Acopla el sintetizador al estado físico de este frame.
   * @param rpm revoluciones reales del cigüeñal
   * @param cylinders nº de cilindros
   * @param throttle 0..1
   * @param imepBar carga (presión media indicada, bar) — abre el filtro
   * @param boostBar presión de turbo (bar relativos) — silbido
   */
  update(rpm: number, cylinders: number, throttle: number, imepBar: number, boostBar: number): void {
    if (!this.ctx || this.dead || !this.osc || !this.lowpass || !this.master || !this.noiseGain) return
    const t = this.ctx.currentTime
    const running = rpm > 60
    this.master.gain.setTargetAtTime(running ? 0.65 : 0, t, 0.08)
    if (!running) return

    // Frecuencia fundamental = (RPM/60) · (cilindros/2) — encendidos por vuelta
    const f = (rpm / 60) * (cylinders / 2)
    this.osc.frequency.setTargetAtTime(Math.min(f, 1200), t, 0.03)
    // El corte del paso bajo se abre con acelerador Y carga, no solo con rpm
    const cutoff = 160 + 2600 * (0.55 * throttle + 0.45 * Math.min(imepBar / 20, 1))
    this.lowpass.frequency.setTargetAtTime(cutoff, t, 0.06)
    // Silbido de turbo ∝ boost
    this.noiseGain.gain.setTargetAtTime(Math.min(boostBar / 2.5, 1) * 0.09, t, 0.1)
  }

  /** Impacto sónico (pliego §6): pulso seco de distorsión grave 80 ms y silencio total. */
  clank(): void {
    if (!this.ctx || !this.master || this.dead) return
    this.dead = true
    const ctx = this.ctx
    const t = ctx.currentTime

    // corta el motor de inmediato
    this.master.gain.cancelScheduledValues(t)
    this.master.gain.setValueAtTime(0, t)

    // pulso: seno grave saturado con waveshaper, 80 ms
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(82, t)
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.08)
    const shaper = ctx.createWaveShaper()
    const curve = new Float32Array(256)
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1
      curve[i] = Math.tanh(x * 6)
    }
    shaper.curve = curve
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.9, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    osc.connect(shaper).connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.09)
  }

  /** Reactiva el sintetizador tras reconstruir el motor. */
  revive(): void {
    this.dead = false
  }

  /** Pausa dura (Custom Sandbox: physicsPaused ⇒ el bucle de sonido se detiene). */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend()
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()
  }

  dispose(): void {
    if (this.ctx) void this.ctx.close()
    this.ctx = null
    this.osc = null
    this.master = null
  }
}
