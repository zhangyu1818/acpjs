import { expect, test, vi } from 'vitest'

import { electronTransport } from './renderer.ts'
import {
  asWirePort,
  connectedRig,
  fakeEndpoint,
  makeEvent,
  noopHandlers,
} from './test-support.ts'
import { wireEndpointToPort } from './wire.ts'

import type { TransportLifecycleEvent } from '@acpjs/protocol'

test('connect acquires a port and reports connecting then connected', async () => {
  const rig = await connectedRig()
  expect(rig.lifecycle).toEqual([
    { status: 'connecting' },
    { status: 'connected' },
  ])
  await rig.transport.close()
})

test('connect rejects and reports closed lifecycle when handshake fails', async () => {
  const transport = electronTransport({
    async requestPort() {
      throw new Error('contextIsolation must be enabled')
    },
  })
  const lifecycle: TransportLifecycleEvent[] = []
  await expect(
    transport.connect({
      onInboundRequest() {},
      onLifecycle: (event) => lifecycle.push(event),
    }),
  ).rejects.toMatchObject({
    code: 'acpjs/transport-closed',
    message: 'contextIsolation must be enabled',
  })
  expect(lifecycle).toEqual([
    { status: 'connecting' },
    {
      status: 'closed',
      error: {
        code: 'acpjs/transport-closed',
        message: 'contextIsolation must be enabled',
        retryable: false,
      },
    },
  ])
})

test('second connect is rejected', async () => {
  const rig = await connectedRig()
  await expect(rig.transport.connect(noopHandlers)).rejects.toMatchObject({
    code: 'acpjs/config-invalid',
  })
  await rig.transport.close()
})

test('request round-trips an rpc envelope to the endpoint', async () => {
  const rig = await connectedRig()
  const response = await rig.transport.request({
    id: 'rpc-1',
    method: 'sessions/create',
    params: { cwd: '/tmp' },
  })
  expect(response).toEqual({
    id: 'rpc-1',
    ok: true,
    result: { echo: 'sessions/create' },
  })
  expect(rig.fake.requests).toEqual([
    { id: 'rpc-1', method: 'sessions/create', params: { cwd: '/tmp' } },
  ])
  await rig.transport.close()
})

test('concurrent requests resolve to their own responses by id', async () => {
  const rig = await connectedRig()
  const [first, second] = await Promise.all([
    rig.transport.request({ id: 'rpc-1', method: 'a', params: {} }),
    rig.transport.request({ id: 'rpc-2', method: 'b', params: {} }),
  ])
  expect(first).toMatchObject({ id: 'rpc-1', result: { echo: 'a' } })
  expect(second).toMatchObject({ id: 'rpc-2', result: { echo: 'b' } })
  await rig.transport.close()
})

test('an endpoint request rejection resolves the rpc with an error envelope', async () => {
  const rig = await connectedRig()
  rig.fake.endpoint.request = async () => {
    throw new Error('endpoint broke')
  }
  const response = await rig.transport.request({
    id: 'rpc-1',
    method: 'm',
    params: {},
  })
  expect(response).toEqual({
    id: 'rpc-1',
    ok: false,
    error: {
      code: 'acpjs/agent-error',
      message: 'endpoint broke',
      retryable: false,
    },
  })
  await rig.transport.close()
})

test('payloads cross the port by structured clone, not by reference', async () => {
  const rig = await connectedRig()
  const params = { nested: { list: [1, 2, 3] } }
  await rig.transport.request({ id: 'rpc-1', method: 'm', params })
  expect(rig.fake.requests[0]?.params).toEqual(params)
  expect(rig.fake.requests[0]?.params).not.toBe(params)
  await rig.transport.close()
})

test('request with non-cloneable params rejects instead of hanging', async () => {
  const rig = await connectedRig()
  await expect(
    rig.transport.request({
      id: 'rpc-1',
      method: 'm',
      params: { fn() {} } as unknown as Record<string, unknown>,
    }),
  ).rejects.toThrowError()
  await rig.transport.close()
})

test('subscribe forwards fromSeq and delivers events in order', async () => {
  const rig = await connectedRig()
  const received: number[] = []
  rig.transport.subscribe({ sessionId: 's-1', fromSeq: 2 }, (event) => {
    received.push(event.seq)
  })
  await vi.waitFor(() => expect(rig.fake.subscriptions).toHaveLength(1))
  expect(rig.fake.subscriptions[0]?.params).toEqual({
    sessionId: 's-1',
    fromSeq: 2,
  })
  for (let seq = 3; seq <= 30; seq += 1) {
    rig.fake.subscriptions[0]?.emit(makeEvent('s-1', seq))
  }
  await vi.waitFor(() => expect(received).toHaveLength(28))
  expect(received).toEqual(Array.from({ length: 28 }, (_, index) => index + 3))
  await rig.transport.close()
})

test('two subscriptions deliver independently and keep per-subscription order', async () => {
  const rig = await connectedRig()
  const first: number[] = []
  const second: number[] = []
  rig.transport.subscribe({ sessionId: 's-1', fromSeq: 0 }, (event) =>
    first.push(event.seq),
  )
  rig.transport.subscribe({ sessionId: 's-2', fromSeq: 0 }, (event) =>
    second.push(event.seq),
  )
  await vi.waitFor(() => expect(rig.fake.subscriptions).toHaveLength(2))
  for (let seq = 1; seq <= 10; seq += 1) {
    rig.fake.subscriptions[0]?.emit(makeEvent('s-1', seq))
    rig.fake.subscriptions[1]?.emit(makeEvent('s-2', seq))
  }
  await vi.waitFor(() => expect(second).toHaveLength(10))
  expect(first).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(second).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  await rig.transport.close()
})

test('a subscribe that throws on the endpoint stays isolated and keeps the port alive', async () => {
  const rig = await connectedRig()
  const subscribeOk = rig.fake.endpoint.subscribe
  rig.fake.endpoint.subscribe = (params, onEvent) => {
    if (params.sessionId === 'missing') {
      const error = new Error('unknown session: missing') as Error & {
        code: string
        retryable: boolean
      }
      error.code = 'acpjs/session-closed'
      error.retryable = false
      throw error
    }
    return subscribeOk(params, onEvent)
  }
  const fromMissing: number[] = []
  rig.transport.subscribe({ sessionId: 'missing', fromSeq: 0 }, (event) =>
    fromMissing.push(event.seq),
  )
  const fromLive: number[] = []
  rig.transport.subscribe({ sessionId: 's-1', fromSeq: 0 }, (event) =>
    fromLive.push(event.seq),
  )
  await vi.waitFor(() => expect(rig.fake.subscriptions).toHaveLength(1))
  rig.fake.subscriptions[0]?.emit(makeEvent('s-1', 1))
  const response = await rig.transport.request({
    id: 'rpc-1',
    method: 'm',
    params: {},
  })
  expect(response.ok).toBe(true)
  await vi.waitFor(() => expect(fromLive).toEqual([1]))
  expect(fromMissing).toEqual([])
  await rig.transport.close()
})

test('unsubscribe stops delivery and releases the endpoint subscription', async () => {
  const rig = await connectedRig()
  const received: number[] = []
  const unsubscribe = rig.transport.subscribe(
    { sessionId: 's-1', fromSeq: 0 },
    (event) => received.push(event.seq),
  )
  await vi.waitFor(() => expect(rig.fake.subscriptions).toHaveLength(1))
  rig.fake.subscriptions[0]?.emit(makeEvent('s-1', 1))
  await vi.waitFor(() => expect(received).toEqual([1]))
  unsubscribe()
  await vi.waitFor(() => expect(rig.fake.subscriptions[0]?.active).toBe(false))
  rig.fake.subscriptions[0]?.emit(makeEvent('s-1', 2))
  await rig.transport.request({ id: 'rpc-flush', method: 'noop', params: {} })
  expect(received).toEqual([1])
  await rig.transport.close()
})

test('inbound requests reach the connect handlers and respondInbound acks', async () => {
  const rig = await connectedRig()
  rig.fake.pushInbound({
    id: 'perm-1',
    kind: 'permission',
    payload: { requestId: 'perm-1' },
  })
  await vi.waitFor(() => expect(rig.inbound).toHaveLength(1))
  expect(rig.inbound[0]).toEqual({
    id: 'perm-1',
    kind: 'permission',
    payload: { requestId: 'perm-1' },
  })
  await rig.transport.respondInbound({
    id: 'perm-1',
    result: { outcome: 'selected', optionId: 'allow' },
  })
  expect(rig.fake.inboundResponses).toEqual([
    { id: 'perm-1', result: { outcome: 'selected', optionId: 'allow' } },
  ])
  await rig.transport.close()
})

test('respondInbound rejection crosses the wire with its error code', async () => {
  const rig = await connectedRig()
  rig.fake.respondInboundImpl.fn = async () => {
    const error = new Error('permission already answered') as Error & {
      code: string
      retryable: boolean
    }
    error.code = 'acpjs/already-answered'
    error.retryable = false
    throw error
  }
  await expect(
    rig.transport.respondInbound({ id: 'perm-1', result: {} }),
  ).rejects.toMatchObject({
    code: 'acpjs/already-answered',
    message: 'permission already answered',
  })
  await rig.transport.close()
})

test('close reports lifecycle closed, settles in-flight work, and is idempotent', async () => {
  const channel = new MessageChannel()
  const fake = fakeEndpoint()
  let resolveRequest: (() => void) | undefined
  fake.endpoint.request = async (request) => {
    await new Promise<void>((resolvePromise) => {
      resolveRequest = resolvePromise
    })
    return { id: request.id, ok: true, result: null }
  }
  wireEndpointToPort(fake.endpoint, asWirePort(channel.port1))
  const transport = electronTransport({
    requestPort: async () => channel.port2,
  })
  const lifecycle: TransportLifecycleEvent[] = []
  await transport.connect({
    onInboundRequest() {},
    onLifecycle: (event) => lifecycle.push(event),
  })
  const pending = transport.request({ id: 'rpc-1', method: 'm', params: {} })
  await vi.waitFor(() => expect(resolveRequest).toBeDefined())
  await transport.close()
  await transport.close()
  expect(await pending).toEqual({
    id: 'rpc-1',
    ok: false,
    error: {
      code: 'acpjs/transport-closed',
      message: 'transport is closed',
      retryable: true,
    },
  })
  expect(lifecycle).toEqual([
    { status: 'connecting' },
    { status: 'connected' },
    { status: 'closed' },
  ])
  let subscribeError: unknown
  try {
    transport.subscribe({ fromSeq: 0 }, () => {})
  } catch (error) {
    subscribeError = error
  }
  expect(subscribeError).toMatchObject({ code: 'acpjs/transport-closed' })
  await expect(
    transport.respondInbound({ id: 'x', result: null }),
  ).rejects.toMatchObject({ code: 'acpjs/transport-closed' })
  const late = await transport.request({ id: 'rpc-2', method: 'm', params: {} })
  expect(late.ok).toBe(false)
})

test('close releases all endpoint subscriptions on the main side', async () => {
  const rig = await connectedRig()
  rig.transport.subscribe({ sessionId: 's-1', fromSeq: 0 }, () => {})
  rig.transport.subscribe({ sessionId: 's-2', fromSeq: 0 }, () => {})
  await vi.waitFor(() => expect(rig.fake.subscriptions).toHaveLength(2))
  await rig.transport.close()
  await vi.waitFor(() => {
    expect(rig.fake.subscriptions.every((sub) => !sub.active)).toBe(true)
  })
})

test('renderer-initiated close reports teardown to the main side exactly once', async () => {
  const channel = new MessageChannel()
  const fake = fakeEndpoint()
  const onTeardown = vi.fn()
  const detach = wireEndpointToPort(
    fake.endpoint,
    asWirePort(channel.port1),
    onTeardown,
  )
  const transport = electronTransport({
    requestPort: async () => channel.port2,
  })
  await transport.connect(noopHandlers)
  await transport.close()
  await vi.waitFor(() => expect(onTeardown).toHaveBeenCalledTimes(1))
  detach()
  expect(onTeardown).toHaveBeenCalledTimes(1)
})

test('main-initiated detach reports teardown once', async () => {
  const channel = new MessageChannel()
  const fake = fakeEndpoint()
  const onTeardown = vi.fn()
  const detach = wireEndpointToPort(
    fake.endpoint,
    asWirePort(channel.port1),
    onTeardown,
  )
  detach()
  detach()
  expect(onTeardown).toHaveBeenCalledTimes(1)
})

test('main-initiated detach closes the renderer transport', async () => {
  const rig = await connectedRig()
  rig.detach()
  await vi.waitFor(() =>
    expect(rig.lifecycle.at(-1)).toEqual({ status: 'closed' }),
  )
  const response = await rig.transport.request({
    id: 'rpc-1',
    method: 'm',
    params: {},
  })
  expect(response.ok).toBe(false)
})
