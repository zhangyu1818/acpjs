import { expect, test } from 'vitest'

import { type AcpjsEvent, reduce } from './index'
import { run } from './test-support'

function created(
  seq: number,
  requestId: string,
  toolCallId: string,
): AcpjsEvent {
  return {
    sessionId: 'sess-1',
    seq,
    ts: 0,
    type: 'permission-request-created',
    payload: {
      requestId,
      toolCall: { toolCallId },
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
    },
  }
}

function resolved(
  seq: number,
  requestId: string,
  status: 'answered' | 'superseded',
  outcome?: { outcome: 'selected'; optionId: string },
): AcpjsEvent {
  return {
    sessionId: 'sess-1',
    seq,
    ts: 0,
    type: 'permission-request-resolved',
    payload: { requestId, status, ...(outcome ? { outcome } : {}) },
  }
}

test('resolving a request moves it out of pending and into the resolved audit list', () => {
  const state = run([
    created(1, 'req-1', 'call-1'),
    resolved(2, 'req-1', 'answered', {
      outcome: 'selected',
      optionId: 'allow',
    }),
  ])
  expect(state.pendingPermissionRequests).toEqual([])
  expect(state.resolvedPermissionRequests).toEqual([
    {
      requestId: 'req-1',
      toolCall: { toolCallId: 'call-1' },
      status: 'answered',
      outcome: { outcome: 'selected', optionId: 'allow' },
    },
  ])
})

test('a resolved entry carries the toolCall captured from the matching pending request', () => {
  const state = run([
    created(1, 'req-1', 'call-1'),
    created(2, 'req-2', 'call-2'),
    resolved(3, 'req-1', 'superseded'),
  ])
  expect(state.resolvedPermissionRequests).toEqual([
    {
      requestId: 'req-1',
      toolCall: { toolCallId: 'call-1' },
      status: 'superseded',
    },
  ])
  expect(state.pendingPermissionRequests.map((r) => r.requestId)).toEqual([
    'req-2',
  ])
})

test('a resolved event with no matching pending request still records an audit entry', () => {
  const state = run([
    resolved(1, 'req-x', 'answered', {
      outcome: 'selected',
      optionId: 'allow',
    }),
  ])
  expect(state.resolvedPermissionRequests).toEqual([
    {
      requestId: 'req-x',
      toolCall: { toolCallId: 'req-x' },
      status: 'answered',
      outcome: { outcome: 'selected', optionId: 'allow' },
    },
  ])
})

test('the resolved audit list keeps the most recent 100 entries, dropping the oldest', () => {
  let state = run([])
  for (let i = 0; i < 105; i += 1) {
    state = reduce(state, created(i * 2 + 1, `req-${i}`, `call-${i}`))
    state = reduce(state, resolved(i * 2 + 2, `req-${i}`, 'answered'))
  }
  expect(state.resolvedPermissionRequests).toHaveLength(100)
  expect(state.resolvedPermissionRequests[0]?.requestId).toBe('req-5')
  expect(state.resolvedPermissionRequests[99]?.requestId).toBe('req-104')
})
