import { expect, test } from 'vitest'

import { type AcpEvent, createInitialSessionState, reduce } from './index'
import { run, text } from './test-support'

test('a tool call event indexes a normalized tool call by toolCallId', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'tool-call',
      payload: {
        toolCallId: 'call-1',
        title: 'Read file',
        kind: 'read',
        status: 'pending',
        locations: [{ path: '/tmp/a.txt' }],
        rawInput: { path: '/tmp/a.txt' },
      },
    },
  ])
  expect(state.toolCalls).toEqual({
    'call-1': {
      toolCallId: 'call-1',
      title: 'Read file',
      kind: 'read',
      status: 'pending',
      content: [],
      locations: [{ path: '/tmp/a.txt' }],
      rawInput: { path: '/tmp/a.txt' },
      rawOutput: undefined,
      seq: 1,
    },
  })
})

test('a tool call update merges only carried fields and replaces content and locations wholesale', () => {
  const created: AcpEvent = {
    sessionId: 'sess-1',
    seq: 1,
    ts: 0,
    type: 'tool-call',
    payload: {
      toolCallId: 'call-1',
      title: 'Read file',
      kind: 'read',
      status: 'pending',
      content: [{ type: 'content', content: text('old') }],
      locations: [{ path: '/tmp/a.txt' }, { path: '/tmp/b.txt' }],
    },
  }
  const state = run([
    created,
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'tool-call-update',
      payload: {
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: text('new') }],
        rawOutput: { ok: true },
      },
    },
  ])
  expect(state.toolCalls['call-1']).toEqual({
    toolCallId: 'call-1',
    title: 'Read file',
    kind: 'read',
    status: 'completed',
    content: [{ type: 'content', content: text('new') }],
    locations: [{ path: '/tmp/a.txt' }, { path: '/tmp/b.txt' }],
    rawInput: undefined,
    rawOutput: { ok: true },
    seq: 1,
  })
})

test('a tool call update carrying title, kind and locations overrides only those fields', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'tool-call',
      payload: {
        toolCallId: 'call-1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
        content: [{ type: 'content', content: text('kept') }],
        locations: [{ path: '/tmp/a.txt' }],
        rawInput: { path: '/tmp/a.txt' },
      },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'tool-call-update',
      payload: {
        toolCallId: 'call-1',
        title: 'Edit file',
        kind: 'edit',
        locations: [{ path: '/tmp/c.txt', line: 3 }],
      },
    },
  ])
  expect(state.toolCalls['call-1']).toEqual({
    toolCallId: 'call-1',
    title: 'Edit file',
    kind: 'edit',
    status: 'in_progress',
    content: [{ type: 'content', content: text('kept') }],
    locations: [{ path: '/tmp/c.txt', line: 3 }],
    rawInput: { path: '/tmp/a.txt' },
    rawOutput: undefined,
    seq: 1,
  })
})

test('a tool call update carrying explicit null fields leaves those fields unchanged', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'tool-call',
      payload: {
        toolCallId: 'call-1',
        title: 'Read file',
        kind: 'read',
        status: 'pending',
      },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'tool-call-update',
      payload: { toolCallId: 'call-1', title: null, kind: null, status: null },
    },
  ])
  expect(state.toolCalls['call-1']).toMatchObject({
    title: 'Read file',
    kind: 'read',
    status: 'pending',
  })
})

test('a tool call update for an unknown toolCallId leaves the state untouched', () => {
  const initial = createInitialSessionState('sess-1')
  const next = reduce(initial, {
    sessionId: 'sess-1',
    seq: 1,
    ts: 0,
    type: 'tool-call-update',
    payload: { toolCallId: 'ghost', status: 'completed' },
  })
  expect(next).toBe(initial)
})
