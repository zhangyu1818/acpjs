import { expect, test } from 'vitest'

import { type AcpEvent, createInitialSessionState, reduce } from './index'
import { chunk, run, statusEvent } from './test-support'

test('createInitialSessionState produces an empty session state bound to the session id', () => {
  expect(createInitialSessionState('sess-1')).toEqual({
    sessionId: 'sess-1',
    messages: [],
    toolCalls: {},
    plan: null,
    availableCommands: [],
    modes: null,
    configOptions: [],
    info: { title: null, updatedAt: null },
    usage: null,
    lastTurnUsage: null,
    lastStopReason: null,
    lastPromptError: null,
    connection: { status: 'creating', resumed: false, authMethods: null },
    pendingPermissionRequests: [],
    terminals: {},
    resolvedPermissionRequests: [],
  })
})

test('prompt termination records stop reason and passes turn usage through verbatim', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'prompt-finished',
      payload: {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    },
  ])
  expect(state.lastStopReason).toBe('end_turn')
  expect(state.lastTurnUsage).toEqual({
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  })
  expect(state.lastPromptError).toBeNull()
})

test('prompt termination without usage clears the previous turn usage and may carry an error', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'prompt-finished',
      payload: {
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'prompt-finished',
      payload: {
        stopReason: 'cancelled',
        error: { code: -32603, message: 'Internal error' },
      },
    },
  ])
  expect(state.lastStopReason).toBe('cancelled')
  expect(state.lastTurnUsage).toBeNull()
  expect(state.lastPromptError).toEqual({
    code: -32603,
    message: 'Internal error',
  })
})

test('an auth-required status change carries auth methods which clear on recovery', () => {
  const authRequired = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'session-status-change',
      payload: {
        status: 'auth-required',
        authMethods: [{ id: 'oauth', name: 'OAuth' }],
      },
    },
  ])
  expect(authRequired.connection).toEqual({
    status: 'auth-required',
    resumed: false,
    authMethods: [{ id: 'oauth', name: 'OAuth' }],
  })

  const recovered = reduce(authRequired, statusEvent('active', 2))
  expect(recovered.connection).toEqual({
    status: 'active',
    resumed: false,
    authMethods: null,
  })
})

test('a disconnected session and a session resumed back to active are distinguishable', () => {
  const disconnected = run([
    statusEvent('active', 1),
    statusEvent('disconnected', 2),
  ])
  expect(disconnected.connection).toEqual({
    status: 'disconnected',
    resumed: false,
    authMethods: null,
  })

  const resumed = run([
    statusEvent('active', 1),
    statusEvent('disconnected', 2),
    statusEvent('resuming', 3),
    statusEvent('active', 4, { resumed: true }),
  ])
  expect(resumed.connection).toEqual({
    status: 'active',
    resumed: true,
    authMethods: null,
  })
})

test('a resumed session loses its resumed mark when it disconnects again', () => {
  const state = run([
    statusEvent('active', 1, { resumed: true }),
    statusEvent('prompting', 2),
    statusEvent('disconnected', 3),
  ])
  expect(state.connection).toEqual({
    status: 'disconnected',
    resumed: false,
    authMethods: null,
  })
})

test('a resumed session loses its resumed mark when it is closed', () => {
  const state = run([
    statusEvent('active', 1, { resumed: true }),
    statusEvent('closed', 2),
  ])
  expect(state.connection).toEqual({
    status: 'closed',
    resumed: false,
    authMethods: null,
  })
})

test('permission request lifecycle adds to and removes from the pending list', () => {
  const created = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'permission-request-created',
      payload: {
        requestId: 'req-1',
        toolCall: { toolCallId: 'call-1' },
        options: [
          { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        ],
      },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'permission-request-created',
      payload: {
        requestId: 'req-2',
        toolCall: { toolCallId: 'call-2' },
        options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
      },
    },
  ])
  expect(created.pendingPermissionRequests.map((r) => r.requestId)).toEqual([
    'req-1',
    'req-2',
  ])

  const resolved = reduce(created, {
    sessionId: 'sess-1',
    seq: 3,
    ts: 0,
    type: 'permission-request-resolved',
    payload: {
      requestId: 'req-1',
      status: 'answered',
      outcome: { outcome: 'selected', optionId: 'allow' },
    },
  })
  expect(resolved.pendingPermissionRequests).toEqual([
    {
      requestId: 'req-2',
      toolCall: { toolCallId: 'call-2' },
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
    },
  ])

  const superseded = reduce(resolved, {
    sessionId: 'sess-1',
    seq: 4,
    ts: 0,
    type: 'permission-request-resolved',
    payload: { requestId: 'req-2', status: 'superseded' },
  })
  expect(superseded.pendingPermissionRequests).toEqual([])
})

test('unrecognized updates, diagnostics and host events leave the state identical without throwing', () => {
  const state = run([chunk('agent-message-chunk', 'hello', 'm1')])
  const untouched: AcpEvent[] = [
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'unrecognized-update',
      payload: {
        sessionUpdate: 'plan_update',
        plan: { type: 'markdown', id: 'p1', content: '# plan' },
      },
    },
    {
      agentId: 'agent-1',
      seq: 1,
      ts: 0,
      type: 'diagnostic',
      payload: {
        level: 'warn',
        code: 'storage.write-failed',
        message: 'disk full',
        sessionId: 'sess-1',
      },
    },
    {
      agentId: 'agent-1',
      seq: 2,
      ts: 0,
      type: 'agent-status-change',
      payload: {
        status: 'exited',
        restartCount: 0,
        reason: 'crashed',
        exit: { code: 1 },
      },
    },
    {
      agentId: 'agent-1',
      seq: 3,
      ts: 0,
      type: 'install-progress',
      payload: { stage: 'downloading', downloadedBytes: 10, totalBytes: 100 },
    },
    {
      seq: 4,
      ts: 0,
      type: 'session-created',
      payload: {
        sessionId: 'sess-2',
        agentId: 'agent-1',
        cwd: '/workspace',
        status: 'active',
      },
    },
    {
      seq: 5,
      ts: 0,
      type: 'session-closed',
      payload: { sessionId: 'sess-2', status: 'closed' },
    },
  ]
  for (const event of untouched) {
    expect(reduce(state, event)).toBe(state)
  }
})

test('reduce never mutates the previous state or the event', () => {
  const events: AcpEvent[] = [
    chunk('agent-message-chunk', 'Hel', 'm1'),
    chunk('agent-message-chunk', 'lo', 'm1', 2),
    {
      sessionId: 'sess-1',
      seq: 3,
      ts: 0,
      type: 'tool-call',
      payload: {
        toolCallId: 'call-1',
        title: 'Run',
        locations: [{ path: '/x' }],
      },
    },
    {
      sessionId: 'sess-1',
      seq: 4,
      ts: 0,
      type: 'tool-call-update',
      payload: { toolCallId: 'call-1', status: 'completed' },
    },
    {
      sessionId: 'sess-1',
      seq: 5,
      ts: 0,
      type: 'session-status-change',
      payload: { status: 'active' },
    },
  ]
  let state = createInitialSessionState('sess-1')
  for (const event of events) {
    const previous = state
    const previousSnapshot = structuredClone(previous)
    const eventSnapshot = structuredClone(event)
    state = reduce(previous, event)
    expect(previous).toEqual(previousSnapshot)
    expect(event).toEqual(eventSnapshot)
  }
})
