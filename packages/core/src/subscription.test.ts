import { expect, test } from 'vitest'

import {
  createAcpHost,
  createMemoryStorage,
  type StorageAdapter,
} from './index.ts'
import {
  collectEvents,
  diagnosticPayloads,
  fixtureDefinition,
  sessionParams,
  trackHost,
} from './test-harness.ts'

import type { AcpEvent } from '@acpjs/protocol'
import type { SessionNotification } from '@agentclientprotocol/sdk'

function chunkUpdate(text: string): SessionNotification['update'] {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  }
}

async function promptedSession(storage?: StorageAdapter) {
  const host = trackHost(createAcpHost(storage ? { storage } : {}))
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-sub' },
    turns: [
      {
        steps: ['a', 'b', 'c'].map((text) => ({
          kind: 'update' as const,
          update: chunkUpdate(text),
        })),
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  return { host, agentId: agent.agentId, sessionId: created.sessionId }
}

test('late subscriber with fromSeq sees exactly the suffix of the full stream (INV-2)', async () => {
  const { host, sessionId } = await promptedSession()
  const full = collectEvents(host, sessionId)

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  const fromThree = collectEvents(host, sessionId, 3)
  const fromZero = collectEvents(host, sessionId, 0)
  expect(fromZero).toEqual(full)
  expect(fromThree).toEqual(full.filter((event) => event.seq > 3))
  const seqs = full.map((event) => event.seq)
  expect(seqs).toEqual(seqs.map((_, index) => index + 1))
})

test('replay then live attach loses and duplicates nothing across a second prompt', async () => {
  const { host, sessionId } = await promptedSession()
  await host.prompt(sessionId, [{ type: 'text', text: 'one' }])

  const late = collectEvents(host, sessionId, 2)
  await host.prompt(sessionId, [{ type: 'text', text: 'two' }])
  const reference = collectEvents(host, sessionId, 2)

  expect(late).toEqual(reference)
})

test('events are appended to storage before subscriber dispatch (INV-1)', async () => {
  const storage = createMemoryStorage()
  const observed: { storedAtDispatch: number; seq: number }[] = []
  const { host, sessionId } = await promptedSession(storage)
  host.subscribe(sessionId, 0, (event) => {
    const stored = storage.loadEvents(sessionId) as AcpEvent[]
    observed.push({ storedAtDispatch: stored.length, seq: event.seq })
  })

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  expect(observed.length).toBeGreaterThan(0)
  for (const entry of observed) {
    expect(entry.storedAtDispatch).toBeGreaterThanOrEqual(entry.seq)
  }
})

test('a throwing subscriber is isolated and reported as a diagnostic', async () => {
  const { host, sessionId } = await promptedSession()
  const hostEvents = collectEvents(host, undefined)
  const received: AcpEvent[] = []
  host.subscribe(sessionId, 0, () => {
    throw new Error('subscriber exploded')
  })
  host.subscribe(sessionId, 0, (event) => received.push(event))

  const result = await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  expect(result.stopReason).toBe('end_turn')
  expect(
    received.filter((event) => event.type === 'agent-message-chunk'),
  ).toHaveLength(3)
  const diag = diagnosticPayloads(hostEvents, 'subscriber/error').at(0)
  expect(diag?.message).toContain('subscriber exploded')
})

test('a throwing host-stream subscriber is isolated during replay and reported as diagnostics', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({})
  await host.spawnAgent(definition)

  const seen: AcpEvent[] = []
  host.subscribe(undefined, 0, (event) => {
    seen.push(event)
    throw new Error('host replay boom')
  })

  const reference = collectEvents(host, undefined)
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.map((event) => event.seq)).toEqual(
    reference.map((event) => event.seq),
  )
  expect(
    diagnosticPayloads(reference, 'subscriber/error').some((payload) =>
      payload.message.includes('host replay boom'),
    ),
  ).toBe(true)
})

test('late host-stream subscriber with fromSeq sees exactly the suffix (INV-2)', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({})
  await host.spawnAgent(definition)

  const full = collectEvents(host, undefined, 0)
  const suffix = collectEvents(host, undefined, 2)

  expect(full.length).toBeGreaterThan(2)
  expect(suffix).toEqual(full.filter((event) => event.seq > 2))
})

test('unsubscribe stops delivery', async () => {
  const { host, sessionId } = await promptedSession()
  const events: AcpEvent[] = []
  const unsubscribe = host.subscribe(sessionId, 0, (event) =>
    events.push(event),
  )
  const before = events.length
  unsubscribe()

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  expect(events.length).toBe(before)
})

test('subscribing to an unknown session throws acpjs/session-closed', async () => {
  const host = trackHost(createAcpHost())

  expect(() => host.subscribe('nope', 0, () => undefined)).toThrowError(
    expect.objectContaining({ code: 'acpjs/session-closed' }),
  )
})
