import { expect, test } from 'vitest'

import {
  createAcpClient,
  type AcpClient,
  type PermissionRequest,
} from './index.ts'
import {
  createFakeHub,
  rejectionOf,
  ScriptedError,
  type FakeHub,
} from './test-support.ts'

const PERMISSION = {
  requestId: 'perm-1',
  sessionId: 'sess-1',
  toolCall: { toolCallId: 'call_1', kind: 'execute' },
  options: [{ kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' }],
}

async function setup(): Promise<{ hub: FakeHub; client: AcpClient }> {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  hub.handle('sessions/create', () => ({
    status: 'active',
    sessionId: 'sess-1',
  }))
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  await agent.sessions.create({ cwd: '/tmp' })
  return { hub, client }
}

test('an inbound permission request enters the snapshot, notifies subscribers and responds over the transport', async () => {
  const { hub, client } = await setup()
  const seen: (readonly PermissionRequest[])[] = []
  client.permissions.subscribe((requests) => seen.push(requests))

  hub.pushPermission(PERMISSION)

  expect(seen).toHaveLength(1)
  expect(client.permissions.getSnapshot()).toBe(seen[0])
  expect(seen[0]?.[0]).toMatchObject({
    requestId: 'perm-1',
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'call_1', kind: 'execute' },
    options: [{ kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' }],
  })

  await seen[0]?.[0]?.respond({ outcome: 'selected', optionId: 'opt-allow' })

  expect(hub.inboundResponses).toEqual([
    { id: 'perm-1', result: { outcome: 'selected', optionId: 'opt-allow' } },
  ])
  expect(client.permissions.getSnapshot()).toEqual([])
  expect(seen).toHaveLength(2)
})

test('the snapshot reference is stable until the pending set changes', async () => {
  const { hub, client } = await setup()
  const before = client.permissions.getSnapshot()

  expect(client.permissions.getSnapshot()).toBe(before)

  hub.pushPermission(PERMISSION)

  const after = client.permissions.getSnapshot()
  expect(after).not.toBe(before)
  expect(client.permissions.getSnapshot()).toBe(after)
})

test('a second respond rejects with the acpjs/already-answered error from the host', async () => {
  const { hub, client } = await setup()
  let answered = false
  hub.onRespondInbound(() => {
    if (answered) {
      throw new ScriptedError({
        code: 'acpjs/already-answered',
        message: 'permission request perm-1 already answered',
        retryable: false,
      })
    }
    answered = true
  })
  hub.pushPermission(PERMISSION)
  const [request] = client.permissions.getSnapshot()

  await request.respond({ outcome: 'selected', optionId: 'opt-allow' })
  const error = await rejectionOf(request.respond({ outcome: 'cancelled' }))

  expect(error).toMatchObject({ code: 'acpjs/already-answered' })
})

test('an unsubscribed permission listener no longer receives change notifications', async () => {
  const { hub, client } = await setup()
  const seen: (readonly PermissionRequest[])[] = []
  const unsubscribe = client.permissions.subscribe((requests) =>
    seen.push(requests),
  )
  unsubscribe()

  hub.pushPermission(PERMISSION)

  expect(seen).toHaveLength(0)
})

test('a throwing permission listener does not prevent the remaining listeners from being notified', async () => {
  const { hub, client } = await setup()
  const seen: (readonly PermissionRequest[])[] = []
  client.permissions.subscribe(() => {
    throw new Error('boom')
  })
  client.permissions.subscribe((requests) => seen.push(requests))

  hub.pushPermission(PERMISSION)

  expect(seen).toHaveLength(1)
})

test('a late consumer reads requests that are still pending from the snapshot', async () => {
  const { hub, client } = await setup()
  hub.pushPermission(PERMISSION)

  const snapshot = client.permissions.getSnapshot()

  expect(snapshot).toHaveLength(1)
  expect(snapshot[0]?.requestId).toBe('perm-1')
})

test('inbound requests of an unknown kind are ignored by the permission surface', async () => {
  const { hub, client } = await setup()
  const seen: (readonly PermissionRequest[])[] = []
  client.permissions.subscribe((requests) => seen.push(requests))

  hub.pushInbound({ id: 'x-1', kind: 'future-kind', payload: PERMISSION })

  expect(seen).toHaveLength(0)
  expect(client.permissions.getSnapshot()).toEqual([])
})

test('a respond rejected with already-answered prunes the request from the snapshot', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  hub.onRespondInbound(() => {
    throw new ScriptedError({
      code: 'acpjs/already-answered',
      message: 'permission request perm-1 already answered',
      retryable: false,
    })
  })
  const client = createAcpClient({ transport: hub.connection().transport })
  await client.agents.spawn({ id: 'a', command: 'node' })
  hub.pushPermission(PERMISSION)
  const [request] = client.permissions.getSnapshot()

  const error = await rejectionOf(request.respond({ outcome: 'cancelled' }))

  expect(error).toMatchObject({ code: 'acpjs/already-answered' })
  expect(client.permissions.getSnapshot()).toEqual([])
})

test('dispose empties the pending snapshot', async () => {
  const { hub, client } = await setup()
  hub.pushPermission(PERMISSION)

  await client.dispose()

  expect(client.permissions.getSnapshot()).toEqual([])
})

test('a permission resolved by someone else is pruned and subscribers are notified', async () => {
  const { hub, client } = await setup()
  hub.pushPermission(PERMISSION)
  const seen: (readonly PermissionRequest[])[] = []
  client.permissions.subscribe((requests) => seen.push(requests))

  hub.emit('sess-1', 'permission-request-resolved', {
    requestId: 'perm-1',
    status: 'answered',
    outcome: { outcome: 'selected', optionId: 'opt-allow' },
  })

  expect(seen).toHaveLength(1)
  expect(seen[0]).toEqual([])
  expect(client.permissions.getSnapshot()).toEqual([])
})
