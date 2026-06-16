import { expect, test } from 'vitest'

import { createAcpHost, type StorageAdapter } from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  sessionParams,
  trackHost,
  waitFor,
} from './test-harness.ts'

import type { FixtureScenario } from '@acpjs/fixture-agent'
import type { AcpSessionEvent } from '@acpjs/protocol'

async function activeSession(scenario: FixtureScenario) {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition(scenario)
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active session')
  return { host, agentId: agent.agentId, sessionId: created.sessionId }
}

test('closeSession transitions to closed and rejects further operations with acpjs/session-closed', async () => {
  const { host, sessionId } = await activeSession({
    initialize: {
      agentCapabilities: { sessionCapabilities: { close: {} } },
    },
  })

  await host.closeSession(sessionId)

  expect(host.getSession(sessionId)?.status).toBe('closed')
  const promptError = await rejectionOf(
    host.prompt(sessionId, [{ type: 'text', text: 'go' }]),
  )
  expect(promptError).toMatchObject({ code: 'acpjs/session-closed' })
  const closeError = await rejectionOf(host.closeSession(sessionId))
  expect(closeError).toMatchObject({ code: 'acpjs/session-closed' })
})

test('closeSession during a prompt is not overwritten when the prompt later finishes', async () => {
  const { host, sessionId } = await activeSession({
    turns: [{ steps: [{ kind: 'sleep', ms: 100 }] }],
  })
  const hostEvents = collectEvents(host, undefined)

  const prompting = host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  await waitFor(() => host.getSession(sessionId)?.status === 'prompting')
  await host.closeSession(sessionId)
  const result = await prompting

  expect(result.stopReason).toBe('cancelled')
  expect(host.getSession(sessionId)?.status).toBe('closed')
  const statuses = hostEvents
    .filter(
      (event) =>
        event.type === 'session-updated' &&
        event.payload.sessionId === sessionId,
    )
    .map((event) => event.payload.status)
  expect(statuses).toEqual(['active', 'prompting', 'closed'])
})

test('deleteSession during a prompt is not overwritten when the prompt later finishes', async () => {
  const { host, agentId, sessionId } = await activeSession({
    turns: [{ steps: [{ kind: 'sleep', ms: 100 }] }],
  })
  const hostEvents = collectEvents(host, undefined)

  const prompting = host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  await waitFor(() => host.getSession(sessionId)?.status === 'prompting')
  await host.deleteSession(agentId, sessionId)
  const result = await prompting

  expect(result.stopReason).toBe('cancelled')
  expect(host.getSession(sessionId)).toBeUndefined()
  const statuses = hostEvents
    .filter(
      (event) =>
        event.type === 'session-updated' &&
        event.payload.sessionId === sessionId,
    )
    .map((event) => event.payload.status)
  expect(statuses).toEqual(['active', 'prompting', 'deleted'])
})

test('session updates during close lifecycle are diagnosed and not appended', async () => {
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta(meta) {
      if (meta.lifecycle !== 'closed') return
      return new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 150)
      })
    },
    listSessions: () => [],
    loadEvents: () => [],
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    initialize: { agentCapabilities: { loadSession: true } },
    session: { sessionId: 'sess-close-update' },
    loadSession: {
      steps: [{ kind: 'sleep', ms: 50 }],
      replay: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'late replay' },
        },
      ],
    },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))
  const sessionEvents = collectEvents(
    host,
    'sess-close-update',
  ) as AcpSessionEvent[]

  const loading = host
    .loadSession(agent.agentId, 'sess-close-update', sessionParams('/tmp'))
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  await waitFor(
    () => host.getSession('sess-close-update')?.status === 'resuming',
  )
  await host.closeSession('sess-close-update')
  expect(await loading).toMatchObject({ code: 'acpjs/session-closed' })

  expect(
    sessionEvents.some(
      (event) =>
        event.type === 'agent-message-chunk' &&
        event.payload.content.text === 'late replay',
    ),
  ).toBe(false)
  expect(
    hostEvents.some(
      (event) =>
        event.type === 'diagnostic' &&
        event.payload.code === 'session/update-during-terminal-lifecycle',
    ),
  ).toBe(true)
})
