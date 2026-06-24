import {
  type AcpjsEvent,
  createInitialSessionState,
  reduce,
  type SessionState,
  type SessionStatus,
} from './index'

import type { ContentBlock } from '@agentclientprotocol/sdk'

export function run(events: AcpjsEvent[], sessionId = 'sess-1'): SessionState {
  let state = createInitialSessionState(sessionId)
  for (const event of events) state = reduce(state, event)
  return state
}

export function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

export function chunk(
  type: 'user-message-chunk' | 'agent-message-chunk' | 'agent-thought-chunk',
  value: string,
  messageId?: string,
  seq = 1,
): AcpjsEvent {
  return {
    sessionId: 'sess-1',
    seq,
    ts: 0,
    type,
    payload:
      messageId === undefined
        ? { content: text(value) }
        : { content: text(value), messageId },
  }
}

export function statusEvent(
  status: SessionStatus,
  seq: number,
  extra?: { resumed?: boolean },
): AcpjsEvent {
  return {
    sessionId: 'sess-1',
    seq,
    ts: 0,
    type: 'session-status-change',
    payload: { status, ...extra },
  }
}
