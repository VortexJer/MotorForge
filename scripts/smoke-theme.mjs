/** Smoke de temas: negro+rojo por defecto, modo claro, acento personalizado y persistencia. */
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
await app.evaluate(({ app: a }, dir) => a.setPath('userData', dir), mkdtempSync(join(tmpdir(), 'motorforge-smoketheme-')))
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.waitForSelector('canvas', { timeout: 15000 })
await win.waitForTimeout(900)

const accent = async () =>
  (await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))).trim()
const mode = async () => await win.evaluate(() => document.documentElement.dataset.theme)

console.log('por defecto:', await mode(), await accent())
if ((await accent()) !== '#e10600') throw new Error('el acento por defecto no es rojo')
await win.screenshot({ path: join(shots, 'theme-dark-red.png') })

// ---- Ajustes: modo claro + acento azul de preset ----
await win.click('.topbar-actions .btn:has-text("Ajustes")')
await win.waitForSelector('.settings-modal', { timeout: 5000 })
await win.click('.settings-modal .seg-btn:has-text("Claro")')
await win.click('.swatch-btn[title="Azul"]')
await win.waitForTimeout(400)
console.log('cambiado a:', await mode(), await accent())
if ((await mode()) !== 'light' || (await accent()) !== '#3987e5') throw new Error('el tema no cambió')
await win.screenshot({ path: join(shots, 'theme-light-blue.png') })
await win.click('.settings-modal .btn.primary')

// ---- persistencia: recargar y comprobar ----
await win.reload()
await win.waitForSelector('canvas', { timeout: 15000 })
await win.waitForTimeout(600)
console.log('tras recarga:', await mode(), await accent())
if ((await mode()) !== 'light' || (await accent()) !== '#3987e5') throw new Error('el tema no persiste')

// ---- selector libre (círculo de color) ----
await win.click('.topbar-actions .btn:has-text("Ajustes")')
await win.waitForSelector('.settings-modal', { timeout: 5000 })
await win.locator('.swatch-custom input[type="color"]').evaluate((el) => {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  proto.set.call(el, '#7a00cc')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
})
await win.waitForTimeout(300)
console.log('color libre:', await accent())
if ((await accent()) !== '#7a00cc') throw new Error('el color personalizado no se aplica')
// vuelta al valor por defecto para dejar el perfil limpio
await win.click('.settings-modal .seg-btn:has-text("Oscuro")')
await win.click('.swatch-btn[title="Rojo competición"]')
await win.click('.settings-modal .btn.primary')
await win.waitForTimeout(300)

// ---- el laboratorio hereda el acento ----
await win.click('.seg-btn:has-text("Laboratorio físico")')
await win.waitForSelector('.phys-panel', { timeout: 30000 })
await win.waitForTimeout(800)
await win.screenshot({ path: join(shots, 'theme-lab-red.png') })

await app.close()
console.log('OK')
