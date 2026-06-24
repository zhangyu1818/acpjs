import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  sessionParams,
  trackHost,
} from './test-harness.ts'

import type { FixtureScenario } from '@acpjs/fixture-agent'

async function activeSession(scenario: FixtureScenario) {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition(scenario)
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active session')
  return { host, agentId: agent.agentId, sessionId: created.sessionId }
}

test('createSession publishes a session-updated projection with sessionId, agentId, cwd and active status', async () => {
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-announce' },
  })
  const agent = await host.spawnAgent(definition)

  await host.createSession(agent.agentId, sessionParams('/tmp'))

  const projection = hostEvents.find(
    (event) =>
      event.type === 'session-updated' &&
      event.payload.sessionId === 'sess-announce',
  )
  expect(projection?.payload).toMatchObject({
    sessionId: 'sess-announce',
    agentId: agent.agentId,
    cwd: '/tmp',
    status: 'active',
  })
})

test('closeSession publishes a closed session-updated projection', async () => {
  const { host, agentId, sessionId } = await activeSession({
    initialize: {
      agentCapabilities: { sessionCapabilities: { close: {} } },
    },
  })
  const hostEvents = collectEvents(host, undefined)

  await host.closeSession(sessionId)

  const projection = hostEvents.find(
    (event) =>
      event.type === 'session-updated' &&
      event.payload.sessionId === sessionId &&
      event.payload.status === 'closed',
  )
  expect(projection?.payload).toMatchObject({
    sessionId,
    agentId,
    status: 'closed',
  })
})

test('deleteSession publishes a deleted session-updated projection', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: { sessionCapabilities: { delete: {} } },
    },
    session: { sessionId: 'sess-delete' },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const hostEvents = collectEvents(host, undefined)

  await host.deleteSession(agent.agentId, 'sess-delete')

  const projection = hostEvents.find(
    (event) =>
      event.type === 'session-updated' &&
      event.payload.sessionId === 'sess-delete' &&
      event.payload.status === 'deleted',
  )
  expect(projection?.payload).toMatchObject({
    sessionId: 'sess-delete',
    agentId: agent.agentId,
    status: 'deleted',
  })
})
