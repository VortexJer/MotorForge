/** Smoke fase 5: proyectos (guardar/abrir/sesión), desgaste persistente, A/B y CSV. */
import { _electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createRequire } = await import('node:module')
const electronPath = createRequire(join(projectDir, 'package.json'))('electron')
const shots = process.argv[2] ?? join(projectDir, 'screenshots')

const tempData = mkdtempSync(join(tmpdir(), 'motorforge-smoke5-'))
const projectFile = join(tempData, 'mi-motor.mforge.json')
const csvFile = join(tempData, 'dyno.csv')

const app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: projectDir })
await app.evaluate(({ app: a }, dir) => a.setPath('userData', dir), tempData)
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.waitForSelector('canvas', { timeout: 15000 })
await win.waitForTimeout(800)

const endurance = win.locator('.transient-panel', { hasText: 'Banco de resistencia' })

// ---- 1) Desgaste acumulado entre tandas + histórico ----
await endurance.locator('.seg-btn:has-text("Al límite")').click()
await win.selectOption('#endurance-minutes', '15')
await endurance.locator('.btn.primary').click()
await win.waitForSelector('.wear-bars', { timeout: 20000 })
const rod1 = await endurance.locator('.wear-row', { hasText: 'Fatiga de biela' }).locator('.wear-pct').textContent()

await endurance.locator('.btn.primary').click()
await win.waitForTimeout(600)
const rod2 = await endurance.locator('.wear-row', { hasText: 'Fatiga de biela' }).locator('.wear-pct').textContent()
const histRows = await endurance.locator('.endurance-history tbody tr').count()
console.log(`acumulación: biela ${rod1.trim()} → ${rod2.trim()} · histórico ${histRows} tandas`)
if (parseInt(rod2) <= parseInt(rod1)) throw new Error('el desgaste no se acumula entre tandas')
if (histRows !== 2) throw new Error('el histórico no registra las tandas')
await win.screenshot({ path: join(shots, 'phase5-endurance-acumulado.png'), clip: await endurance.boundingBox() })

// Motor a estrenar
await endurance.locator('.btn:has-text("Motor a estrenar")').click()
await win.waitForTimeout(400)

// ---- 2) Comparador A/B + CSV ----
await win.click('.dyno-toolbar .btn:has-text("Fijar como referencia")')
await win.selectOption('#fuel', 'e85')
await win.waitForTimeout(900)
const chip = (await win.textContent('.ref-chip')).replace(/\s+/g, ' ')
console.log('A/B:', chip)

await app.evaluate(({ dialog }, file) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
}, csvFile)
await win.click('.dyno-toolbar .btn:has-text("Exportar CSV")')
await win.waitForTimeout(600)
if (!existsSync(csvFile) || !readFileSync(csvFile, 'utf8').startsWith('rpm,potencia_cv')) {
  throw new Error('el CSV no se exportó')
}
console.log('CSV exportado:', readFileSync(csvFile, 'utf8').split('\n').length - 1, 'filas')

const powerChart = win.locator('.chart-card', { hasText: 'Potencia (CV)' })
await win.screenshot({ path: join(shots, 'phase5-ab.png'), clip: await powerChart.boundingBox() })

// ---- 3) Guardar proyecto, cambiar todo, abrirlo y comprobar restauración ----
await win.selectOption('#sel-cooling', 'cool-race')
await win.waitForTimeout(400)
await app.evaluate(({ dialog }, file) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
}, projectFile)
await win.click('.topbar-actions .btn:has-text("Guardar proyecto")')
await win.waitForTimeout(600)
if (!existsSync(projectFile)) throw new Error('el proyecto no se guardó')
console.log('proyecto guardado:', JSON.parse(readFileSync(projectFile, 'utf8')).selection.cooling)

await win.selectOption('#sel-cooling', 'cool-stock')
await win.selectOption('#fuel', 'gasolina98')
await win.waitForTimeout(400)

await app.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
}, projectFile)
await win.click('.topbar-actions .btn:has-text("Abrir proyecto")')
await win.waitForTimeout(700)
const cooling = await win.inputValue('#sel-cooling')
const fuelSel = await win.inputValue('#fuel')
if (cooling !== 'cool-race' || fuelSel !== 'e85') {
  throw new Error(`el proyecto no restauró el estado: cooling=${cooling}, fuel=${fuelSel}`)
}
console.log('proyecto restaurado: cooling', cooling, '· fuel', fuelSel)

// ---- 4) Autosave de sesión: recargar y comprobar que el taller persiste ----
await win.waitForTimeout(1200) // deja disparar el autosave (debounce 600 ms)
await win.reload()
await win.waitForSelector('canvas', { timeout: 15000 })
await win.waitForTimeout(900)
const coolingAfter = await win.inputValue('#sel-cooling')
if (coolingAfter !== 'cool-race') throw new Error(`la sesión no persistió: cooling=${coolingAfter}`)
console.log('sesión restaurada tras recarga: cooling', coolingAfter)

await app.close()
console.log('OK')
