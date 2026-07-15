/** Smoke fase 3: mapas ECU, bomba, knock y pull transitorio. */
import { _electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createRequire } = await import('node:module')
const electronPath = createRequire(join(projectDir, 'package.json'))('electron')
const shots = process.argv[2] ?? join(projectDir, 'screenshots')

const app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: projectDir })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.waitForSelector('canvas', { timeout: 15000 })

// Config turbo que pica en 95: GT35 con su boost por defecto (1.2 bar)
await win.selectOption('#sel-injector', 'inj-1000')
await win.selectOption('#sel-fuelPump', 'pump-255')
await win.selectOption('#sel-aspiration', 'asp-turbo-gt35')
await win.waitForTimeout(900)

const estado = await win.textContent('.stat-row')
console.log('estado 95:', estado.replace(/\s+/g, ' ').slice(0, 160))

// Cambio a E85: debería aguantar más
await win.selectOption('#fuel', 'e85')
await win.waitForTimeout(900)
console.log('estado e85:', (await win.textContent('.stat-row')).replace(/\s+/g, ' ').slice(0, 160))
await win.selectOption('#fuel', 'gasolina95')
await win.waitForTimeout(600)

// Mapas ECU abiertos
await win.click('details.map-card summary')
await win.waitForTimeout(400)
const mapCard = await win.locator('details.map-card').boundingBox()
await win.screenshot({ path: join(shots, 'phase3-maps.png'), clip: mapCard })

// Pull transitorio
await win.click('details.map-card summary') // cerrar para la captura del pull
await win.click('.transient-panel .btn.primary')
await win.waitForSelector('.transient-summary', { timeout: 20000 })
await win.waitForTimeout(500)
console.log('pull:', (await win.textContent('.transient-summary')).replace(/\s+/g, ' '))
const panel = await win.locator('.transient-panel').boundingBox()
await win.screenshot({ path: join(shots, 'phase3-pull.png'), clip: panel })

// Vista general
await win.screenshot({ path: join(shots, 'phase3-overview.png') })

await app.close()
console.log('OK')
