import { contextBridge, ipcRenderer } from 'electron'

export interface PickedCadFile {
  name: string
  data: ArrayBuffer
}

const api = {
  pickCadFile: (): Promise<PickedCadFile | null> => ipcRenderer.invoke('pick-cad-file'),
  saveImportedParts: (json: string): Promise<void> => ipcRenderer.invoke('save-imported-parts', json),
  loadImportedParts: (): Promise<string | null> => ipcRenderer.invoke('load-imported-parts'),
  saveProject: (json: string, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('save-project', json, suggestedName),
  openProject: (): Promise<{ name: string; json: string } | null> => ipcRenderer.invoke('open-project'),
  saveSession: (json: string): Promise<void> => ipcRenderer.invoke('save-session', json),
  loadSession: (): Promise<string | null> => ipcRenderer.invoke('load-session'),
  exportText: (defaultName: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke('export-text', defaultName, content),
  /** Guarda la captura de la caja negra: .csv de muestras + .json de manifiesto. */
  saveBlackBox: (csv: string, manifest: string, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('save-blackbox', csv, manifest, suggestedName)
}

export type MotorForgeApi = typeof api

contextBridge.exposeInMainWorld('motorforge', api)
