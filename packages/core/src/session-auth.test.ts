import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import { collectEvents, fixtureDefinition, trackHost } from './test-harness.ts'

import type { FixtureScenario } from '@acpjs/fixture-agent'
import type { AcpSessionEvent } from '@acpjs/protocol'

async function activeSession(scenario: FixtureScenario) {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition(scenario)
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, { cwd: '/tmp' })
  if (created.status !== 'active') throw new Error('expected active session')
  return { host, agentId: agent.agentId, sessionId: created.sessionId }
}

test('auth-required on session/new surfaces cached authMethods then authenticate unblocks retry', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: { authMethods: [{ id: 'device', name: 'Device flow' }] },
    session: { sessionId: 'sess-auth', authRequired: true },
  })
  const agent = await host.spawnAgent(definition)

  const first = await host.createSession(agent.agentId, { cwd: '/tmp' })
  expect(first).toEqual({
    status: 'auth-required',
    authMethods: [{ id: 'device', name: 'Device flow' }],
  })

  await host.authenticate(agent.agentId, 'device')
  const second = await host.createSession(agent.agentId, { cwd: '/tmp' })
  expect(second).toEqual({ status: 'active', sessionId: 'sess-auth' })
})

test('auth-required on session/new broadcasts a host auth-required event without registering a session', async () => {
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    initialize: { authMethods: [{ id: 'device', name: 'Device flow' }] },
    session: { sessionId: 'sess-gate', authRequired: true },
  })
  const agent = await host.spawnAgent(definition)

  const first = await host.createSession(agent.agentId, { cwd: '/tmp' })

  expect(first).toEqual({
    status: 'auth-required',
    authMethods: [{ id: 'device', name: 'Device flow' }],
  })
  expect(host.getSession('sess-gate')).toBeUndefined()
  const authEvent = hostEvents.findLast(
    (event) => event.type === 'auth-required',
  )
  expect(authEvent).toMatchObject({
    type: 'auth-required',
    agentId: agent.agentId,
    payload: {
      agentId: agent.agentId,
      authMethods: [{ id: 'device', name: 'Device flow' }],
    },
  })

  await host.authenticate(agent.agentId, 'device')
  const second = await host.createSession(agent.agentId, { cwd: '/tmp' })
  expect(second).toEqual({ status: 'active', sessionId: 'sess-gate' })
  expect(host.getSession('sess-gate')?.status).toBe('active')
})

test('INV-7: credential-shaped env values never appear in events or diagnostics across the auth flow', async () => {
  const secret = 'sk-test-9f8e7d6c5b4a32100123456789abcdef'
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    initialize: { authMethods: [{ id: 'device', name: 'Device flow' }] },
    session: { sessionId: 'sess-secret', authRequired: true },
  })
  const agent = await host.spawnAgent({
    ...definition,
    env: { FIXTURE_API_TOKEN: secret },
  })

  const first = await host.createSession(agent.agentId, { cwd: '/tmp' })
  expect(first.status).toBe('auth-required')
  await host.authenticate(agent.agentId, 'device')
  const second = await host.createSession(agent.agentId, { cwd: '/tmp' })
  expect(second).toEqual({ status: 'active', sessionId: 'sess-secret' })

  const sessionEvents = collectEvents(host, 'sess-secret')
  const serialized = JSON.stringify([...hostEvents, ...sessionEvents])
  expect(serialized).not.toContain(secret)
  expect(serialized).toContain('FIXTURE_API_TOKEN')
})

test('auth-required during prompt moves session to auth-required with authMethods', async () => {
  const { host, sessionId } = await activeSession({
    initialize: { authMethods: [{ id: 'device', name: 'Device flow' }] },
    turns: [
      { steps: [{ kind: 'error', code: -32000, message: 'auth required' }] },
    ],
  })
  const events = collectEvents(host, sessionId) as AcpSessionEvent[]

  const result = await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  expect(result.error).toMatchObject({ code: -32000 })
  expect(host.getSession(sessionId)?.status).toBe('auth-required')
  const statusEvent = events.findLast(
    (event) => event.type === 'session-status-change',
  )
  expect(statusEvent?.payload).toEqual({
    status: 'auth-required',
    authMethods: [{ id: 'device', name: 'Device flow' }],
  })
})
