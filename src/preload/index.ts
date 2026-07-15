import { contextBridge, ipcRenderer } from 'electron'

export interface PickedCadFile {
  name: string
  data: ArrayBuffer
}

const api = {
  pickCadFile: (): Promise<PickedCadFile | null> => ipcRenderer.invoke('pick-cad-file'),
  saveImportedParts: (json: string): Promise<void> => ipcRenderer.invoke('save-imported-parts', json),
  loadImportedParts: (): Promise<string | null> => ipcRenderer.invoke('load-imported-parts')
}

export type MotorForgeApi = typeof api

contextBridge.exposeInMainWorld('motorforge', api)
