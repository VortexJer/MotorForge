import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Esquema propio para producción: a diferencia de file://, permite fetch()
// (necesario para cargar el WASM de OCCT) y rutas relativas limpias.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const CAD_FILTERS = [
  { name: 'CAD', extensions: ['step', 'stp', 'iges', 'igs', 'stl'] },
  { name: 'Todos', extensions: ['*'] }
]

function importedPartsPath(): string {
  return join(app.getPath('userData'), 'imported-parts.json')
}

function registerIpc(): void {
  ipcMain.handle('pick-cad-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: CAD_FILTERS })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return null
    const buf = await readFile(filePath)
    return {
      name: basename(filePath),
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
  })

  ipcMain.handle('save-imported-parts', async (_e, json: string) => {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(importedPartsPath(), json, 'utf8')
  })

  ipcMain.handle('load-imported-parts', async () => {
    try {
      return await readFile(importedPartsPath(), 'utf8')
    } catch {
      return null
    }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    title: 'MotorForge',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // el preload es ESM (.mjs) y Electron no lo admite en renderers sandboxed;
      // contextIsolation sigue activo y es la barrera de seguridad real aquí
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadURL('app://bundle/index.html')
  }
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url)
    const filePath = join(__dirname, '../renderer', decodeURIComponent(pathname))
    return net.fetch(pathToFileURL(filePath).toString())
  })

  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
