import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import {
  collectEvents,
  diagnosticPayloads,
  fixtureDefinition,
  sessionParams,
  trackHost,
} from './test-harness.ts'

test('disposeAgent removes the agent from the runtime registry', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({})
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))

  await host.disposeAgent(agent.agentId)

  expect(host.getAgent(agent.agentId)).toBeUndefined()
  expect(host.getAgents()).toHaveLength(0)
})

test('disposeAgent emits a final agent-updated exited then an agent-removed event', async () => {
  const host = trackHost(createAcpHost())
  const events = collectEvents(host, undefined, 0)
  const { definition } = await fixtureDefinition({})
  const agent = await host.spawnAgent(definition)

  await host.disposeAgent(agent.agentId)

  const exitedIndex = events.findIndex(
    (event) =>
      event.type === 'agent-updated' &&
      event.payload.agentId === agent.agentId &&
      event.payload.status === 'exited',
  )
  const removedIndex = events.findIndex(
    (event) =>
      event.type === 'agent-removed' && event.payload.agentId === agent.agentId,
  )
  expect(exitedIndex).toBeGreaterThanOrEqual(0)
  expect(removedIndex).toBeGreaterThan(exitedIndex)
})

test('disposeAgent transitions the agent session to disconnected, preserving history', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-dispose' },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')

  await host.disposeAgent(agent.agentId)

  expect(host.getSession(created.sessionId)?.status).toBe('disconnected')
})

test('disposeAgent is idempotent: unknown and repeated ids are no-ops', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({})
  const agent = await host.spawnAgent(definition)

  const events = collectEvents(host, undefined, 0)

  await expect(host.disposeAgent('does-not-exist')).resolves.toBeUndefined()
  expect(events.filter((event) => event.type === 'agent-removed')).toHaveLength(
    0,
  )

  await host.disposeAgent(agent.agentId)
  await host.disposeAgent(agent.agentId)

  expect(events.filter((event) => event.type === 'agent-removed')).toHaveLength(
    1,
  )
})

test('disposeAgent is idempotent under concurrent calls', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({})
  const agent = await host.spawnAgent(definition)

  const events = collectEvents(host, undefined, 0)

  await Promise.all([
    host.disposeAgent(agent.agentId),
    host.disposeAgent(agent.agentId),
  ])

  expect(events.filter((event) => event.type === 'agent-removed')).toHaveLength(
    1,
  )
  expect(diagnosticPayloads(events, 'agent/exit')).toHaveLength(1)
  expect(host.getAgent(agent.agentId)).toBeUndefined()
})
