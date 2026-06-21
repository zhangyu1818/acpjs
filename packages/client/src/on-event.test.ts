import { expect, test } from 'vitest'

import { createAcpClient, type AcpSession } from './index.ts'
import { createFakeHub, sessionParams, type FakeHub } from './test-support.ts'

import type { AcpSessionEvent, SessionState } from '@acpjs/protocol'

function hubWithSession(sessionId = 'sess-1'): FakeHub {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  hub.handle('sessions/create', () => ({
    status: 'active',
    sessionId,
    agentId: 'agent-1',
    cwd: '/tmp',
    additionalDirectories: [],
  }))
  return hub
}

async function createdSession(hub: FakeHub): Promise<{
  client: ReturnType<typeof createAcpClient>
  session: AcpSession
}> {
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const session = await agent.sessions.create(sessionParams('/tmp'))
  return { client, session }
}

test('onEvent({ fromSeq: 0 }) replays the full current-epoch log in seq order, then streams live with no gap and no dup (INV-1/INV-2)', async () => {
  const hub = hubWithSession()
  const { session } = await createdSession(hub)

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'a' },
  })
  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'b' },
  })

  const seen: AcpSessionEvent[] = []
  session.onEvent((event) => seen.push(event), { fromSeq: 0 })

  expect(seen.map((event) => event.seq)).toEqual([1, 2])

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'c' },
  })

  const seqs = seen.map((event) => event.seq)
  expect(seqs).toEqual([1, 2, 3])
  expect(seqs).toEqual(seqs.map((_, index) => index + 1))
})

test('onEvent() with no options is live-only: no historical re-delivery, only events after subscribe', async () => {
  const hub = hubWithSession()
  const { session } = await createdSession(hub)

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'before' },
  })

  const seen: AcpSessionEvent[] = []
  session.onEvent((event) => seen.push(event))

  expect(seen).toEqual([])

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'after' },
  })

  expect(seen.map((event) => event.seq)).toEqual([2])
})

test('onEvent opens an independent subscription that does not perturb subscribe()/getSnapshot(), and unsubscribing it leaves the state subscription intact', async () => {
  const hub = hubWithSession()
  const { session } = await createdSession(hub)

  const states: SessionState[] = []
  session.subscribe((state) => states.push(state))

  const events: AcpSessionEvent[] = []
  const unsubscribe = session.onEvent((event) => events.push(event))

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'one' },
  })

  expect(events).toHaveLength(1)
  expect(states).toHaveLength(1)
  const stateAfterFirst = session.getSnapshot()

  unsubscribe()

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'two' },
  })

  expect(events).toHaveLength(1)
  expect(states).toHaveLength(2)
  expect(session.getSnapshot()).not.toBe(stateAfterFirst)
  expect(session.getSnapshot().messages.at(0)?.content).toEqual([
    { type: 'text', text: 'onetwo' },
  ])
})

test('onEvent delivers the normalized AcpSessionEvent, carrying extensions on a tool-call event', async () => {
  const hub = hubWithSession()
  const { session } = await createdSession(hub)

  const seen: AcpSessionEvent[] = []
  session.onEvent((event) => seen.push(event))

  hub.emitRaw({
    sessionId: 'sess-1',
    seq: 1,
    ts: 0,
    type: 'tool-call',
    payload: { toolCallId: 'call-1', title: 'read', status: 'pending' },
    extensions: { vendor: { trace: 'abc' } },
  })

  const toolCall = seen.find(
    (event): event is Extract<AcpSessionEvent, { type: 'tool-call' }> =>
      event.type === 'tool-call',
  )
  expect(toolCall).toBeDefined()
  expect(toolCall?.extensions).toEqual({ vendor: { trace: 'abc' } })
  expect(toolCall?.payload.toolCallId).toBe('call-1')
})

test('onEvent carries tool-call _meta (subagent_session_info) verbatim to the listener', async () => {
  const hub = hubWithSession()
  const { session } = await createdSession(hub)

  const seen: AcpSessionEvent[] = []
  session.onEvent((event) => seen.push(event))

  const extensions = {
    _meta: {
      subagent_session_info: {
        sessionId: 'sub-1',
        messageStartIndex: 0,
        messageEndIndex: 3,
      },
    },
  }
  hub.emitRaw({
    sessionId: 'sess-1',
    seq: 1,
    ts: 0,
    type: 'tool-call',
    payload: { toolCallId: 'call-1', title: 'spawn', status: 'pending' },
    extensions,
  })

  const toolCall = seen.find(
    (event): event is Extract<AcpSessionEvent, { type: 'tool-call' }> =>
      event.type === 'tool-call',
  )
  expect(toolCall?.extensions).toEqual(extensions)
  const meta = toolCall?.extensions?._meta as
    | Record<string, unknown>
    | undefined
  expect(meta?.subagent_session_info).toEqual({
    sessionId: 'sub-1',
    messageStartIndex: 0,
    messageEndIndex: 3,
  })
})

test('onEvent observes session-reset and the seq epoch reset across a load', async () => {
  const hub = hubWithSession()
  const { session } = await createdSession(hub)

  hub.emit('sess-1', 'agent-message-chunk', {
    content: { type: 'text', text: 'pre-load' },
  })

  const seen: AcpSessionEvent[] = []
  session.onEvent((event) => seen.push(event))

  hub.emitRaw({
    sessionId: 'sess-1',
    seq: 1,
    ts: 0,
    type: 'session-reset',
    payload: { reason: 'load' },
  })
  hub.emitRaw({
    sessionId: 'sess-1',
    seq: 2,
    ts: 0,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'post-load' } },
  })

  const reset = seen.find(
    (event): event is Extract<AcpSessionEvent, { type: 'session-reset' }> =>
      event.type === 'session-reset',
  )
  expect(reset).toBeDefined()
  expect(reset?.seq).toBe(1)
  expect(reset?.payload.reason).toBe('load')
  expect(seen.map((event) => event.seq)).toEqual([1, 2])
})
