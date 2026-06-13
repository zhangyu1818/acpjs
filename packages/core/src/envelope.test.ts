import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from 'vitest'

import {
  createAcpHost,
  createJsonlStorage,
  createMemoryStorage,
  type StorageAdapter,
} from './index.ts'
import {
  collectEvents,
  diagnosticPayloads,
  fixtureDefinition,
  rejectionOf,
  trackHost,
  waitFor,
} from './test-harness.ts'

test('public API returns and emitted events are structured-clone serializable (INV-3)', async () => {
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'm', name: 'Method' }],
    },
    session: { sessionId: 'sess-env' },
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hi' },
            },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ],
  })

  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, { cwd: '/tmp' })
  if (created.status !== 'active') throw new Error('expected active')
  const sessionEvents = collectEvents(host, created.sessionId)
  const result = await host.prompt(created.sessionId, [
    { type: 'text', text: 'go' },
  ])

  for (const value of [
    agent,
    created,
    result,
    host.getAgent(agent.agentId),
    host.getSession(created.sessionId),
    host.getSessions(),
    ...sessionEvents,
    ...hostEvents,
  ]) {
    expect(() => structuredClone(value)).not.toThrow()
  }
})

test('an unserializable host event is rejected with an event/unserializable diagnostic', async () => {
  const base = createMemoryStorage()
  let thrown = false
  const storage: StorageAdapter = {
    appendEvent(event) {
      if (!thrown) {
        thrown = true
        const error = new Error('boom')
        Object.defineProperty(error, 'message', { value: Symbol('opaque') })
        throw error
      }
      return base.appendEvent(event)
    },
    appendMeta: (meta) => base.appendMeta(meta),
    listSessions: () => base.listSessions(),
    loadEvents: (sessionId, fromSeq) => base.loadEvents(sessionId, fromSeq),
  }
  const host = trackHost(createAcpHost({ storage }))
  const events = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({})

  await host.spawnAgent(definition)

  expect(diagnosticPayloads(events, 'event/unserializable')).toHaveLength(1)
  expect(() => structuredClone(events)).not.toThrow()
})

test('an unserializable session event is rejected with an event/unserializable diagnostic', async () => {
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    turns: [
      {
        steps: [
          {
            kind: 'permission',
            toolCall: { toolCallId: 'call_1', kind: 'execute' },
            options: [
              { kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' },
            ],
          },
        ],
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, { cwd: '/tmp' })
  if (created.status !== 'active') throw new Error('expected active')
  const sessionEvents = collectEvents(host, created.sessionId)

  const prompting = host.prompt(created.sessionId, [
    { type: 'text', text: 'go' },
  ])
  await waitFor(() =>
    sessionEvents.some((event) => event.type === 'permission-request-created'),
  )
  const request = sessionEvents.find(
    (event) => event.type === 'permission-request-created',
  )
  const requestId =
    request?.type === 'permission-request-created'
      ? request.payload.requestId
      : ''
  host.respondPermission(requestId, {
    outcome: 'selected',
    optionId: 'opt-allow',
    _meta: { onApproved: () => undefined },
  })
  await prompting

  expect(
    sessionEvents.some((event) => event.type === 'permission-request-resolved'),
  ).toBe(false)
  expect(diagnosticPayloads(hostEvents, 'event/unserializable')).toEqual([
    {
      level: 'error',
      code: 'event/unserializable',
      message: 'rejected unserializable permission-request-resolved event',
      sessionId: created.sessionId,
    },
  ])
  expect(() => structuredClone(sessionEvents)).not.toThrow()
})

test('host restart chain: restore from JSONL then loadSession resumes the session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-restore-'))
  const file = join(dir, 'events.jsonl')
  const scenario = {
    initialize: { agentCapabilities: { loadSession: true } },
    session: { sessionId: 'sess-restore' },
    turns: [
      {
        steps: [
          {
            kind: 'update' as const,
            update: {
              sessionUpdate: 'agent_message_chunk' as const,
              content: { type: 'text' as const, text: 'history' },
            },
          },
        ],
      },
    ],
    loadSession: {
      replay: [
        {
          sessionUpdate: 'agent_message_chunk' as const,
          content: { type: 'text' as const, text: 'history' },
        },
      ],
    },
  }
  const first = createAcpHost({ storage: createJsonlStorage(file) })
  const { definition } = await fixtureDefinition(scenario)
  const firstAgent = await first.spawnAgent(definition)
  const firstSession = await first.createSession(firstAgent.agentId, {
    cwd: '/tmp',
  })
  if (firstSession.status !== 'active') throw new Error('expected active')
  await first.prompt(firstSession.sessionId, [{ type: 'text', text: 'go' }])
  await first.dispose()
  const flushProbe = createJsonlStorage(file)
  const deadline = Date.now() + 5000
  for (;;) {
    const persisted = await flushProbe.loadEvents('sess-restore')
    const last = persisted.at(-1)
    if (
      last?.type === 'session-status-change' &&
      last.payload.status === 'disconnected'
    ) {
      break
    }
    if (Date.now() > deadline) throw new Error('jsonl flush timed out')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }

  const second = trackHost(createAcpHost({ storage: createJsonlStorage(file) }))
  const restored = await second.restoreSessions()
  expect(restored).toEqual([
    {
      sessionId: 'sess-restore',
      status: 'disconnected',
      cwd: resolve('/tmp'),
      agentDefinitionId: 'fixture',
    },
  ])

  const missingAgent = await rejectionOf(
    second.loadSession('agent-x', 'sess-restore'),
  )
  expect(missingAgent).toMatchObject({ code: 'acpjs/agent-exited' })

  const agent = await second.spawnAgent(definition)
  const events = collectEvents(second, 'sess-restore')
  const before = events.filter(
    (event) => event.type === 'agent-message-chunk',
  ).length
  await second.loadSession(agent.agentId, 'sess-restore', {})

  await waitFor(() => second.getSession('sess-restore')?.status === 'active')
  expect(second.getSession('sess-restore')).toEqual({
    sessionId: 'sess-restore',
    status: 'active',
    agentId: agent.agentId,
    cwd: resolve('/tmp'),
    agentDefinitionId: 'fixture',
  })
  const after = events.filter(
    (event) => event.type === 'agent-message-chunk',
  ).length
  expect(after).toBe(before)
  const lastStatus = events.findLast(
    (event) => event.type === 'session-status-change',
  )
  expect(
    lastStatus?.type === 'session-status-change'
      ? lastStatus.payload
      : undefined,
  ).toEqual({ status: 'active', resumed: true })
  const seqs = events.map((event) => event.seq)
  expect(seqs).toEqual(seqs.map((_, index) => (seqs[0] ?? 1) + index))
})
