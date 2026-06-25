import { createHostEndpoint, type AcpHost } from '@acpjs/core'
import {
  ipcMain,
  MessageChannelMain,
  type IpcMainInvokeEvent,
  type MessagePortMain,
} from 'electron'

import {
  HANDSHAKE_CHANNEL,
  PORT_CHANNEL,
  wireEndpointToPort,
  type WirePort,
} from './wire.ts'

export type DetachAcpBridge = () => void

function isIsolatedHandshake(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  return (payload as { contextIsolated?: unknown }).contextIsolated === true
}

function asWirePort(port: MessagePortMain): WirePort {
  return {
    postMessage: (data) => port.postMessage(data),
    close: () => port.close(),
    onMessage(listener) {
      port.on('message', (event) => listener(event.data))
    },
    onClose(listener) {
      port.on('close', listener)
    },
    start: () => port.start(),
  }
}

export function attachAcpBridge(host: AcpHost): DetachAcpBridge {
  const endpoint = createHostEndpoint(host)
  const detachers = new Set<() => void>()

  ipcMain.handle(
    HANDSHAKE_CHANNEL,
    (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!isIsolatedHandshake(payload)) {
        throw new Error(
          '@acpjs/electron: handshake rejected, contextIsolation must be enabled for this window',
        )
      }
      const sender = event.sender
      if (sender.isDestroyed()) return
      const { port1, port2 } = new MessageChannelMain()
      const detach = wireEndpointToPort(endpoint, asWirePort(port1), () => {
        detachers.delete(detach)
        sender.removeListener('destroyed', detach)
      })
      detachers.add(detach)
      sender.on('destroyed', detach)
      sender.postMessage(PORT_CHANNEL, null, [port2])
    },
  )

  return () => {
    ipcMain.removeHandler(HANDSHAKE_CHANNEL)
    for (const detach of detachers) detach()
  }
}
