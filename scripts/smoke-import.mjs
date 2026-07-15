/**
 * Smoke de importación CAD (fase 2): STEP real → worker OCCT-WASM →
 * métricas + límites derivados → guardar y persistir. También comprueba
 * que un fichero corrupto produce un error legible.
 */
import { _electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createRequire } = await import('node:module')
const electronPath = createRequire(join(projectDir, 'package.json'))('electron')
const shots = process.argv[2] ?? join(projectDir, 'screenshots')

// Ojo: no vale cualquier fichero del kit CAx-IF — algunos (p. ej. FOOT.stp)
// devuelven 0 mallas al teselar. io1-tu-203.stp es un sólido único válido.
const stepFile = join(
  projectDir,
  'node_modules/occt-import-js/test/testfiles/cax-if/io1-tu-203.stp'
)
const tempData = mkdtempSync(join(tmpdir(), 'motorforge-smoke-'))
const garbageFile = join(tempData, 'garbage.step')
writeFileSync(garbageFile, 'esto no es un STEP valido')

const app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: projectDir })

// userData temporal: la persistencia del smoke no debe ensuciar el perfil real
await app.evaluate(({ app: a }, dir) => a.setPath('userData', dir), tempData)

const win = await app.firstWindow()
await win.waitForSelector('canvas', { timeout: 15000 })

// 1) Diálogo nativo stubeado → STEP real del kit de tests de OCCT
await app.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
}, stepFile)

await win.click('.import-btn')
await win.waitForSelector('.metrics-list', { timeout: 45000 })
await win.waitForTimeout(700)
await win.screenshot({ path: join(shots, 'import-dialog.png') })

await win.fill('#imp-name', 'Biela STEP de prueba')
await win.click('.modal-foot .btn.primary')
await win.waitForSelector('.modal-overlay', { state: 'detached', timeout: 10000 })

const rodValue = await win.inputValue('#sel-rod')
if (!rodValue.startsWith('imported-rod-')) {
  throw new Error(`la pieza importada no quedó seleccionada: ${rodValue}`)
}
const saved = await win.evaluate(() => window.motorforge.loadImportedParts())
const parts = JSON.parse(saved ?? '[]')
if (parts.length !== 1 || parts[0].name !== 'Biela STEP de prueba') {
  throw new Error('la persistencia de piezas importadas falló')
}
console.log('importada y persistida:', parts[0].id, '·', parts[0].limits.length, 'límites')
await win.waitForTimeout(400)
await win.screenshot({ path: join(shots, 'import-saved.png') })

// 2) Fichero corrupto → error legible, no cuelgue
await app.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
}, garbageFile)
await win.click('.import-btn')
await win.waitForSelector('.modal .issue.error', { timeout: 45000 })
console.log('error esperado:', (await win.textContent('.modal .issue.error')).trim())
await win.click('.modal-foot .btn:not(.primary)')

await app.close()
console.log('OK')
