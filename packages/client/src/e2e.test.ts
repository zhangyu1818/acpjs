import { expect, test } from 'vitest'

import { e2eClient, waitFor } from './e2e-harness.ts'
import { rejectionOf, resumeParams, sessionParams } from './test-support.ts'

import type { PermissionRequest } from './index.ts'

test('spawn, create, subscribe and prompt over the real in-process chain builds full SessionState', async () => {
  const { client, definition } = await e2eClient({
    session: {
      sessionId: 'sess-e2e',
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      configOptions: [
        {
          type: 'boolean',
          id: 'verbose',
          name: 'Verbose',
          currentValue: false,
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
              content: { type: 'text', text: 'Hel' },
            },
          },
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'lo' },
            },
          },
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'thinking' },
            },
          },
          {
            kind: 'update',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_1',
              title: 'Read file',
              kind: 'read',
              status: 'pending',
            },
          },
          {
            kind: 'update',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call_1',
              status: 'completed',
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: 'file body' },
                },
              ],
            },
          },
          {
            kind: 'update',
            update: {
              sessionUpdate: 'plan',
              entries: [
                { content: 'step one', priority: 'high', status: 'pending' },
              ],
            },
          },
        ],
        stopReason: 'end_turn',
      },
    ],
  })

  const agent = await client.agents.spawn(definition)
  const session = await agent.sessions.create(sessionParams('/tmp'))
  expect(session.sessionId).toBe('sess-e2e')

  const result = await session.prompt([{ type: 'text', text: 'go' }])
  expect(result.stopReason).toBe('end_turn')

  const state = session.getSnapshot()
  expect(state.messages).toEqual([
    {
      kind: 'agent',
      messageId: null,
      content: [
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
      ],
      seq: 4,
    },
    {
      kind: 'thought',
      messageId: null,
      content: [{ type: 'text', text: 'thinking' }],
      seq: 6,
    },
  ])
  expect(state.toolCalls.call_1).toMatchObject({
    title: 'Read file',
    kind: 'read',
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'text', text: 'file body' } },
    ],
  })
  expect(state.plan).toEqual({
    entries: [{ content: 'step one', priority: 'high', status: 'pending' }],
  })
  expect(state.modes).toBeNull()
  expect(state.configOptions).toEqual([
    { type: 'boolean', id: 'verbose', name: 'Verbose', currentValue: false },
  ])
  expect(state.lastStopReason).toBe('end_turn')
  expect(state.connection.status).toBe('active')
  expect(() => structuredClone(state)).not.toThrow()
})

test('permission round trip: request surfaces with passthrough payload, respond resumes the turn', async () => {
  const { client, definition } = await e2eClient({
    turns: [
      {
        steps: [
          {
            kind: 'permission',
            toolCall: { toolCallId: 'call_1', kind: 'execute' },
            options: [
              { kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' },
              { kind: 'reject_once', name: 'Reject', optionId: 'opt-reject' },
            ],
            onSelected: {
              'opt-allow': [
                {
                  kind: 'update',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'granted' },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  })
  const agent = await client.agents.spawn(definition)
  const session = await agent.sessions.create(sessionParams('/tmp'))

  const seen: PermissionRequest[] = []
  let pendingDuringRequest = 0
  client.permissions.subscribe((requests) => {
    for (const request of requests) {
      seen.push(request)
      pendingDuringRequest =
        session.getSnapshot().pendingPermissionRequests.length
      void request.respond({ outcome: 'selected', optionId: 'opt-allow' })
    }
  })

  const result = await session.prompt([{ type: 'text', text: 'go' }])

  expect(result.stopReason).toBe('end_turn')
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    sessionId: session.sessionId,
    toolCall: { toolCallId: 'call_1', kind: 'execute' },
    options: [
      { kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' },
      { kind: 'reject_once', name: 'Reject', optionId: 'opt-reject' },
    ],
  })
  expect(pendingDuringRequest).toBe(1)

  const state = session.getSnapshot()
  expect(state.pendingPermissionRequests).toEqual([])
  expect(state.messages.at(-1)?.content).toEqual([
    { type: 'text', text: 'granted' },
  ])

  const error = await rejectionOf(seen[0]?.respond({ outcome: 'cancelled' }))
  expect(error).toMatchObject({ code: 'acpjs/already-answered' })
})

test('agent auth errors from create are propagated to the caller', async () => {
  const { client, definition } = await e2eClient({
    initialize: { authMethods: [{ id: 'device', name: 'Device flow' }] },
    session: { sessionId: 'sess-auth', authRequired: true },
  })
  const agent = await client.agents.spawn(definition)

  const error = await rejectionOf(agent.sessions.create(sessionParams('/tmp')))
  expect(error).toMatchObject({
    code: 'acpjs/agent-error',
    data: { code: -32000, message: 'Authentication required' },
    retryable: false,
  })
})

test('cancel ends the in-flight prompt with stopReason cancelled', async () => {
  const { client, definition } = await e2eClient({
    turns: [{ steps: [{ kind: 'sleep', ms: 5000 }] }],
  })
  const agent = await client.agents.spawn(definition)
  const session = await agent.sessions.create(sessionParams('/tmp'))

  const inFlight = session.prompt([{ type: 'text', text: 'go' }])
  await waitFor(() => session.getSnapshot().connection.status === 'prompting')
  await session.cancel()
  const result = await inFlight

  expect(result.stopReason).toBe('cancelled')
  expect(session.getSnapshot().lastStopReason).toBe('cancelled')
  expect(session.getSnapshot().connection.status).toBe('active')
})

test('capability-gated methods reject with acpjs/capability-unsupported through the facade', async () => {
  const { client, definition } = await e2eClient({})
  const agent = await client.agents.spawn(definition)
  const session = await agent.sessions.create(sessionParams('/tmp'))

  expect(await rejectionOf(agent.sessions.list())).toMatchObject({
    code: 'acpjs/capability-unsupported',
  })
  expect(
    await rejectionOf(
      agent.sessions.resume(session.sessionId, resumeParams('/tmp')),
    ),
  ).toMatchObject({ code: 'acpjs/capability-unsupported' })
  expect(await rejectionOf(session.setMode('plan'))).toMatchObject({
    code: 'acpjs/capability-unsupported',
  })
  expect(
    await rejectionOf(session.setConfigOption('x', { value: 'y' })),
  ).toMatchObject({ code: 'acpjs/capability-unsupported' })
  await agent.sessions.delete(session.sessionId)
  expect(session.getSnapshot().connection.status).toBe('deleted')
})

test('capability-rich agent: load, list, setMode, resume and delete succeed end to end with mcpServers passthrough', async () => {
  const mcpServers = [{ name: 'svc', command: '/bin/echo', args: [], env: [] }]
  const { client, definition } = await e2eClient({
    initialize: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, delete: {} },
      },
    },
    session: {
      sessionId: 'sess-rich',
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    },
    loadSession: {
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      replay: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'history' },
        },
      ],
    },
    listSessions: {
      sessions: [{ sessionId: 'sess-rich', cwd: '/tmp' }],
      nextCursor: 'cursor-2',
    },
    resumeSession: { expectMcpServers: mcpServers },
  })
  const agent = await client.agents.spawn(definition)
  const session = await agent.sessions.create(sessionParams('/tmp'))

  const loaded = await agent.sessions.load(
    session.sessionId,
    sessionParams('/tmp', { mcpServers }),
  )
  expect(loaded).toBe(session)
  expect(loaded.getSnapshot().connection).toMatchObject({
    status: 'active',
    resumed: true,
  })

  const listed = await agent.sessions.list({ cwd: '/tmp' })
  expect(listed).toEqual({
    sessions: [{ sessionId: 'sess-rich', cwd: '/tmp' }],
    nextCursor: 'cursor-2',
  })

  await session.setMode('plan')

  const resumed = await agent.sessions.resume(
    session.sessionId,
    resumeParams('/tmp', { mcpServers }),
  )
  expect(resumed).toBe(session)
  expect(resumed.getSnapshot().connection).toMatchObject({
    status: 'active',
    resumed: true,
  })

  await agent.sessions.delete(session.sessionId)
  await waitFor(() => session.getSnapshot().connection.status === 'deleted')
})

test('a session created by one client is announced to another connection and discoverable via list and attach', async () => {
  const { client, definition, connectClient } = await e2eClient({
    session: { sessionId: 'sess-shared' },
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'from A' },
            },
          },
        ],
        stopReason: 'end_turn',
      },
    ],
  })
  const other = connectClient()
  let announced = 0
  other.sessions.subscribe(() => {
    announced += 1
  })

  const agent = await client.agents.spawn(definition)
  const session = await agent.sessions.create(sessionParams('/tmp'))
  await waitFor(() => announced > 0)

  const listed = await other.sessions.list()
  expect(listed.map((snapshot) => snapshot.sessionId)).toContain('sess-shared')
  expect(
    listed.find((snapshot) => snapshot.sessionId === 'sess-shared'),
  ).toMatchObject({
    status: 'active',
    agentId: agent.agentId,
  })

  const agentsSeen = await other.agents.list()
  expect(agentsSeen.map((snapshot) => snapshot.agentId)).toContain(
    agent.agentId,
  )
  const hydrated = await other.agents.attach(agent.agentId)
  expect(hydrated.getSnapshot().status).toBe('ready')

  await session.prompt([{ type: 'text', text: 'go' }])
  const attached = await other.sessions.attach('sess-shared')
  expect(attached.getSnapshot()).toEqual(session.getSnapshot())
})

test('a client connected after host-created sessions materializes them from host projections', async () => {
  const { definition, host, connectClient } = await e2eClient({
    session: { sessionId: 'sess-host-started' },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))

  const late = connectClient()

  await waitFor(() => late.sessions.get('sess-host-started') !== undefined)
  const session = late.sessions.get('sess-host-started')
  expect(late.sessions.getSnapshot().map((item) => item.sessionId)).toContain(
    'sess-host-started',
  )
  expect(session?.getSnapshot().connection.status).toBe('active')
})

test('close marks the session closed and later operations reject with acpjs/session-closed', async () => {
  const { client, definition } = await e2eClient({
    initialize: {
      agentCapabilities: { sessionCapabilities: { close: {} } },
    },
  })
  const agent = await client.agents.spawn(definition)
  const session = await agent.sessions.create(sessionParams('/tmp'))

  await session.close()

  expect(session.getSnapshot().connection.status).toBe('closed')
  const error = await rejectionOf(session.prompt([{ type: 'text', text: 'x' }]))
  expect(error).toMatchObject({ code: 'acpjs/session-closed' })
})
