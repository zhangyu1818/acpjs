import { expect, test, vi } from 'vitest'

import { electronTransport } from './renderer.ts'
import {
  asWirePort,
  connectedRig,
  fakeEndpoint,
  noopHandlers,
} from './test-support.ts'
import { wireEndpointToPort } from './wire.ts'

test('close rejects in-flight respondInbound acks with a retryable transport-closed error', async () => {
  const rig = await connectedRig()
  rig.fake.respondInboundImpl.fn = () => new Promise<void>(() => {})
  const pendingAck = rig.transport.respondInbound({
    id: 'perm-1',
    result: { outcome: 'cancelled' },
  })
  await vi.waitFor(() => expect(rig.fake.inboundResponses).toHaveLength(1))

  await rig.transport.close()

  await expect(pendingAck).rejects.toMatchObject({
    code: 'acpjs/transport-closed',
    retryable: true,
  })
})

test('connect after close rejects with transport-closed', async () => {
  const channel = new MessageChannel()
  const transport = electronTransport({
    requestPort: async () => channel.port2,
  })
  await transport.close()

  await expect(transport.connect(noopHandlers)).rejects.toMatchObject({
    code: 'acpjs/transport-closed',
  })
  channel.port1.close()
  channel.port2.close()
})

test('unsubscribe is idempotent and only releases the endpoint subscription once', async () => {
  const rig = await connectedRig()
  const unsubscribe = rig.transport.subscribe(
    { sessionId: 's-1', fromSeq: 0 },
    () => {},
  )
  await vi.waitFor(() => expect(rig.fake.subscriptions).toHaveLength(1))

  unsubscribe()
  expect(() => unsubscribe()).not.toThrow()
  await rig.transport.request({ id: 'rpc-flush', method: 'noop', params: {} })

  expect(rig.fake.subscriptions).toHaveLength(1)
  expect(rig.fake.subscriptions[0]?.active).toBe(false)
  await rig.transport.close()
})

test('the wire ignores duplicate subscribe messages for the same subId', async () => {
  const channel = new MessageChannel()
  const fake = fakeEndpoint()
  wireEndpointToPort(fake.endpoint, asWirePort(channel.port1))
  channel.port2.start()

  channel.port2.postMessage({
    t: 'subscribe',
    subId: 'dup-1',
    params: { fromSeq: 0 },
  })
  channel.port2.postMessage({
    t: 'subscribe',
    subId: 'dup-1',
    params: { fromSeq: 5 },
  })
  channel.port2.postMessage({
    t: 'rpc',
    request: { id: 'flush', method: 'noop', params: {} },
  })

  await vi.waitFor(() => expect(fake.requests).toHaveLength(1))
  expect(fake.subscriptions).toHaveLength(1)
  expect(fake.subscriptions[0]?.params).toEqual({ fromSeq: 0 })
  channel.port2.close()
})
