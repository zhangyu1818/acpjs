import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  sessionParams,
  trackHost,
} from './test-harness.ts'

import type { AcpjsSessionEvent } from '@acpjs/protocol'

test('loadSession reopens a closed session, replays history, and resumes prompting', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {} },
      },
    },
    session: { sessionId: 'sess-reopen' },
    loadSession: {
      replay: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'restored' },
          messageId: 'm-history',
        },
      ],
    },
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'after-reopen' },
              messageId: 'm-after',
            },
          },
        ],
        stopReason: 'end_turn',
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const sessionId = created.sessionId

  await host.closeSession(sessionId)
  expect(host.getSession(sessionId)?.status).toBe('closed')

  await host.loadSession(agent.agentId, sessionId, sessionParams('/tmp'))
  expect(host.getSession(sessionId)?.status).toBe('active')

  const events = collectEvents(host, sessionId) as AcpjsSessionEvent[]
  const replayed = events.find(
    (event) =>
      event.type === 'agent-message-chunk' &&
      JSON.stringify(event.payload).includes('restored'),
  )
  expect(replayed).toBeDefined()

  const result = await host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  expect(result.stopReason).toBe('end_turn')
  expect(host.getSession(sessionId)?.status).toBe('active')
})

test('loadSession still rejects a deleted session', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { delete: {} },
      },
    },
    session: { sessionId: 'sess-deleted' },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const sessionId = created.sessionId

  await host.deleteSession(agent.agentId, sessionId)

  const error = await rejectionOf(
    host.loadSession(agent.agentId, sessionId, sessionParams('/tmp')),
  )
  expect(error).toMatchObject({ code: 'acpjs/session-closed' })
  expect(host.getSession(sessionId)).toBeUndefined()
})

test('a closed session keeps rejecting prompt even though load can reopen it', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {} },
      },
    },
    session: { sessionId: 'sess-closed-prompt' },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const sessionId = created.sessionId

  await host.closeSession(sessionId)

  const error = await rejectionOf(
    host.prompt(sessionId, [{ type: 'text', text: 'go' }]),
  )
  expect(error).toMatchObject({ code: 'acpjs/session-closed' })
})

test('loadSession adopts a disconnected session from a new process of the same agent definition', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: {
        loadSession: true,
      },
    },
    session: { sessionId: 'sess-disconnected-adopt' },
    loadSession: {
      replay: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'loaded' },
          messageId: 'm-loaded',
        },
      ],
    },
    turns: [{ stopReason: 'end_turn' }],
  })
  const first = await host.spawnAgent(definition)
  const created = await host.createSession(first.agentId, sessionParams('/tmp'))
  const sessionId = created.sessionId

  await host.disposeAgent(first.agentId)
  expect(host.getSession(sessionId)?.status).toBe('disconnected')

  const second = await host.spawnAgent(definition)
  expect(second.agentId).not.toBe(first.agentId)

  await host.loadSession(second.agentId, sessionId, sessionParams('/tmp'))

  expect(host.getSession(sessionId)).toMatchObject({
    agentId: second.agentId,
    status: 'active',
  })
  await expect(
    host.prompt(sessionId, [{ type: 'text', text: 'go' }]),
  ).resolves.toMatchObject({ stopReason: 'end_turn' })
})
