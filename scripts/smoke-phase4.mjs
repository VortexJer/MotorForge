/** Smoke fase 4: overlays 3D de utilización, banco de resistencia y FEA vóxel. */
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
await win.waitForTimeout(800)

// ---- Overlays 3D: térmico y estructural sobre el motor de serie ----
const overlayCard = win.locator('.chart-card', { has: win.locator('.segmented') }).first()
await win.click('.seg-btn:has-text("Térmico")')
await win.waitForTimeout(700)
await win.screenshot({ path: join(shots, 'phase4-overlay-termico.png'), clip: await overlayCard.boundingBox() })

await win.click('.seg-btn:has-text("Estructural")')
await win.waitForTimeout(700)
await win.screenshot({ path: join(shots, 'phase4-overlay-estructural.png'), clip: await overlayCard.boundingBox() })
await win.click('.seg-btn:has-text("Normal")')

// ---- Banco de resistencia: stock al límite 60 min → fatiga ----
await win.selectOption('#endurance-minutes', '60')
const endurance = win.locator('.transient-panel', { hasText: 'Banco de resistencia' })
await endurance.locator('.seg-btn:has-text("Al límite")').click()
await endurance.locator('.btn.primary').click()
await win.waitForSelector('.wear-bars', { timeout: 20000 })
await win.waitForTimeout(500)
console.log('resistencia limite:', (await endurance.locator('.transient-summary').textContent()).replace(/\s+/g, ' '))
await win.screenshot({ path: join(shots, 'phase4-endurance.png'), clip: await endurance.boundingBox() })

// ---- Turbo + 95: el picado revienta el ringland en minutos ----
await win.selectOption('#sel-injector', 'inj-1000')
await win.selectOption('#sel-fuelPump', 'pump-255')
await win.selectOption('#sel-aspiration', 'asp-turbo-gt35')
await win.waitForTimeout(900)
await endurance.locator('.seg-btn:has-text("Deportivo")').click()
await win.selectOption('#endurance-minutes', '15')
await endurance.locator('.btn.primary').click()
await win.waitForSelector('.wear-bars', { timeout: 20000 })
await win.waitForTimeout(500)
console.log('resistencia knock 95:', (await endurance.locator('.transient-summary').textContent()).replace(/\s+/g, ' '))
await win.screenshot({ path: join(shots, 'phase4-endurance-knock.png'), clip: await endurance.boundingBox() })

await app.close()
console.log('OK')
