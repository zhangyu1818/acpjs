import { contextBridge, ipcRenderer } from 'electron'

import {
  BRIDGE_GLOBAL_KEY,
  HANDSHAKE_CHANNEL,
  PORT_CHANNEL,
  PORT_MESSAGE,
  type AcpExposedBridge,
} from './wire.ts'

interface PreloadScope {
  [BRIDGE_GLOBAL_KEY]?: AcpExposedBridge
  postMessage?: (
    message: unknown,
    targetOrigin: string,
    transfer?: unknown[],
  ) => void
}

export function exposeAcp(): void {
  const scope = globalThis as PreloadScope
  const contextIsolated = Boolean(process.contextIsolated)
  ipcRenderer.on(PORT_CHANNEL, (event) => {
    scope.postMessage?.(PORT_MESSAGE, '*', [...event.ports])
  })
  const bridge: AcpExposedBridge = {
    async connect() {
      await ipcRenderer.invoke(HANDSHAKE_CHANNEL, { contextIsolated })
    },
  }
  if (contextIsolated) {
    contextBridge.exposeInMainWorld(BRIDGE_GLOBAL_KEY, bridge)
  } else {
    scope[BRIDGE_GLOBAL_KEY] = bridge
  }
}
