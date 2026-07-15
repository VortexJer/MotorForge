/** Smoke LOD: árbol completo de componentes, 3 niveles por distancia y pulsos §4. */
import { _electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createRequire } = await import('node:module')
const electronPath = createRequire(join(projectDir, 'package.json'))('electron')
const shots = process.argv[2] ?? join(projectDir, 'screenshots')

const app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: projectDir })
await app.evaluate(({ app: a }, dir) => a.setPath('userData', dir), mkdtempSync(join(tmpdir(), 'motorforge-smokelod-')))
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.waitForSelector('canvas', { timeout: 15000 })

await win.click('.seg-btn:has-text("Laboratorio físico")')
await win.waitForSelector('.phys-canvas canvas', { timeout: 30000 })
await win.waitForTimeout(1200)

const tier = async () => await win.evaluate(() => window.__mfTier)
const canvasBox = await win.locator('.phys-canvas canvas').boundingBox()
const cx = canvasBox.x + canvasBox.width / 2
const cy = canvasBox.y + canvasBox.height / 2
await win.mouse.move(cx, cy)

// arranca el motor para ver la distribución en movimiento
await win.click('.phys-buttons .pbtn:has-text("IGNITION")')
await win.waitForTimeout(2500)
await win.mouse.move(cx, cy) // la rueda debe caer sobre el visor, no sobre el panel

// ---- nivel por defecto: banco de pruebas (intermedio) ----
console.log('tier por defecto:', await tier())
if ((await tier()) !== 1) throw new Error(`el nivel por defecto no es banco: ${await tier()}`)

// ---- zoom in → modo inspección: toda la tornillería y el tren de válvulas ----
for (let i = 0; i < 14; i++) {
  await win.mouse.wheel(0, -240)
  await win.waitForTimeout(120)
}
await win.waitForTimeout(500)
console.log('tras zoom in:', await tier())
if ((await tier()) !== 0) throw new Error(`no entra en inspección: ${await tier()}`)
await win.screenshot({ path: join(shots, 'lod-inspeccion.png') })

// ---- zoom out → vista global: solo carcasas macro ----
for (let i = 0; i < 24; i++) {
  await win.mouse.wheel(0, 240)
  await win.waitForTimeout(100)
}
await win.waitForTimeout(500)
console.log('tras zoom out:', await tier())
if ((await tier()) !== 2) throw new Error(`no entra en vista global: ${await tier()}`)
await win.screenshot({ path: join(shots, 'lod-global.png') })

// ---- vuelta al nivel banco y captura general ----
for (let i = 0; i < 6; i++) {
  await win.mouse.wheel(0, -240)
  await win.waitForTimeout(100)
}
await win.waitForTimeout(400)
console.log('nivel intermedio:', await tier())
await win.screenshot({ path: join(shots, 'lod-banco.png') })

await app.close()
console.log('OK')
