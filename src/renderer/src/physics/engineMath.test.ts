import { describe, expect, it } from 'vitest'
import {
  PHYS_MATERIALS,
  PISTON_COLD_FACTOR,
  checkStress,
  combustionForce,
  eulerCritical,
  hotPistonRadius,
  inertiaForce,
  isSeized,
  thermalStep
} from './engineMath'

describe('laboratorio físico: matemáticas del pliego §4', () => {
  it('fuerza de inercia en PMS = m·ω²·r·(1 + r/L)', () => {
    const m = 0.45
    const omega = 600 // rad/s ≈ 5730 rpm
    const r = 0.043
    const L = 0.139
    const f = inertiaForce(m, omega, r, L, 0)
    expect(f).toBeCloseTo(m * omega * omega * r * (1 + r / L), 6)
    // en el PMI (θ=π) la inercia cambia de signo y es menor en magnitud
    const fBdc = inertiaForce(m, omega, r, L, Math.PI)
    expect(fBdc).toBeLessThan(0)
    expect(Math.abs(fBdc)).toBeLessThan(f)
  })

  it('pandeo de Euler crece con E y cae con L²', () => {
    const A = 3e-4
    const alu = eulerCritical(70e9, A, 0.139)
    const acero = eulerCritical(210e9, A, 0.139)
    expect(acero / alu).toBeCloseTo(3, 5)
    const larga = eulerCritical(70e9, A, 0.278)
    expect(alu / larga).toBeCloseTo(4, 5)
  })

  it('sobre-régimen a 12000 rpm rompe biela de aluminio fina pero no de acero', () => {
    const omega = (12000 * 2 * Math.PI) / 60
    const base = {
      mPiston: 0.55,
      omega,
      r: 0.043,
      rodLength: 0.139,
      rodArea: 1.2e-4,
      pComb: 0,
      pistonArea: Math.PI * 0.043 ** 2,
      throttle: 0,
      theta: 0
    }
    const alu = checkStress({ ...base, material: PHYS_MATERIALS.aluminio })
    expect(alu.failure).toBe('traccion')
    const acero = checkStress({ ...base, material: PHYS_MATERIALS.acero })
    expect(acero.failure).toBeNull()
  })

  it('combustión fuerte sobre sección mínima provoca pandeo antes que plastificación', () => {
    const r = checkStress({
      mPiston: 0.45,
      omega: (2500 * 2 * Math.PI) / 60, // poca inercia que compense
      r: 0.043,
      rodLength: 0.139,
      rodArea: 1.1e-4,
      material: PHYS_MATERIALS.aluminio,
      pComb: 1.1e7, // 110 bar de pico (boost alto)
      pistonArea: Math.PI * 0.043 ** 2,
      throttle: 1,
      theta: 0
    })
    expect(r.failure).toBe('pandeo')
    expect(combustionForce(Math.PI * 0.043 ** 2, 1.1e7, 1)).toBeGreaterThan(r.eulerLimit)
  })

  it('térmica: sin agua el motor sube; con caudal pleno se estabiliza', () => {
    let hot = { tMotor: 298 }
    let cooled = { tMotor: 298 }
    for (let i = 0; i < 600; i++) {
      hot = thermalStep(hot, {
        rpm: 6000, throttle: 1, pCylBar: 60, waterFlow: 0, oilFlow: 0,
        tAmbient: 298, heatCapacity: 90000, dt: 1
      })
      cooled = thermalStep(cooled, {
        rpm: 6000, throttle: 1, pCylBar: 60, waterFlow: 1, oilFlow: 1,
        tAmbient: 298, heatCapacity: 90000, dt: 1
      })
    }
    expect(hot.tMotor).toBeGreaterThan(cooled.tMotor + 100)
    expect(cooled.tMotor - 273.15).toBeLessThan(135) // cruza por debajo del gripaje
  })

  it('dilatación: el pistón gripa al superar la temperatura crítica', () => {
    const base = {
      pistonRadius: 0.043 * PISTON_COLD_FACTOR,
      boreRadius: 0.043,
      tAmbient: 298,
      thermalExpansion: PHYS_MATERIALS.aluminio.thermalExpansion
    }
    expect(isSeized({ ...base, tMotor: 298 + 60 })).toBe(false)
    expect(isSeized({ ...base, tMotor: 298 + 160 })).toBe(true)
    expect(hotPistonRadius({ ...base, tMotor: 298 + 160 })).toBeGreaterThanOrEqual(base.boreRadius)
  })
})
