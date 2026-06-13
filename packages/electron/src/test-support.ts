import { electronTransport } from './renderer.ts'
import { wireEndpointToPort, type WirePort } from './wire.ts'

import type {
  AcpEvent,
  EnvelopeEndpoint,
  InboundRequest,
  RpcRequest,
  Transport,
  TransportHandlers,
  TransportLifecycleEvent,
  TransportSubscribeParams,
} from '@acpjs/protocol'

export function asWirePort(port: MessagePort): WirePort {
  return {
    postMessage: (data) => port.postMessage(data),
    close: () => port.close(),
    onMessage(listener) {
      port.addEventListener('message', (event) => {
        listener(event.data)
      })
    },
    onClose(listener) {
      port.addEventListener('close', listener)
    },
    start: () => port.start(),
  }
}

export function makeEvent(sessionId: string, seq: number): AcpEvent {
  return {
    sessionId,
    seq,
    ts: 1,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: `chunk-${seq}` } },
  } as unknown as AcpEvent
}

export interface FakeEndpoint {
  endpoint: EnvelopeEndpoint
  requests: RpcRequest[]
  subscriptions: {
    params: TransportSubscribeParams
    emit: (event: AcpEvent) => void
    active: boolean
  }[]
  inboundResponses: unknown[]
  pushInbound: (request: InboundRequest) => void
  respondInboundImpl: { fn: (response: unknown) => Promise<void> }
}

export function fakeEndpoint(): FakeEndpoint {
  const requests: RpcRequest[] = []
  const subscriptions: FakeEndpoint['subscriptions'] = []
  const inboundResponses: unknown[] = []
  const inboundHandlers = new Set<(request: InboundRequest) => void>()
  const respondInboundImpl = {
    async fn(_response: unknown): Promise<void> {},
  }
  const endpoint: EnvelopeEndpoint = {
    async request(request) {
      requests.push(request)
      return { id: request.id, ok: true, result: { echo: request.method } }
    },
    subscribe(params, onEvent) {
      const record = {
        params,
        emit(event: AcpEvent) {
          if (record.active) onEvent(event)
        },
        active: true,
      }
      subscriptions.push(record)
      return () => {
        record.active = false
      }
    },
    onInboundRequest(handler) {
      inboundHandlers.add(handler)
      return () => inboundHandlers.delete(handler)
    },
    async respondInbound(response) {
      inboundResponses.push(response)
      await respondInboundImpl.fn(response)
    },
  }
  return {
    endpoint,
    requests,
    subscriptions,
    inboundResponses,
    pushInbound(request) {
      for (const handler of inboundHandlers) handler(request)
    },
    respondInboundImpl,
  }
}

export interface Rig {
  transport: Transport
  fake: FakeEndpoint
  lifecycle: TransportLifecycleEvent[]
  inbound: InboundRequest[]
  detach: () => void
}

export async function connectedRig(): Promise<Rig> {
  const channel = new MessageChannel()
  const fake = fakeEndpoint()
  const detach = wireEndpointToPort(fake.endpoint, asWirePort(channel.port1))
  const transport = electronTransport({
    requestPort: async () => channel.port2,
  })
  const lifecycle: TransportLifecycleEvent[] = []
  const inbound: InboundRequest[] = []
  await transport.connect({
    onInboundRequest: (request) => inbound.push(request),
    onLifecycle: (event) => lifecycle.push(event),
  })
  return { transport, fake, lifecycle, inbound, detach }
}

export const noopHandlers: TransportHandlers = {
  onInboundRequest() {},
  onLifecycle() {},
}
