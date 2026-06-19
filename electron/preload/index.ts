import { contextBridge, ipcRenderer, webFrame } from 'electron'

import { createElectronApi } from './electron-api'

// Expose a typed API to the renderer process via window.electron
contextBridge.exposeInMainWorld('electron', createElectronApi(ipcRenderer, webFrame))
