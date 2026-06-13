import { expect, test } from 'vitest'

import { AcpClientError, createInProcessTransport } from './index.ts'

import type {
  EnvelopeEndpoint,
  InboundRequest,
  TransportLifecycleEvent,
  TransportSubscribeParams,
} from '@acpjs/protocol'

function stubEndpoint(): {
  endpoint: EnvelopeEndpoint
  pushInbound: (request: InboundRequest) => void
  active: Set<TransportSubscribeParams>
} {
  const inboundHandlers = new Set<(request: InboundRequest) => void>()
  const active = new Set<TransportSubscribeParams>()
  return {
    endpoint: {
      async request(request) {
        return { id: request.id, ok: true, result: { echoed: request.method } }
      },
      subscribe(params) {
        active.add(params)
        return () => active.delete(params)
      },
      onInboundRequest(handler) {
        inboundHandlers.add(handler)
        return () => inboundHandlers.delete(handler)
      },
      async respondInbound() {},
    },
    pushInbound(request) {
      for (const handler of inboundHandlers) handler(request)
    },
    active,
  }
}

test('the in-process transport reports connecting then connected and delegates envelopes', async () => {
  const { endpoint, pushInbound } = stubEndpoint()
  const transport = createInProcessTransport(endpoint)
  const lifecycle: TransportLifecycleEvent[] = []
  const inbound: InboundRequest[] = []

  await transport.connect({
    onInboundRequest: (request) => inbound.push(request),
    onLifecycle: (event) => lifecycle.push(event),
  })

  expect(lifecycle).toEqual([{ status: 'connecting' }, { status: 'connected' }])

  const response = await transport.request({
    id: 'r1',
    method: 'agents/spawn',
    params: {},
  })
  expect(response).toEqual({
    id: 'r1',
    ok: true,
    result: { echoed: 'agents/spawn' },
  })

  pushInbound({ id: 'perm-1', kind: 'permission', payload: {} })
  expect(inbound).toEqual([{ id: 'perm-1', kind: 'permission', payload: {} }])
})

test('subscribe outside the connected state throws instead of silently dropping the subscription', async () => {
  const { endpoint } = stubEndpoint()
  const transport = createInProcessTransport(endpoint)

  expect(() =>
    transport.subscribe({ sessionId: 's', fromSeq: 0 }, () => {}),
  ).toThrowError(AcpClientError)

  await transport.connect({ onInboundRequest() {}, onLifecycle() {} })
  await transport.close()

  expect(() =>
    transport.subscribe({ sessionId: 's', fromSeq: 0 }, () => {}),
  ).toThrowError(AcpClientError)
})

test('connecting an already connected transport throws acpjs/config-invalid', async () => {
  const { endpoint } = stubEndpoint()
  const transport = createInProcessTransport(endpoint)
  const handlers = { onInboundRequest() {}, onLifecycle() {} }
  await transport.connect(handlers)

  await expect(transport.connect(handlers)).rejects.toMatchObject({
    code: 'acpjs/config-invalid',
  })
})

test('close tears down subscriptions, reports closed and fails later envelopes', async () => {
  const { endpoint, pushInbound, active } = stubEndpoint()
  const transport = createInProcessTransport(endpoint)
  const lifecycle: TransportLifecycleEvent[] = []
  const inbound: InboundRequest[] = []
  await transport.connect({
    onInboundRequest: (request) => inbound.push(request),
    onLifecycle: (event) => lifecycle.push(event),
  })
  transport.subscribe({ sessionId: 's', fromSeq: 0 }, () => {})
  expect(active.size).toBe(1)

  await transport.close()

  expect(active.size).toBe(0)
  expect(lifecycle.at(-1)).toEqual({ status: 'closed' })
  pushInbound({ id: 'perm-1', kind: 'permission', payload: {} })
  expect(inbound).toEqual([])

  const response = await transport.request({
    id: 'r1',
    method: 'x',
    params: {},
  })
  expect(response).toMatchObject({
    id: 'r1',
    ok: false,
    error: { code: 'acpjs/transport-closed' },
  })
  await expect(
    transport.respondInbound({ id: 'perm-1', result: {} }),
  ).rejects.toMatchObject({ code: 'acpjs/transport-closed' })
})
