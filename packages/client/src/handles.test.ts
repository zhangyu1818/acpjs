import { expect, test } from 'vitest'

import { createAcpClient, type AcpClient } from './index.ts'
import { createFakeHub, rejectionOf, type FakeHub } from './test-support.ts'

function setup(): { hub: FakeHub; client: AcpClient } {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({
    agentId: 'agent-1',
    status: 'ready',
    restartCount: 0,
  }))
  hub.handle('sessions/create', () => ({
    status: 'active',
    sessionId: 'sess-1',
  }))
  hub.handle('sessions/load', () => null)
  const client = createAcpClient({ transport: hub.connection().transport })
  return { hub, client }
}

test('agents.get returns the spawned agent handle by id and undefined before spawn', async () => {
  const { client } = setup()
  expect(client.agents.get('agent-1')).toBeUndefined()

  const agent = await client.agents.spawn({ id: 'a', command: 'node' })

  expect(client.agents.get('agent-1')).toBe(agent)
})

test('agents.subscribe notifies when an agent handle appears and stops after unsubscribe', async () => {
  const { client } = setup()
  let notified = 0
  const unsubscribe = client.agents.subscribe(() => {
    notified += 1
  })

  await client.agents.spawn({ id: 'a', command: 'node' })
  expect(notified).toBe(1)

  unsubscribe()
  await client.agents.spawn({ id: 'a', command: 'node' })
  expect(notified).toBe(1)
})

test('agent.getSnapshot exposes the wire snapshot returned by spawn', async () => {
  const { client } = setup()

  const agent = await client.agents.spawn({ id: 'a', command: 'node' })

  expect(agent.getSnapshot()).toEqual({
    agentId: 'agent-1',
    status: 'ready',
    restartCount: 0,
  })
  expect(agent.getSnapshot()).toBe(agent.getSnapshot())
})

test('an agent-status-change on the host sequence replaces the snapshot and notifies agent subscribers', async () => {
  const { hub, client } = setup()
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const before = agent.getSnapshot()
  let notified = 0
  agent.subscribe(() => {
    notified += 1
  })

  hub.emitHost({
    agentId: 'agent-1',
    type: 'agent-status-change',
    payload: {
      status: 'exited',
      restartCount: 0,
      reason: 'crashed',
      exit: { code: 1 },
    },
  })

  const after = agent.getSnapshot()
  expect(after).not.toBe(before)
  expect(after).toEqual({
    agentId: 'agent-1',
    status: 'exited',
    restartCount: 0,
    reason: 'crashed',
    exit: { code: 1 },
  })
  expect(notified).toBe(1)
})

test('a status change carrying no field change keeps the snapshot reference and stays silent', async () => {
  const { hub, client } = setup()
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const before = agent.getSnapshot()
  let notified = 0
  agent.subscribe(() => {
    notified += 1
  })

  hub.emitHost({
    agentId: 'agent-1',
    type: 'agent-status-change',
    payload: { status: 'ready', restartCount: 0 },
  })

  expect(agent.getSnapshot()).toBe(before)
  expect(notified).toBe(0)
})

test('a restart-driven status change updates restartCount, swaps the snapshot, and notifies subscribers', async () => {
  const { hub, client } = setup()
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const before = agent.getSnapshot()
  let notified = 0
  agent.subscribe(() => {
    notified += 1
  })

  hub.emitHost({
    agentId: 'agent-1',
    type: 'agent-status-change',
    payload: { status: 'restarting', restartCount: 1 },
  })

  const afterRestart = agent.getSnapshot()
  expect(afterRestart).not.toBe(before)
  expect(afterRestart).toEqual({
    agentId: 'agent-1',
    status: 'restarting',
    restartCount: 1,
  })
  expect(notified).toBe(1)

  hub.emitHost({
    agentId: 'agent-1',
    type: 'agent-status-change',
    payload: { status: 'ready', restartCount: 0 },
  })

  const afterReady = agent.getSnapshot()
  expect(afterReady).not.toBe(afterRestart)
  expect(afterReady).toEqual({
    agentId: 'agent-1',
    status: 'ready',
    restartCount: 0,
  })
  expect(notified).toBe(2)
})

test('an auth-required host event surfaces authRequired and authMethods on the agent snapshot', async () => {
  const { hub, client } = setup()
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const before = agent.getSnapshot()
  let notified = 0
  agent.subscribe(() => {
    notified += 1
  })

  hub.emitHost({
    agentId: 'agent-1',
    type: 'auth-required',
    payload: {
      agentId: 'agent-1',
      authMethods: [{ id: 'device', name: 'Device flow' }],
    },
  })

  const after = agent.getSnapshot()
  expect(after).not.toBe(before)
  expect(after).toMatchObject({
    agentId: 'agent-1',
    status: 'ready',
    authRequired: true,
    authMethods: [{ id: 'device', name: 'Device flow' }],
  })
  expect(notified).toBe(1)

  hub.emitHost({
    agentId: 'agent-1',
    type: 'auth-required',
    payload: {
      agentId: 'agent-1',
      authMethods: [{ id: 'device', name: 'Device flow' }],
    },
  })
  expect(agent.getSnapshot()).toBe(after)
  expect(notified).toBe(1)
})

test('agents.getSnapshot enumerates handles and swaps the array reference on spawn and on status change', async () => {
  const { hub, client } = setup()
  const empty = client.agents.getSnapshot()
  expect(empty).toEqual([])
  expect(client.agents.getSnapshot()).toBe(empty)

  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const afterSpawn = client.agents.getSnapshot()
  expect(afterSpawn).not.toBe(empty)
  expect(afterSpawn).toEqual([agent])
  expect(client.agents.getSnapshot()).toBe(afterSpawn)

  hub.emitHost({
    agentId: 'agent-1',
    type: 'agent-status-change',
    payload: { status: 'exited', restartCount: 0, reason: 'crashed' },
  })

  const afterChange = client.agents.getSnapshot()
  expect(afterChange).not.toBe(afterSpawn)
  expect(afterChange).toEqual([agent])
})

test('agents.attach hydrates a host-side agent into a local handle and notifies the registry', async () => {
  const { hub, client } = setup()
  hub.handle('agents/list', () => [
    { agentId: 'agent-x', status: 'ready', restartCount: 2 },
  ])
  let notified = 0
  client.agents.subscribe(() => {
    notified += 1
  })

  const attached = await client.agents.attach('agent-x')

  expect(attached.agentId).toBe('agent-x')
  expect(attached.getSnapshot()).toEqual({
    agentId: 'agent-x',
    status: 'ready',
    restartCount: 2,
  })
  expect(client.agents.get('agent-x')).toBe(attached)
  expect(client.agents.getSnapshot()).toEqual([attached])
  expect(notified).toBe(1)
})

test('agents.attach returns the already-held handle for a locally spawned agent', async () => {
  const { hub, client } = setup()
  hub.handle('agents/list', () => [
    { agentId: 'agent-1', status: 'ready', restartCount: 0 },
  ])
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })

  const attached = await client.agents.attach('agent-1')

  expect(attached).toBe(agent)
  expect(client.agents.getSnapshot()).toEqual([agent])
})

test('agents.attach rejects with acpjs/agent-exited when the host does not know the id', async () => {
  const { hub, client } = setup()
  hub.handle('agents/list', () => [])

  const error = await rejectionOf(client.agents.attach('agent-ghost'))

  expect(error).toMatchObject({ code: 'acpjs/agent-exited' })
  expect(client.agents.get('agent-ghost')).toBeUndefined()
})

test('sessions.get returns the same frozen handle that create produced', async () => {
  const { client } = setup()
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  expect(client.sessions.get('sess-1')).toBeUndefined()

  const session = await agent.sessions.create({ cwd: '/tmp' })

  expect(client.sessions.get('sess-1')).toBe(session)
})

test('create and load for the same sessionId share one handle reference', async () => {
  const { client } = setup()
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const created = await agent.sessions.create({ cwd: '/tmp' })

  const loaded = await agent.sessions.load('sess-1', { cwd: '/tmp' })

  expect(loaded).toBe(created)
})

test('sessions.getSnapshot enumerates local handles and swaps the array reference only when one appears', async () => {
  const { client } = setup()
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const empty = client.sessions.getSnapshot()
  expect(empty).toEqual([])
  expect(client.sessions.getSnapshot()).toBe(empty)

  const session = await agent.sessions.create({ cwd: '/tmp' })

  const afterCreate = client.sessions.getSnapshot()
  expect(afterCreate).not.toBe(empty)
  expect(afterCreate).toEqual([session])
  expect(client.sessions.getSnapshot()).toBe(afterCreate)

  await agent.sessions.create({ cwd: '/tmp' })
  expect(client.sessions.getSnapshot()).toBe(afterCreate)
})

test('sessions.attach rebuilds an existing host session by replay without issuing a resume RPC', async () => {
  const { hub, client } = setup()
  hub.handle('sessions/getAll', () => [
    { sessionId: 'sess-remote', status: 'active', agentId: 'agent-9' },
  ])
  hub.emit('sess-remote', 'agent-message-chunk', {
    content: { type: 'text', text: 'already there' },
  })
  let notified = 0
  client.sessions.subscribe(() => {
    notified += 1
  })

  const attached = await client.sessions.attach('sess-remote')

  expect(attached.sessionId).toBe('sess-remote')
  expect(attached.getSnapshot().messages).toEqual([
    {
      kind: 'agent',
      messageId: null,
      content: [{ type: 'text', text: 'already there' }],
      seq: 1,
    },
  ])
  expect(client.sessions.get('sess-remote')).toBe(attached)
  expect(client.sessions.getSnapshot()).toEqual([attached])
  expect(notified).toBe(1)
  expect(hub.requests.map((request) => request.method)).toEqual([
    'sessions/getAll',
  ])
})

test('sessions.attach rejects with acpjs/session-closed when the host does not know the id', async () => {
  const { hub, client } = setup()
  hub.handle('sessions/getAll', () => [])

  const error = await rejectionOf(client.sessions.attach('sess-ghost'))

  expect(error).toMatchObject({ code: 'acpjs/session-closed' })
  expect(client.sessions.get('sess-ghost')).toBeUndefined()
})

test('session-created and session-closed announcements notify session subscribers without adding local handles', async () => {
  const { hub, client } = setup()
  await client.agents.spawn({ id: 'a', command: 'node' })
  const before = client.sessions.getSnapshot()
  let notified = 0
  client.sessions.subscribe(() => {
    notified += 1
  })

  hub.emitHost({
    type: 'session-created',
    payload: { sessionId: 'sess-elsewhere', status: 'active' },
  })
  expect(notified).toBe(1)

  hub.emitHost({
    type: 'session-closed',
    payload: { sessionId: 'sess-elsewhere', status: 'closed' },
  })
  expect(notified).toBe(2)

  expect(client.sessions.get('sess-elsewhere')).toBeUndefined()
  expect(client.sessions.getSnapshot()).toBe(before)
})

test('sessions.subscribe notifies when a session handle appears and stops after unsubscribe', async () => {
  const { client } = setup()
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  let notified = 0
  const unsubscribe = client.sessions.subscribe(() => {
    notified += 1
  })

  await agent.sessions.create({ cwd: '/tmp' })
  expect(notified).toBe(1)

  await agent.sessions.create({ cwd: '/tmp' })
  expect(notified).toBe(1)

  unsubscribe()
  await agent.sessions.load('sess-2', { cwd: '/tmp' })
  expect(notified).toBe(1)
})
