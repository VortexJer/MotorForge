/** Verificación rápida del 3D: captura lejos (carcasa) y cerca (interior). */
import { _electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createRequire } = await import('node:module')
const electronPath = createRequire(join(projectDir, 'package.json'))('electron')
const shots = process.argv[2] ?? join(projectDir, 'screenshots')

const app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: projectDir })
const win = await app.firstWindow()
await win.waitForSelector('canvas', { timeout: 15000 })
// Provocar un fallo para ver el latido rojo: turbo + boost alto
await win.selectOption('#sel-aspiration', 'asp-turbo-gt35')
await win.evaluate(() => {
  const el = document.querySelector('#boost')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '180000')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await win.waitForTimeout(800)

const canvas = await win.locator('canvas').boundingBox()
const cx = canvas.x + canvas.width / 2
const cy = canvas.y + canvas.height / 2
await win.screenshot({ path: join(shots, '3d-far.png'), clip: canvas })

await win.mouse.move(cx, cy)
for (let i = 0; i < 14; i++) {
  await win.mouse.wheel(0, -150)
  await win.waitForTimeout(60)
}
await win.waitForTimeout(700)
await win.screenshot({ path: join(shots, '3d-near.png'), clip: canvas })

await app.close()
console.log('OK')
