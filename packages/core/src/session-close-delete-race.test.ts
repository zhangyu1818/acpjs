import { expect, test } from 'vitest'

import { createAcpHost, type StorageAdapter } from './index.ts'
import {
  collectEvents,
  diagnosticPayloads,
  fixtureDefinition,
  rejectionOf,
  sessionParams,
  trackHost,
  waitFor,
} from './test-harness.ts'

import type { FixtureScenario } from '@acpjs/fixture-agent'
import type { AcpjsSessionEvent } from '@acpjs/protocol'

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

test('remote close failure is diagnosed after local close succeeds', async () => {
  const { host, sessionId } = await activeSession({
    initialize: {
      agentCapabilities: { sessionCapabilities: { close: {} } },
    },
    closeSession: {
      error: { code: -32603, message: 'remote close boom' },
    },
  })
  const hostEvents = collectEvents(host, undefined)

  await host.closeSession(sessionId)

  expect(host.getSession(sessionId)?.status).toBe('closed')
  await waitFor(
    () => diagnosticPayloads(hostEvents, 'session/close-failed').length !== 0,
  )
  expect(
    diagnosticPayloads(hostEvents, 'session/close-failed')[0],
  ).toMatchObject({
    level: 'warn',
    sessionId,
    message: 'remote close boom',
  })
})

test('remote delete failure is diagnosed after local delete succeeds', async () => {
  const { host, agentId, sessionId } = await activeSession({
    initialize: {
      agentCapabilities: { sessionCapabilities: { delete: {} } },
    },
    deleteSession: {
      error: { code: -32603, message: 'remote delete boom' },
    },
  })
  const hostEvents = collectEvents(host, undefined)

  await host.deleteSession(agentId, sessionId)

  expect(host.getSession(sessionId)).toBeUndefined()
  await waitFor(
    () => diagnosticPayloads(hostEvents, 'session/delete-failed').length !== 0,
  )
  expect(
    diagnosticPayloads(hostEvents, 'session/delete-failed')[0],
  ).toMatchObject({
    level: 'warn',
    sessionId,
    message: 'remote delete boom',
  })
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
  ) as AcpjsSessionEvent[]

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

test('failed close during a prompt preserves the in-flight prompt guard', async () => {
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta(meta) {
      if (meta.lifecycle === 'closed') throw new Error('close tombstone failed')
    },
    listSessions: () => [],
    loadEvents: () => [],
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const { definition } = await fixtureDefinition({
    turns: [{ steps: [{ kind: 'sleep', ms: 100 }] }],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')

  const prompting = host.prompt(created.sessionId, [
    { type: 'text', text: 'go' },
  ])
  await waitFor(
    () => host.getSession(created.sessionId)?.status === 'prompting',
  )
  const closeError = await rejectionOf(host.closeSession(created.sessionId))
  const secondPromptError = await rejectionOf(
    host.prompt(created.sessionId, [{ type: 'text', text: 'two' }]),
  )
  const firstResult = await prompting

  expect(closeError).toMatchObject({ message: 'close tombstone failed' })
  expect(secondPromptError).toMatchObject({ code: 'acpjs/prompt-in-flight' })
  expect(firstResult.stopReason).toBe('cancelled')
  expect(host.getSession(created.sessionId)?.status).toBe('active')
})

test('failed delete during a prompt preserves the in-flight prompt guard', async () => {
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta(meta) {
      if (meta.lifecycle === 'deleted') {
        throw new Error('delete tombstone failed')
      }
    },
    listSessions: () => [],
    loadEvents: () => [],
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const { definition } = await fixtureDefinition({
    turns: [{ steps: [{ kind: 'sleep', ms: 100 }] }],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')

  const prompting = host.prompt(created.sessionId, [
    { type: 'text', text: 'go' },
  ])
  await waitFor(
    () => host.getSession(created.sessionId)?.status === 'prompting',
  )
  const deleteError = await rejectionOf(
    host.deleteSession(agent.agentId, created.sessionId),
  )
  const secondPromptError = await rejectionOf(
    host.prompt(created.sessionId, [{ type: 'text', text: 'two' }]),
  )
  const firstResult = await prompting

  expect(deleteError).toMatchObject({ message: 'delete tombstone failed' })
  expect(secondPromptError).toMatchObject({ code: 'acpjs/prompt-in-flight' })
  expect(firstResult.stopReason).toBe('cancelled')
  expect(host.getSession(created.sessionId)?.status).toBe('active')
})
