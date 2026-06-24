import { expect, test } from 'vitest'

import { AcpClientError, createAcpClient } from './index.ts'
import {
  createFakeHub,
  errorObject,
  rejectionOf,
  ScriptedError,
} from './test-support.ts'

test('a host error response rejects with a typed ErrorObject carrying code and data', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => {
    throw new ScriptedError({
      code: 'acpjs/capability-unsupported',
      message: 'agent does not support session/list',
      data: { capability: 'session/list' },
      retryable: false,
    })
  })
  const client = createAcpClient({ transport: hub.connection().transport })

  const error = await rejectionOf(
    client.agents.spawn({ id: 'a', command: 'node' }),
  )

  expect(error).toBeInstanceOf(AcpClientError)
  expect(error).toMatchObject({
    code: 'acpjs/capability-unsupported',
    message: 'agent does not support session/list',
    data: { capability: 'session/list' },
    retryable: false,
  })
})

test('connect goes connecting then connected before the first request is sent', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  const { transport, lifecycle } = hub.connection()
  const client = createAcpClient({ transport })

  await client.agents.spawn({ id: 'a', command: 'node' })

  expect(lifecycle.map((event) => event.status)).toEqual([
    'connecting',
    'connected',
  ])
})

test('a transport that fails to connect rejects facade calls with the lifecycle error', async () => {
  const hub = createFakeHub()
  const failure = errorObject(
    'acpjs/transport-closed',
    'handshake failed',
    true,
  )
  const { transport } = hub.connection({ failConnect: failure })
  const client = createAcpClient({ transport })

  const error = await rejectionOf(
    client.agents.spawn({ id: 'a', command: 'node' }),
  )

  expect(error).toBeInstanceOf(AcpClientError)
  expect(error).toMatchObject({
    code: 'acpjs/transport-closed',
    message: 'handshake failed',
    retryable: true,
  })
})

test('status reports connecting until the transport connects, observable through subscribe', async () => {
  const hub = createFakeHub()
  const { transport } = hub.connection()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise
  })
  const gated = {
    ...transport,
    async connect(handlers: Parameters<typeof transport.connect>[0]) {
      await gate
      await transport.connect(handlers)
    },
  }
  const client = createAcpClient({ transport: gated })
  const initial = client.status.getSnapshot()
  expect(initial).toEqual({ status: 'connecting' })
  expect(client.status.getSnapshot()).toBe(initial)
  const seen: string[] = []
  client.status.subscribe(() => {
    seen.push(client.status.getSnapshot().status)
  })

  release?.()
  await Promise.resolve()
  await Promise.resolve()

  expect(client.status.getSnapshot()).toEqual({ status: 'connected' })
  expect(seen).toEqual(['connected'])
})

test('dispose closes the transport and later calls reject with acpjs/transport-closed', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  const { transport, lifecycle } = hub.connection()
  const client = createAcpClient({ transport })
  await client.agents.spawn({ id: 'a', command: 'node' })

  await client.dispose()

  expect(lifecycle.at(-1)).toEqual({ status: 'closed' })
  const error = await rejectionOf(
    client.agents.spawn({ id: 'a', command: 'node' }),
  )
  expect(error).toMatchObject({ code: 'acpjs/transport-closed' })
  expect(hub.requests).toHaveLength(1)
})

test('a transport whose request rejects out of contract still surfaces an AcpClientError', async () => {
  const hub = createFakeHub()
  const { transport } = hub.connection()
  const broken = {
    ...transport,
    async request() {
      throw new Error('wire exploded')
    },
  }
  const client = createAcpClient({ transport: broken })

  const error = await rejectionOf(
    client.agents.spawn({ id: 'a', command: 'node' }),
  )

  expect(error).toBeInstanceOf(AcpClientError)
  expect(error).toMatchObject({
    code: 'acpjs/agent-error',
    message: 'wire exploded',
  })
})

test('a lifecycle close clears pending permissions, keeps their subscribers and notifies status listeners', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  const { transport } = hub.connection()
  const client = createAcpClient({ transport })
  await client.agents.spawn({ id: 'a', command: 'node' })
  hub.pushPermission({
    requestId: 'perm-1',
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'call_1' },
    options: [],
  })
  expect(client.permissions.getSnapshot()).toHaveLength(1)
  const permissionNotifications: number[] = []
  client.permissions.subscribe((requests) => {
    permissionNotifications.push(requests.length)
  })
  let statusNotified = 0
  client.status.subscribe(() => {
    statusNotified += 1
  })

  await transport.close()

  expect(client.status.getSnapshot()).toEqual({ status: 'closed' })
  expect(statusNotified).toBe(1)
  expect(client.permissions.getSnapshot()).toEqual([])
  expect(permissionNotifications).toEqual([0])
})

test('a transport that fails to connect reports a closed status carrying the lifecycle error', async () => {
  const hub = createFakeHub()
  const failure = errorObject(
    'acpjs/transport-closed',
    'handshake failed',
    true,
  )
  const { transport } = hub.connection({ failConnect: failure })

  const client = createAcpClient({ transport })
  await Promise.resolve()

  expect(client.status.getSnapshot()).toEqual({
    status: 'closed',
    error: failure,
  })
})

test('dispose is idempotent: a second call has no further effect', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  const { transport, lifecycle } = hub.connection()
  const client = createAcpClient({ transport })
  await client.agents.spawn({ id: 'a', command: 'node' })

  await client.dispose()
  await client.dispose()

  expect(lifecycle.filter((event) => event.status === 'closed')).toHaveLength(1)
})
