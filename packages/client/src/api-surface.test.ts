import { expect, test } from 'vitest'

import * as api from './index.ts'
import { createAcpClient } from './index.ts'
import { createFakeHub, sessionParams } from './test-support.ts'

test('the package export surface is sealed', () => {
  expect(Object.keys(api).sort()).toEqual([
    'AcpClientError',
    'createAcpClient',
    'createInProcessTransport',
    'createInitialSessionState',
    'reduce',
  ])
})

test('facade objects expose no raw host-envelope, raw notification or selector escape hatches', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  hub.handle('sessions/create', () => ({
    status: 'active',
    sessionId: 'sess-1',
  }))
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const session = await agent.sessions.create(sessionParams('/tmp'))

  expect(Object.keys(client).sort()).toEqual([
    'agents',
    'diagnostics',
    'dispose',
    'permissions',
    'sessions',
    'status',
  ])
  expect(Object.keys(client.sessions).sort()).toEqual([
    'attach',
    'get',
    'getSnapshot',
    'list',
    'restore',
    'subscribe',
  ])
  expect(Object.keys(client.agents).sort()).toEqual([
    'attach',
    'dispose',
    'get',
    'getSnapshot',
    'list',
    'spawn',
    'subscribe',
  ])
  expect(Object.keys(client.permissions).sort()).toEqual([
    'getSnapshot',
    'subscribe',
  ])
  expect(Object.keys(client.diagnostics).sort()).toEqual([
    'getSnapshot',
    'subscribe',
  ])
  expect(Object.keys(client.status).sort()).toEqual([
    'getSnapshot',
    'subscribe',
  ])
  expect(Object.keys(agent).sort()).toEqual([
    'agentId',
    'getSnapshot',
    'sessions',
    'subscribe',
  ])
  expect(Object.keys(agent.sessions).sort()).toEqual([
    'create',
    'delete',
    'list',
    'load',
    'resume',
  ])
  expect(Object.keys(session).sort()).toEqual([
    'cancel',
    'close',
    'getSnapshot',
    'onEvent',
    'prompt',
    'sessionId',
    'setConfigOption',
    'setMode',
    'subscribe',
  ])
  expect(session.subscribe.length).toBe(1)
  expect(Object.isFrozen(client)).toBe(true)
  expect(Object.isFrozen(agent)).toBe(true)
  expect(Object.isFrozen(session)).toBe(true)
})
