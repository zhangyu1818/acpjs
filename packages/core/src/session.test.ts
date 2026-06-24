import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import { normalizeSessionUpdate } from './normalize.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  sessionParams,
  trackHost,
} from './test-harness.ts'

import type { FixtureScenario } from '@acpjs/fixture-agent'
import type { AcpjsSessionEvent } from '@acpjs/protocol'
import type { SessionNotification } from '@agentclientprotocol/sdk'

async function activeSession(scenario: FixtureScenario) {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition(scenario)
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active session')
  return { host, agentId: agent.agentId, sessionId: created.sessionId }
}

test('createSession resolves active, synthesizes session-config-init and status events', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    session: {
      sessionId: 'sess-1',
      modes: {
        currentModeId: 'code',
        availableModes: [{ id: 'code', name: 'Code' }],
      },
      configOptions: [
        { type: 'boolean', id: 'verbose', name: 'Verbose', currentValue: true },
      ],
    },
  })
  const agent = await host.spawnAgent(definition)

  const created = await host.createSession(
    agent.agentId,
    sessionParams('relative-dir'),
  )

  expect(created).toMatchObject({
    status: 'active',
    sessionId: 'sess-1',
    agentId: agent.agentId,
    agentDefinitionId: 'fixture',
    mcpServers: [],
    additionalDirectories: [],
  })
  const events = collectEvents(host, 'sess-1') as AcpjsSessionEvent[]
  expect(events.map((event) => [event.seq, event.type])).toEqual([
    [1, 'session-config-init'],
    [2, 'session-status-change'],
  ])
  expect(events[0]?.payload).toEqual({
    configOptions: [
      { type: 'boolean', id: 'verbose', name: 'Verbose', currentValue: true },
    ],
  })
  expect(events[1]?.payload).toEqual({ status: 'active' })
  expect(host.getSession('sess-1')?.cwd).toMatch(/^\//)
})

test('prompt emits normalized events for all modeled variants plus prompt-finished with usage', async () => {
  const allUpdates: SessionNotification['update'][] = [
    {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'u' },
      messageId: 'm1',
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'a' },
      messageId: 'm2',
    },
    {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 't' },
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Read',
      kind: 'read',
      status: 'pending',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      title: null,
      content: [{ type: 'terminal', terminalId: 'term-1' }],
    },
    {
      sessionUpdate: 'plan',
      entries: [{ content: 's', priority: 'high', status: 'pending' }],
    },
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'review', description: 'd' }],
    },
    { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    {
      sessionUpdate: 'config_option_update',
      configOptions: [
        { type: 'boolean', id: 'x', name: 'X', currentValue: false },
      ],
    },
    { sessionUpdate: 'session_info_update', title: 'T', updatedAt: null },
    { sessionUpdate: 'usage_update', size: 100, used: 5 },
  ]
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
  const { host, sessionId } = await activeSession({
    turns: [
      {
        steps: allUpdates.map((update) => ({ kind: 'update', update })),
        stopReason: 'max_tokens',
        usage,
      },
    ],
  })
  const events = collectEvents(host, sessionId) as AcpjsSessionEvent[]

  const result = await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  expect(result).toEqual({ stopReason: 'max_tokens', usage })
  const types = events.map((event) => event.type)
  expect(types).toEqual([
    'session-config-init',
    'session-status-change',
    'session-status-change',
    'user-message-chunk',
    'user-message-chunk',
    'agent-message-chunk',
    'agent-thought-chunk',
    'tool-call',
    'tool-call-update',
    'plan',
    'available-commands-update',
    'current-mode-update',
    'config-options-update',
    'session-info-update',
    'usage-update',
    'prompt-finished',
    'session-status-change',
  ])
  const seqs = events.map((event) => event.seq)
  expect(seqs).toEqual(seqs.map((_, index) => index + 1))
  expect(events[3]).toMatchObject({
    type: 'user-message-chunk',
    payload: { content: { type: 'text', text: 'go' } },
    extensions: { acpjs: { source: 'client-prompt' } },
  })
  const toolCallUpdate = events.find(
    (event) => event.type === 'tool-call-update',
  )
  expect(toolCallUpdate?.payload).toEqual({
    toolCallId: 'call_1',
    status: 'completed',
    content: [{ type: 'terminal', terminalId: 'term-1' }],
  })
  const infoUpdate = events.find(
    (event) => event.type === 'session-info-update',
  )
  expect(infoUpdate?.payload).toEqual({ title: 'T', updatedAt: null })
  const finished = events.find((event) => event.type === 'prompt-finished')
  expect(finished?.payload).toEqual({ stopReason: 'max_tokens', usage })
  for (const event of events) {
    expect(() => structuredClone(event)).not.toThrow()
  }
})

test('prompt records client prompt as a user message when the agent does not echo it', async () => {
  const { host, sessionId } = await activeSession({
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ok' },
              messageId: 'a1',
            },
          },
        ],
      },
    ],
  })
  const events = collectEvents(host, sessionId) as AcpjsSessionEvent[]

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  const transcriptEvents = events.filter(
    (event) =>
      event.type === 'user-message-chunk' ||
      event.type === 'agent-message-chunk',
  )
  expect(transcriptEvents).toMatchObject([
    {
      type: 'user-message-chunk',
      payload: { content: { type: 'text', text: 'go' } },
      extensions: { acpjs: { source: 'client-prompt' } },
    },
    {
      type: 'agent-message-chunk',
      payload: { content: { type: 'text', text: 'ok' } },
    },
  ])
})

test('prompt suppresses an exact agent echo of the client prompt', async () => {
  const { host, sessionId } = await activeSession({
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'go' },
              messageId: 'agent-user-1',
            },
          },
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ok' },
              messageId: 'agent-1',
            },
          },
        ],
      },
    ],
  })
  const events = collectEvents(host, sessionId) as AcpjsSessionEvent[]

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  const userEvents = events.filter(
    (event) => event.type === 'user-message-chunk',
  )
  expect(userEvents).toHaveLength(1)
  expect(userEvents[0]).toMatchObject({
    payload: { content: { type: 'text', text: 'go' } },
    extensions: { acpjs: { source: 'client-prompt' } },
  })
})

test('UNSTABLE plan_update degrades to unrecognized-update (INV-4)', async () => {
  const planUpdate = {
    sessionUpdate: 'plan_update',
    plan: {
      type: 'items',
      id: 'p1',
      entries: [{ content: 's', priority: 'low', status: 'completed' }],
    },
  } as unknown as SessionNotification['update']
  const { host, sessionId } = await activeSession({
    turns: [{ steps: [{ kind: 'update', update: planUpdate }] }],
  })
  const events = collectEvents(host, sessionId) as AcpjsSessionEvent[]

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  const unrecognized = events.find(
    (event) => event.type === 'unrecognized-update',
  )
  expect(unrecognized?.payload).toEqual(planUpdate)
})

test('_meta and unknown top-level fields move into extensions', async () => {
  const update = {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' },
    _meta: { vendor: { traceId: 'x' } },
  } as SessionNotification['update']
  const { host, sessionId } = await activeSession({
    turns: [{ steps: [{ kind: 'update', update }] }],
  })
  const events = collectEvents(host, sessionId) as AcpjsSessionEvent[]

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  const chunk = events.find((event) => event.type === 'agent-message-chunk')
  expect(chunk?.payload).toEqual({ content: { type: 'text', text: 'hi' } })
  expect(chunk?.extensions).toEqual({ _meta: { vendor: { traceId: 'x' } } })
})

test('normalize moves unknown top-level fields of a known variant into extensions', () => {
  const normalized = normalizeSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' },
    vendorChannel: 'beta',
  } as unknown as SessionNotification['update'])

  expect(normalized).toEqual({
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'hi' } },
    extensions: { vendorChannel: 'beta' },
  })
})

test('concurrent prompt is rejected with acpjs/prompt-in-flight without queueing', async () => {
  const { host, sessionId } = await activeSession({
    turns: [{ steps: [{ kind: 'sleep', ms: 400 }] }],
  })

  const first = host.prompt(sessionId, [{ type: 'text', text: 'one' }])
  const error = await rejectionOf(
    host.prompt(sessionId, [{ type: 'text', text: 'two' }]),
  )

  expect(error).toMatchObject({ code: 'acpjs/prompt-in-flight' })
  await host.cancel(sessionId)
  const result = await first
  expect(result.stopReason).toBe('cancelled')
})

test('cancel resolves the in-flight prompt with stopReason cancelled', async () => {
  const { host, sessionId } = await activeSession({
    turns: [{ steps: [{ kind: 'sleep', ms: 5000 }] }],
  })
  const events = collectEvents(host, sessionId) as AcpjsSessionEvent[]

  const inFlight = host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  await host.cancel(sessionId)
  const result = await inFlight

  expect(result.stopReason).toBe('cancelled')
  const finished = events.find((event) => event.type === 'prompt-finished')
  expect(finished?.payload).toEqual({ stopReason: 'cancelled' })
  expect(host.getSession(sessionId)?.status).toBe('active')
})

test('non-auth protocol error on session/new rethrows without creating a session', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    session: { error: { code: -32603, message: 'new session boom' } },
  })
  const agent = await host.spawnAgent(definition)

  const error = await rejectionOf(
    host.createSession(agent.agentId, sessionParams('/tmp')),
  )

  expect(error).toMatchObject({ code: -32603, message: 'new session boom' })
  expect(host.getSessions()).toEqual([])
})

test('protocol error inside prompt rejects and returns the session back to active', async () => {
  const { host, sessionId } = await activeSession({
    turns: [
      {
        steps: [
          { kind: 'error', code: -32603, message: 'boom', data: { x: 1 } },
        ],
      },
    ],
  })
  const error = await rejectionOf(
    host.prompt(sessionId, [{ type: 'text', text: 'go' }]),
  )

  expect(error).toMatchObject({
    code: -32603,
    message: 'boom',
    data: { x: 1 },
  })
  expect(host.getSession(sessionId)?.status).toBe('active')
  await expect(
    host.prompt(sessionId, [{ type: 'text', text: 'retry' }]),
  ).resolves.toEqual({ stopReason: 'end_turn' })
})

test('operations against an exited agent are rejected with acpjs/agent-exited', async () => {
  const { host, agentId, sessionId } = await activeSession({
    turns: [{ steps: [{ kind: 'exit', code: 1 }] }],
  })

  await rejectionOf(host.prompt(sessionId, [{ type: 'text', text: 'go' }]))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))

  expect(host.getAgent(agentId)?.status).toBe('exited')
  expect(host.getSession(sessionId)?.status).toBe('disconnected')
  const error = await rejectionOf(
    host.createSession(agentId, sessionParams('/tmp')),
  )
  expect(error).toMatchObject({ code: 'acpjs/agent-exited' })
})
