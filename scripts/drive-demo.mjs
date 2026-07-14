/**
 * Demo guiada: lanza la app construida (out/), monta un turbo sobre internos
 * de serie hasta romper el motor y luego lo forja para que aguante.
 * La ventana se abre en pantalla — pensada para verla en vivo.
 * Uso: node scripts/drive-demo.mjs [dir-de-capturas]
 */
import { _electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createRequire } = await import('node:module')
const electronPath = createRequire(join(projectDir, 'package.json'))('electron')
const shots = process.argv[2] ?? join(projectDir, 'screenshots')
const PAUSE = 2200 // ms entre pasos, para poder seguirlo en vivo

const app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: projectDir })
const win = await app.firstWindow()
await win.waitForSelector('.stat-value', { timeout: 15000 })
await win.waitForTimeout(PAUSE)

console.log('1) Motor 2.0 NA de serie')
await win.screenshot({ path: join(shots, '1-stock-na.png') })
console.log('   stats:', (await win.locator('.stat-value').allInnerTexts()).join(' | '))

console.log('2) Turbo GT35 a 1.8 bar con internos de serie…')
await win.selectOption('#sel-aspiration', 'asp-turbo-gt35')
await win.selectOption('#sel-injector', 'inj-1000')
await win.evaluate(() => {
  const el = document.querySelector('#boost')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '180000')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await win.waitForTimeout(PAUSE)
await win.screenshot({ path: join(shots, '2-turbo-broken.png') })
console.log('   stats:', (await win.locator('.stat-value').allInnerTexts()).join(' | '))
console.log('   fallos:', (await win.locator('.event .mode').allInnerTexts()).join(' · '))

console.log('3) Mismos ajustes con bloque/cigüeñal/bielas/pistones forjados…')
await win.selectOption('#sel-block', 'block-iron-2.0')
await win.selectOption('#sel-crank', 'crank-forged-86')
await win.selectOption('#sel-rod', 'rod-forged-139')
await win.selectOption('#sel-piston', 'piston-forged-86')
await win.waitForTimeout(PAUSE)
await win.screenshot({ path: join(shots, '3-turbo-forged.png') })
console.log('   stats:', (await win.locator('.stat-value').allInnerTexts()).join(' | '))

console.log('4) La corona del pistón se cocina a 1.8 bar… engordamos la mezcla a λ 0.80')
await win.evaluate(() => {
  const el = document.querySelector('#lambda')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '0.8')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await win.waitForTimeout(PAUSE)
await win.screenshot({ path: join(shots, '4-turbo-rich-saved.png') })
console.log('   stats:', (await win.locator('.stat-value').allInnerTexts()).join(' | '))

await win.waitForTimeout(PAUSE)
await app.close()
console.log('OK')
