import {
  ACP_ERROR_CODES,
  isAcpErrorCode,
  type AcpEvent,
  type EnvelopeEndpoint,
  type ErrorObject,
  type InboundRequest,
  type InboundResponse,
  type RpcRequest,
  type RpcResponse,
  type TransportSubscribeParams,
} from '@acpjs/protocol'

export const HANDSHAKE_CHANNEL = 'acpjs:handshake'
export const PORT_CHANNEL = 'acpjs:port'
export const PORT_MESSAGE = 'acpjs:port'
export const BRIDGE_GLOBAL_KEY = 'acp'

export interface AcpExposedBridge {
  connect: () => Promise<void>
}

export type RendererToMainMessage =
  | { t: 'rpc'; request: RpcRequest }
  | { t: 'subscribe'; subId: string; params: TransportSubscribeParams }
  | { t: 'unsubscribe'; subId: string }
  | { t: 'inbound-response'; ackId: string; response: InboundResponse }
  | { t: 'close' }

export type MainToRendererMessage =
  | { t: 'rpc-result'; response: RpcResponse }
  | { t: 'event'; subId: string; event: AcpEvent }
  | { t: 'sub-error'; subId: string; error: ErrorObject }
  | { t: 'inbound-request'; request: InboundRequest }
  | { t: 'inbound-ack'; ackId: string; error?: ErrorObject }
  | { t: 'closed' }

export interface WirePort {
  postMessage: (data: unknown) => void
  close: () => void
  onMessage: (listener: (data: unknown) => void) => void
  onClose: (listener: () => void) => void
  start: () => void
}

export function toWireError(error: unknown): ErrorObject {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      code?: unknown
      message?: unknown
      data?: unknown
      retryable?: unknown
    }
    if (typeof candidate.code === 'string' && isAcpErrorCode(candidate.code)) {
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : '',
        ...(candidate.data === undefined ? {} : { data: candidate.data }),
        retryable: candidate.retryable === true,
      }
    }
  }
  return {
    code: ACP_ERROR_CODES.agentError,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

export function wireEndpointToPort(
  endpoint: EnvelopeEndpoint,
  port: WirePort,
  onTeardown?: () => void,
): () => void {
  const subscriptions = new Map<string, () => void>()
  let closed = false

  function post(message: MainToRendererMessage): void {
    if (closed) return
    try {
      port.postMessage(message)
    } catch {}
  }

  const detachInbound = endpoint.onInboundRequest((request) => {
    post({ t: 'inbound-request', request })
  })

  function teardown(): void {
    if (closed) return
    closed = true
    detachInbound()
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
    port.close()
    onTeardown?.()
  }

  port.onMessage((data) => {
    if (closed) return
    const message = data as RendererToMainMessage
    switch (message.t) {
      case 'rpc': {
        const id = message.request.id
        void endpoint.request(message.request).then(
          (response) => post({ t: 'rpc-result', response }),
          (error: unknown) =>
            post({
              t: 'rpc-result',
              response: { id, ok: false, error: toWireError(error) },
            }),
        )
        break
      }
      case 'subscribe': {
        if (subscriptions.has(message.subId)) break
        const subId = message.subId
        try {
          subscriptions.set(
            subId,
            endpoint.subscribe(message.params, (event) => {
              post({ t: 'event', subId, event })
            }),
          )
        } catch (error) {
          post({ t: 'sub-error', subId, error: toWireError(error) })
        }
        break
      }
      case 'unsubscribe': {
        subscriptions.get(message.subId)?.()
        subscriptions.delete(message.subId)
        break
      }
      case 'inbound-response': {
        const ackId = message.ackId
        void Promise.resolve()
          .then(() => endpoint.respondInbound(message.response))
          .then(
            () => post({ t: 'inbound-ack', ackId }),
            (error: unknown) =>
              post({ t: 'inbound-ack', ackId, error: toWireError(error) }),
          )
        break
      }
      case 'close': {
        teardown()
        break
      }
    }
  })
  port.onClose(teardown)
  port.start()

  return () => {
    post({ t: 'closed' })
    teardown()
  }
}
