/** Smoke fase 6: laboratorio físico Rapier — arranque, telemetría, rotura y sandbox. */
import { _electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createRequire } = await import('node:module')
const electronPath = createRequire(join(projectDir, 'package.json'))('electron')
const shots = process.argv[2] ?? join(projectDir, 'screenshots')

const tempData = mkdtempSync(join(tmpdir(), 'motorforge-smoke6-'))
const app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: projectDir })
await app.evaluate(({ app: a }, dir) => a.setPath('userData', dir), tempData)
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.waitForSelector('canvas', { timeout: 15000 })

const setRange = async (sel, value) => {
  await win.locator(sel).evaluate((el, v) => {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    proto.set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, String(value))
}

// ---- entrar al laboratorio físico ----
await win.click('.seg-btn:has-text("Laboratorio físico")')
await win.waitForSelector('.phys-panel', { timeout: 30000 })
await win.waitForSelector('.phys-canvas canvas', { timeout: 30000 })
await win.waitForTimeout(1000)

// ---- ignición: el motor de arranque debe llevarlo a ralentí ----
await win.click('.phys-buttons .btn:has-text("IGNITION")')
await win.waitForTimeout(3500)
const idleRpm = parseFloat(await win.textContent('.phys-rpm'))
console.log('ralentí:', idleRpm.toFixed(0), 'rpm')
if (idleRpm < 400) throw new Error(`el motor no arranca: ${idleRpm} rpm`)

// ---- throttle a fondo: sube hasta el corte ----
await setRange('#phys-throttle', 1)
await win.waitForTimeout(5000)
const fullRpm = parseFloat(await win.textContent('.phys-rpm'))
console.log('a fondo:', fullRpm.toFixed(0), 'rpm (corte 7200)')
if (fullRpm < 5500) throw new Error(`no sube de vueltas: ${fullRpm} rpm`)
await win.screenshot({ path: join(shots, 'phase6-running.png') })

// ---- rotura por sobre-régimen: aluminio + sección fina + corte a 12500 ----
await win.selectOption('#phys-material', 'aluminio')
await setRange('#phys-rodarea', 110)
await setRange('#phys-revlimit', 12500)
await win.waitForSelector('.phys-failure-banner', { timeout: 25000 })
const failure = (await win.textContent('.phys-failure-banner')).replace(/\s+/g, ' ')
console.log('rotura:', failure.slice(0, 140))
await win.waitForTimeout(1200) // deja volar las piezas por el cárter
await win.screenshot({ path: join(shots, 'phase6-broken.png') })

// ---- reconstruir ----
await win.click('.phys-buttons .btn:has-text("Reconstruir")')
await win.waitForTimeout(800)
const status = await win.textContent('.phys-status-chip')
console.log('tras reconstruir:', status.trim())

// ---- custom sandbox: pausa física + banner ----
await win.click('.phys-buttons .btn:has-text("CUSTOM SANDBOX")')
await win.waitForSelector('.phys-sandbox-banner', { timeout: 5000 })
const importBtn = await win.locator('.phys-buttons .btn:has-text("Importar .glb")').count()
if (importBtn !== 1) throw new Error('falta el botón de importar .glb en sandbox')
await win.screenshot({ path: join(shots, 'phase6-sandbox.png') })
await win.click('.phys-buttons .btn:has-text("Sellar ensamblaje")')
await win.waitForTimeout(400)

// ---- gripaje: cortar agua y aceite a plena carga ----
// primero, biela sana de nuevo: acero, sección normal y corte de fábrica
await win.selectOption('#phys-material', 'acero')
await setRange('#phys-rodarea', 300)
await setRange('#phys-revlimit', 7200)
await win.click('.phys-buttons .btn:has-text("Reconstruir")')
await win.waitForTimeout(600)
await win.click('.phys-buttons .btn:has-text("IGNITION")')
await setRange('#phys-throttle', 1)
await setRange('#phys-water', 0)
await setRange('#phys-oil', 0)
await win.waitForSelector('.phys-failure-banner', { timeout: 60000 })
const seizure = (await win.textContent('.phys-failure-banner')).replace(/\s+/g, ' ')
console.log('gripaje:', seizure.slice(0, 140))
if (!seizure.includes('gripaje')) throw new Error('el fallo por sobrecalentamiento no es gripaje')
await win.screenshot({ path: join(shots, 'phase6-seized.png') })

await app.close()
console.log('OK')
