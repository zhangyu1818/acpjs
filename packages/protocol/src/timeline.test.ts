import { expect, test } from 'vitest'

import { chunk, run, text } from './test-support'

import type { AcpEvent } from './index'

test('a new message records the seq of the event that first created it', () => {
  const state = run([chunk('user-message-chunk', 'hi', 'u1', 7)])
  expect(state.messages[0]?.seq).toBe(7)
})

test('chunks sharing a messageId keep the seq of their first appearance', () => {
  const state = run([
    chunk('agent-message-chunk', 'Hel', 'm1', 3),
    chunk('agent-message-chunk', 'lo', 'm1', 9),
  ])
  expect(state.messages).toEqual([
    {
      kind: 'agent',
      messageId: 'm1',
      content: [text('Hello')],
      seq: 3,
    },
  ])
})

test('a tool call records the seq of its creation event', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 5,
      ts: 0,
      type: 'tool-call',
      payload: { toolCallId: 'call-1', title: 'Read file' },
    },
  ])
  expect(state.toolCalls['call-1']?.seq).toBe(5)
})

test('a tool call update preserves the seq of the creating event', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 5,
      ts: 0,
      type: 'tool-call',
      payload: { toolCallId: 'call-1', title: 'Read file' },
    },
    {
      sessionId: 'sess-1',
      seq: 12,
      ts: 0,
      type: 'tool-call-update',
      payload: { toolCallId: 'call-1', status: 'completed' },
    },
  ])
  expect(state.toolCalls['call-1']?.seq).toBe(5)
})

test('messages and tool calls can be merged into a single timeline by seq', () => {
  const events: AcpEvent[] = [
    chunk('user-message-chunk', 'do it', 'u1', 1),
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'tool-call',
      payload: { toolCallId: 'call-1', title: 'Run' },
    },
    chunk('agent-message-chunk', 'done', 'm1', 3),
  ]
  const state = run(events)
  const timeline = [
    ...state.messages.map((m) => ({ seq: m.seq, ref: m.messageId ?? m.kind })),
    ...Object.values(state.toolCalls).map((t) => ({
      seq: t.seq,
      ref: t.toolCallId,
    })),
  ].sort((a, b) => a.seq - b.seq)
  expect(timeline.map((e) => e.ref)).toEqual(['u1', 'call-1', 'm1'])
})
