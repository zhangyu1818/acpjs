import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  resumeParams,
  sessionParams,
  trackHost,
  waitFor,
} from './test-harness.ts'

test('load rejects reverse permission side effects before commit and keeps the session active', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: { agentCapabilities: { loadSession: true } },
    session: { sessionId: 'sess-load-sidefx' },
    loadSession: {
      steps: [
        {
          kind: 'permission',
          toolCall: { toolCallId: 'call_load', kind: 'execute' },
          options: [
            { kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' },
          ],
        },
      ],
    },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const sessionEvents = collectEvents(host, created.sessionId)
  const hostEvents = collectEvents(host, undefined)

  const error = await rejectionOf(
    host.loadSession(agent.agentId, created.sessionId, sessionParams('/tmp')),
  )

  expect(error).toMatchObject({
    message: expect.stringContaining('lifecycle operation in progress'),
  })
  expect(host.getSession(created.sessionId)?.status).toBe('active')
  expect(
    sessionEvents.some((event) => event.type === 'permission-request-created'),
  ).toBe(false)
  expect(hostEvents.some((event) => event.type === 'permission-updated')).toBe(
    false,
  )
})

test('unknown load staging is not visible until the agent commits successfully', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: { agentCapabilities: { loadSession: true } },
    loadSession: {
      steps: [{ kind: 'sleep', ms: 200 }],
      replay: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'loaded' },
        },
      ],
    },
  })
  const agent = await host.spawnAgent(definition)

  const loading = host.loadSession(
    agent.agentId,
    'sess-staged-load',
    sessionParams('/tmp'),
  )
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))

  expect(host.getSession('sess-staged-load')).toBeUndefined()
  expect(host.getSessions()).toEqual([])
  await loading
  expect(host.getSession('sess-staged-load')?.status).toBe('active')
})

test('failed unknown resume staging never becomes attachable host state', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    },
    resumeSession: { error: { code: -32603, message: 'resume failed' } },
  })
  const agent = await host.spawnAgent(definition)

  const error = await rejectionOf(
    host.resumeSession(
      agent.agentId,
      'sess-staged-resume',
      resumeParams('/tmp'),
    ),
  )

  expect(error).toMatchObject({ code: -32603, message: 'resume failed' })
  expect(host.getSession('sess-staged-resume')).toBeUndefined()
  expect(host.getSessions()).toEqual([])
})

test('load in progress blocks prompts and restores active on failure', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: { agentCapabilities: { loadSession: true } },
    session: { sessionId: 'sess-load-lock' },
    loadSession: {
      steps: [{ kind: 'sleep', ms: 200 }],
      replay: [],
    },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))

  const loading = host.loadSession(
    agent.agentId,
    'sess-load-lock',
    sessionParams('/tmp'),
  )
  await waitFor(() => host.getSession('sess-load-lock')?.status === 'resuming')
  const promptError = await rejectionOf(
    host.prompt('sess-load-lock', [{ type: 'text', text: 'go' }]),
  )

  expect(promptError).toMatchObject({ code: 'acpjs/config-invalid' })
  await loading
  expect(host.getSession('sess-load-lock')?.status).toBe('active')
})

test('close during load wins and the late load result cannot reactivate the session', async () => {
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    initialize: { agentCapabilities: { loadSession: true } },
    session: { sessionId: 'sess-close-load' },
    loadSession: {
      steps: [{ kind: 'sleep', ms: 200 }],
      replay: [],
    },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))

  const loading = host.loadSession(
    agent.agentId,
    'sess-close-load',
    sessionParams('/tmp'),
  )
  await waitFor(() => host.getSession('sess-close-load')?.status === 'resuming')
  await host.closeSession('sess-close-load')
  const loadError = await rejectionOf(loading)

  expect(loadError).toMatchObject({ code: 'acpjs/session-closed' })
  expect(host.getSession('sess-close-load')?.status).toBe('closed')
  const statuses = hostEvents
    .filter(
      (event) =>
        event.type === 'session-updated' &&
        event.payload.sessionId === 'sess-close-load',
    )
    .map((event) => event.payload.status)
  expect(statuses).toEqual(['active', 'resuming', 'closed'])
})

test('delete during unknown load staging wins and prevents the late load commit', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: { agentCapabilities: { loadSession: true } },
    loadSession: {
      steps: [{ kind: 'sleep', ms: 200 }],
      replay: [],
    },
  })
  const agent = await host.spawnAgent(definition)

  const loading = host.loadSession(
    agent.agentId,
    'sess-delete-staged-load',
    sessionParams('/tmp'),
  )
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  await host.deleteSession(agent.agentId, 'sess-delete-staged-load')
  const loadError = await rejectionOf(loading)

  expect(loadError).toMatchObject({ code: 'acpjs/session-closed' })
  expect(host.getSession('sess-delete-staged-load')).toBeUndefined()
})

test('deleted tombstone blocks future load and resume for the same session id', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
      },
    },
  })
  const agent = await host.spawnAgent(definition)
  await host.deleteSession(agent.agentId, 'sess-deleted-before-load')

  const loadError = await rejectionOf(
    host.loadSession(
      agent.agentId,
      'sess-deleted-before-load',
      sessionParams('/tmp'),
    ),
  )
  const resumeError = await rejectionOf(
    host.resumeSession(
      agent.agentId,
      'sess-deleted-before-load',
      resumeParams('/tmp'),
    ),
  )

  expect(loadError).toMatchObject({ code: 'acpjs/session-closed' })
  expect(resumeError).toMatchObject({ code: 'acpjs/session-closed' })
  expect(host.getSession('sess-deleted-before-load')).toBeUndefined()
})
