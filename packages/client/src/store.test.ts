import { expect, test } from 'vitest'

import { createAcpClient } from './index.ts'
import { createFakeHub, sessionParams, type FakeHub } from './test-support.ts'

import type { SessionState } from '@acpjs/protocol'

function hubWithSession(sessionId = 'sess-1'): FakeHub {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  hub.handle('sessions/create', () => {
    hub.emit(sessionId, 'session-status-change', { status: 'active' })
    return {
      status: 'active',
      sessionId,
      agentId: 'agent-1',
      cwd: '/tmp',
      additionalDirectories: [],
    }
  })
  return hub
}

test('sessions.create subscribes the session event stream and reduces it into SessionState', async () => {
  const hub = hubWithSession()
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })

  const session = await agent.sessions.create(sessionParams('/tmp'))

  expect(session.sessionId).toBe('sess-1')
  expect(hub.requests.at(-1)).toMatchObject({
    method: 'sessions/create',
    params: { agentId: 'agent-1', cwd: '/tmp' },
  })
  expect(hub.subscriptions).toEqual([
    { fromSeq: 0 },
    { sessionId: 'sess-1', fromSeq: 0 },
  ])

  const seen: SessionState[] = []
  session.subscribe((state) => seen.push(state))
  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'Hel' },
    messageId: 'm1',
  })
  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'lo' },
    messageId: 'm1',
  })

  expect(seen).toHaveLength(2)
  expect(session.getSnapshot().messages).toEqual([
    {
      kind: 'agent',
      messageId: 'm1',
      content: [{ type: 'text', text: 'Hello' }],
      seq: 2,
    },
  ])
})

test('getSnapshot returns a cached immutable reference until a new event arrives', async () => {
  const hub = hubWithSession()
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const session = await agent.sessions.create(sessionParams('/tmp'))

  const first = session.getSnapshot()
  expect(session.getSnapshot()).toBe(first)

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'hi' },
  })

  const second = session.getSnapshot()
  expect(second).not.toBe(first)
  expect(session.getSnapshot()).toBe(second)
})

test('replayed duplicates (seq already applied) are ignored without producing a new snapshot', async () => {
  const hub = hubWithSession()
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const session = await agent.sessions.create(sessionParams('/tmp'))

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'once' },
  })
  const snapshot = session.getSnapshot()

  hub.emitRaw({
    sessionId: 'sess-1',
    seq: 1,
    ts: 0,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'once' } },
  })

  expect(session.getSnapshot()).toBe(snapshot)
  expect(session.getSnapshot().messages[0]?.content).toEqual([
    { type: 'text', text: 'once' },
  ])
})

test('an unsubscribed state listener stops receiving while remaining listeners still do', async () => {
  const hub = hubWithSession()
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const session = await agent.sessions.create(sessionParams('/tmp'))

  const first: SessionState[] = []
  const second: SessionState[] = []
  const unsubscribe = session.subscribe((state) => first.push(state))
  session.subscribe((state) => second.push(state))

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'one' },
  })
  unsubscribe()
  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'two' },
  })

  expect(first).toHaveLength(1)
  expect(second).toHaveLength(2)
})

test('a throwing state listener does not prevent the remaining listeners from being notified', async () => {
  const hub = hubWithSession()
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const session = await agent.sessions.create(sessionParams('/tmp'))

  const seen: SessionState[] = []
  session.subscribe(() => {
    throw new Error('boom')
  })
  session.subscribe((state) => seen.push(state))

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'hi' },
  })

  expect(seen).toHaveLength(1)
})

test('a late subscriber catches up via fromSeq replay to a deeply equal state (INV-2)', async () => {
  const hub = hubWithSession()
  hub.handle('sessions/load', () => null)
  const clientA = createAcpClient({ transport: hub.connection().transport })
  const agentA = await clientA.agents.spawn({ id: 'a', command: 'node' })
  const sessionA = await agentA.sessions.create(sessionParams('/tmp'))

  hub.emit('sess-1', 'session-config-init', {
    modes: {
      currentModeId: 'code',
      availableModes: [{ id: 'code', name: 'Code' }],
    },
  })
  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'Hel' },
    messageId: 'm1',
  })
  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'lo' },
    messageId: 'm1',
  })

  const clientB = createAcpClient({ transport: hub.connection().transport })
  const agentB = await clientB.agents.spawn({ id: 'a', command: 'node' })
  const sessionB = await agentB.sessions.load('sess-1', sessionParams('/tmp'))

  expect(hub.requests.at(-1)).toMatchObject({
    method: 'sessions/load',
    params: { agentId: 'agent-1', sessionId: 'sess-1', cwd: '/tmp' },
  })
  expect(sessionB.getSnapshot()).toEqual(sessionA.getSnapshot())

  hub.emit('sess-1', 'session-status-change', { status: 'active' })
  expect(sessionB.getSnapshot()).toEqual(sessionA.getSnapshot())
  expect(sessionB.getSnapshot().connection.status).toBe('active')
})
