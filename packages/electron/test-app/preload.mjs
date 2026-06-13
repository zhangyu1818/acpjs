import { contextBridge, ipcRenderer } from 'electron'

import { exposeAcp } from '../dist/preload.js'

exposeAcp()

const harness = {
  report: (role, data) => ipcRenderer.send('e2e:report', { role, data }),
  signal: (name, data) => ipcRenderer.send('e2e:signal', { name, data }),
  wait: (name) => ipcRenderer.invoke('e2e:wait', name),
  config: () => ipcRenderer.invoke('e2e:config'),
  destroyedListeners: () => ipcRenderer.invoke('e2e:destroyedListeners'),
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('harness', harness)
} else {
  window.harness = harness
}
