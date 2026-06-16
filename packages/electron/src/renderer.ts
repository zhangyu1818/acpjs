import {
  ACP_ERROR_CODES,
  type AcpEvent,
  type ErrorObject,
  type RpcResponse,
  type Transport,
  type TransportHandlers,
  type TransportSubscribeParams,
} from '@acpjs/protocol'

import {
  BRIDGE_GLOBAL_KEY,
  PORT_MESSAGE,
  type AcpExposedBridge,
  type MainToRendererMessage,
  type RendererToMainMessage,
} from './wire.ts'

export interface ElectronTransportOptions {
  requestPort?: () => Promise<MessagePort>
}

export type AcpRendererBridge = AcpExposedBridge

interface PortMessageEvent {
  data: unknown
  ports: readonly MessagePort[]
}

interface HandshakeScope {
  [BRIDGE_GLOBAL_KEY]?: AcpRendererBridge
  addEventListener?: (
    type: 'message',
    listener: (event: PortMessageEvent) => void,
  ) => void
  removeEventListener?: (
    type: 'message',
    listener: (event: PortMessageEvent) => void,
  ) => void
}

function closePort(port: MessagePort | undefined): void {
  try {
    port?.close()
  } catch {}
}

function transportClosedError(): ErrorObject {
  return {
    code: ACP_ERROR_CODES.transportClosed,
    message: 'transport is closed',
    retryable: true,
  }
}

function makeTransportError(errorObject: ErrorObject): Error & ErrorObject {
  const error = new Error(errorObject.message) as Error & ErrorObject
  error.name = 'AcpElectronTransportError'
  error.code = errorObject.code
  if (errorObject.data !== undefined) error.data = errorObject.data
  error.retryable = errorObject.retryable
  return error
}

function defaultRequestPort(): Promise<MessagePort> {
  const scope = globalThis as HandshakeScope
  const bridge = scope[BRIDGE_GLOBAL_KEY]
  const addEventListener = scope.addEventListener
  const removeEventListener = scope.removeEventListener
  if (
    bridge === undefined ||
    typeof addEventListener !== 'function' ||
    typeof removeEventListener !== 'function'
  ) {
    return Promise.reject(
      new Error(
        '@acpjs/electron: handshake bridge unavailable; call exposeAcp() in the preload script',
      ),
    )
  }
  return new Promise((resolve, reject) => {
    const onMessage = (event: PortMessageEvent): void => {
      if (event.data !== PORT_MESSAGE) return
      const port = event.ports[0]
      if (port === undefined) return
      removeEventListener('message', onMessage)
      resolve(port)
    }
    addEventListener('message', onMessage)
    bridge.connect().catch((error: unknown) => {
      removeEventListener('message', onMessage)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

export function electronTransport(
  options: ElectronTransportOptions = {},
): Transport {
  const requestPort = options.requestPort ?? defaultRequestPort
  let status: 'idle' | 'connecting' | 'connected' | 'closed' = 'idle'
  let handlers: TransportHandlers | undefined
  let port: MessagePort | undefined
  const pendingRpcs = new Map<string, (response: RpcResponse) => void>()
  const pendingAcks = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >()
  const subscribers = new Map<
    string,
    { params: TransportSubscribeParams; onEvent: (event: AcpEvent) => void }
  >()
  let subCounter = 0
  let ackCounter = 0

  function isConnecting(): boolean {
    return status === 'connecting'
  }

  function send(message: RendererToMainMessage): void {
    port?.postMessage(message)
  }

  function teardown(error?: ErrorObject): void {
    if (status === 'closed') return
    status = 'closed'
    for (const [id, resolve] of pendingRpcs) {
      resolve({ id, ok: false, error: transportClosedError() })
    }
    pendingRpcs.clear()
    for (const pending of pendingAcks.values()) {
      pending.reject(makeTransportError(transportClosedError()))
    }
    pendingAcks.clear()
    subscribers.clear()
    closePort(port)
    port = undefined
    handlers?.onLifecycle(
      error === undefined ? { status: 'closed' } : { status: 'closed', error },
    )
  }

  function handleMessage(data: unknown): void {
    if (status !== 'connected') return
    const message = data as MainToRendererMessage
    switch (message.t) {
      case 'rpc-result': {
        const resolve = pendingRpcs.get(message.response.id)
        pendingRpcs.delete(message.response.id)
        resolve?.(message.response)
        break
      }
      case 'event': {
        subscribers.get(message.subId)?.onEvent(message.event)
        break
      }
      case 'sub-error': {
        const subscriber = subscribers.get(message.subId)
        subscribers.delete(message.subId)
        if (subscriber) {
          handlers?.onSubscriptionError?.(subscriber.params, message.error)
        }
        break
      }
      case 'inbound-request': {
        handlers?.onInboundRequest(message.request)
        break
      }
      case 'inbound-ack': {
        const pending = pendingAcks.get(message.ackId)
        pendingAcks.delete(message.ackId)
        if (pending === undefined) break
        if (message.error === undefined) pending.resolve()
        else pending.reject(makeTransportError(message.error))
        break
      }
      case 'closed': {
        teardown()
        break
      }
    }
  }

  return {
    async connect(next: TransportHandlers): Promise<void> {
      if (status === 'closed') {
        throw makeTransportError(transportClosedError())
      }
      if (status !== 'idle') {
        throw makeTransportError({
          code: ACP_ERROR_CODES.configInvalid,
          message: 'transport already connected',
          retryable: false,
        })
      }
      status = 'connecting'
      handlers = next
      next.onLifecycle({ status: 'connecting' })
      let acquired: MessagePort
      try {
        acquired = await requestPort()
      } catch (error) {
        const errorObject: ErrorObject = {
          code: ACP_ERROR_CODES.transportClosed,
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        }
        teardown(errorObject)
        throw makeTransportError(errorObject)
      }
      if (!isConnecting()) {
        acquired.close()
        throw makeTransportError(transportClosedError())
      }
      port = acquired
      acquired.onmessage = (event: { data: unknown }) => {
        handleMessage(event.data)
      }
      acquired.addEventListener('close', () => {
        teardown()
      })
      acquired.start()
      status = 'connected'
      next.onLifecycle({ status: 'connected' })
    },
    async request(request) {
      if (status !== 'connected') {
        return { id: request.id, ok: false, error: transportClosedError() }
      }
      return new Promise((resolve) => {
        send({ t: 'rpc', request })
        pendingRpcs.set(request.id, resolve)
      })
    },
    subscribe(params, onEvent) {
      if (status !== 'connected') {
        throw makeTransportError(transportClosedError())
      }
      subCounter += 1
      const subId = `sub-${subCounter}`
      subscribers.set(subId, { params, onEvent })
      send({ t: 'subscribe', subId, params })
      return () => {
        if (!subscribers.delete(subId)) return
        if (status === 'connected') send({ t: 'unsubscribe', subId })
      }
    },
    async respondInbound(response) {
      if (status !== 'connected') {
        throw makeTransportError(transportClosedError())
      }
      return new Promise<void>((resolve, reject) => {
        ackCounter += 1
        const ackId = `ack-${ackCounter}`
        send({ t: 'inbound-response', ackId, response })
        pendingAcks.set(ackId, { resolve, reject })
      })
    },
    async close() {
      if (status === 'closed') return
      if (status === 'connected') {
        try {
          send({ t: 'close' })
        } catch {
          port = undefined
        }
      }
      teardown()
    },
  }
}
