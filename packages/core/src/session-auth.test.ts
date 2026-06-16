import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  sessionParams,
  trackHost,
} from './test-harness.ts'

import type { AcpSessionEvent } from '@acpjs/protocol'

test('agent auth error from session/new is propagated without registering a session', async () => {
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    initialize: { authMethods: [{ id: 'device', name: 'Device flow' }] },
    session: { sessionId: 'sess-auth', authRequired: true },
  })
  const agent = await host.spawnAgent(definition)

  const error = await rejectionOf(
    host.createSession(agent.agentId, sessionParams('/tmp')),
  )

  expect(error).toMatchObject({
    code: -32000,
    message: 'Authentication required',
  })
  expect(host.getSession('sess-auth')).toBeUndefined()
  expect(hostEvents.some((event) => event.type === 'session-updated')).toBe(
    false,
  )
})

test('agent auth error during prompt is recorded as a prompt error and returns active', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: { authMethods: [{ id: 'device', name: 'Device flow' }] },
    turns: [
      { steps: [{ kind: 'error', code: -32000, message: 'auth required' }] },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  const events = collectEvents(host, created.sessionId) as AcpSessionEvent[]

  const result = await host.prompt(created.sessionId, [
    { type: 'text', text: 'go' },
  ])

  expect(result.error).toMatchObject({
    code: -32000,
    message: 'auth required',
  })
  expect(host.getSession(created.sessionId)?.status).toBe('active')
  expect(
    events
      .filter((event) => event.type === 'session-status-change')
      .map((event) => event.payload.status),
  ).toEqual(['active', 'prompting', 'active'])
})
