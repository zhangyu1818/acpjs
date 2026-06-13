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
  trackHost,
  waitFor,
} from './test-harness.ts'

import type { AcpEvent, AcpSessionEvent } from '@acpjs/protocol'

async function runSession(storage: StorageAdapter) {
  const host = trackHost(createAcpHost({ storage }))
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-store' },
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello' },
            },
          },
        ],
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, { cwd: '/tmp' })
  if (created.status !== 'active') throw new Error('expected active')
  const events = collectEvents(host, created.sessionId)
  await host.prompt(created.sessionId, [{ type: 'text', text: 'go' }])
  return { host, sessionId: created.sessionId, events }
}

test('memory storage appendMeta surfaces full meta from listSessions and never leaks into loadEvents', async () => {
  const storage = createMemoryStorage()
  await storage.appendEvent({
    sessionId: 'sess-a',
    seq: 1,
    ts: 0,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'hi' } },
  })
  await storage.appendMeta({
    sessionId: 'sess-a',
    agentDefinitionId: 'agent-x',
    cwd: '/work',
  })
  await storage.appendMeta({ sessionId: 'sess-b' })

  expect(await storage.listSessions()).toEqual([
    { sessionId: 'sess-a', agentDefinitionId: 'agent-x', cwd: '/work' },
    { sessionId: 'sess-b' },
  ])
  const loaded = await storage.loadEvents('sess-a')
  expect(loaded.map((event) => event.type)).toEqual(['agent-message-chunk'])
})

test('createSession persists a session-meta record with agentDefinitionId and cwd (memory)', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition(
    { session: { sessionId: 'sess-meta' } },
    'agent-meta',
  )
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, { cwd: '/tmp/work' })

  expect(await host.options.storage.listSessions()).toEqual([
    {
      sessionId: 'sess-meta',
      agentDefinitionId: 'agent-meta',
      cwd: resolve('/tmp/work'),
    },
  ])
  const persisted = await host.options.storage.loadEvents('sess-meta')
  expect(persisted.length).toBeGreaterThan(0)
})

test('createSession persists a session-meta record in JSONL without polluting replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-jsonl-meta-'))
  const file = join(dir, 'events.jsonl')
  const host = trackHost(createAcpHost({ storage: createJsonlStorage(file) }))
  const { definition } = await fixtureDefinition(
    { session: { sessionId: 'sess-jsonl-meta' } },
    'agent-jsonl',
  )
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, { cwd: '/tmp/jwork' })

  const reader = createJsonlStorage(file)
  const deadline = Date.now() + 5000
  for (;;) {
    const sessions = await reader.listSessions()
    if (sessions.some((meta) => meta.agentDefinitionId === 'agent-jsonl')) break
    if (Date.now() > deadline) throw new Error('jsonl meta flush timed out')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  expect(await reader.listSessions()).toEqual([
    {
      sessionId: 'sess-jsonl-meta',
      agentDefinitionId: 'agent-jsonl',
      cwd: resolve('/tmp/jwork'),
    },
  ])
  const replayed = await reader.loadEvents('sess-jsonl-meta')
  expect(replayed.length).toBeGreaterThan(0)
  expect(replayed.some((event) => 'kind' in event)).toBe(false)
})

test('appendMeta write failure produces a diagnostic without breaking the live stream (INV-5)', async () => {
  const events: AcpSessionEvent[] = []
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta() {
      throw new Error('meta write boom')
    },
    listSessions: () => [],
    loadEvents: () => [],
  }
  const host = trackHost(createAcpHost({ storage }))
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-meta-fail' },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, { cwd: '/tmp' })
  host.subscribe('sess-meta-fail', 0, (event) =>
    events.push(event as AcpSessionEvent),
  )

  expect(events.length).toBeGreaterThan(0)
  await waitFor(() =>
    diagnosticPayloads(hostEvents, 'storage/write-failed').some((diag) =>
      diag.message.includes('meta write boom'),
    ),
  )
})

test('a storage adapter that throws does not affect the live stream and yields diagnostics (INV-5)', async () => {
  const storage: StorageAdapter = {
    appendEvent() {
      throw new Error('disk on fire')
    },
    appendMeta() {
      throw new Error('meta disk on fire')
    },
    listSessions: () => [],
    loadEvents: () => [],
  }
  const { host, events } = await runSession(storage)

  expect((events as AcpSessionEvent[]).map((event) => event.type)).toContain(
    'agent-message-chunk',
  )
  const seqs = events.map((event) => event.seq)
  expect(seqs).toEqual(seqs.map((_, index) => index + 1))
  const hostEvents = collectEvents(host, undefined)
  const diag = diagnosticPayloads(hostEvents, 'storage/write-failed').at(0)
  expect(diag?.message).toContain('disk on fire')
})

test('an async-rejecting storage adapter is reported without breaking the stream (INV-5)', async () => {
  const storage: StorageAdapter = {
    async appendEvent() {
      throw new Error('async disk failure')
    },
    async appendMeta() {
      throw new Error('async meta failure')
    },
    listSessions: () => [],
    loadEvents: () => [],
  }
  const { host, events } = await runSession(storage)

  expect(events.length).toBeGreaterThan(0)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  const hostEvents = collectEvents(host, undefined)
  const diag = diagnosticPayloads(hostEvents, 'storage/write-failed').at(0)
  expect(diag?.message).toContain('async disk failure')
})

test('JSONL storage persists events and a fresh host rebuilds the session as disconnected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-jsonl-'))
  const file = join(dir, 'events.jsonl')
  const storage = createJsonlStorage(file)
  const { host, events } = await runSession(storage)
  await host.dispose()
  const deadline = Date.now() + 5000
  for (;;) {
    const persisted = await storage.loadEvents('sess-store')
    if (persisted.length >= events.length) break
    if (Date.now() > deadline) throw new Error('jsonl flush timed out')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }

  const rebuilt = trackHost(
    createAcpHost({ storage: createJsonlStorage(file) }),
  )
  const restored = await rebuilt.restoreSessions()

  expect(restored).toEqual([
    {
      sessionId: 'sess-store',
      status: 'disconnected',
      cwd: resolve('/tmp'),
      agentDefinitionId: 'fixture',
    },
  ])
  const replayed = collectEvents(rebuilt, 'sess-store')
  const sessionEvents = events as AcpSessionEvent[]
  expect(replayed.slice(0, sessionEvents.length)).toEqual(sessionEvents)
  const last = replayed.at(-1) as AcpSessionEvent
  expect(last.type).toBe('session-status-change')
  expect(last.payload).toEqual({ status: 'disconnected' })
  const seqs = replayed.map((event) => event.seq)
  expect(seqs).toEqual(seqs.map((_, index) => index + 1))
})

test('JSONL restore backfills cwd and agentDefinitionId from meta and loadSession needs no cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-jsonl-restore-'))
  const file = join(dir, 'events.jsonl')
  const scenario = {
    session: { sessionId: 'sess-restore' },
    initialize: { agentCapabilities: { loadSession: true } },
    loadSession: { replay: [] },
  }
  const host = trackHost(createAcpHost({ storage: createJsonlStorage(file) }))
  const { definition } = await fixtureDefinition(scenario, 'agent-restore')
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, {
    cwd: '/tmp/restore',
  })
  if (created.status !== 'active') throw new Error('expected active')
  await host.dispose()

  const reader = createJsonlStorage(file)
  const deadline = Date.now() + 5000
  for (;;) {
    const sessions = await reader.listSessions()
    if (sessions.some((meta) => meta.cwd === resolve('/tmp/restore'))) break
    if (Date.now() > deadline) throw new Error('jsonl meta flush timed out')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }

  const rebuilt = trackHost(
    createAcpHost({ storage: createJsonlStorage(file) }),
  )
  const restored = await rebuilt.restoreSessions()
  expect(restored).toEqual([
    {
      sessionId: 'sess-restore',
      status: 'disconnected',
      cwd: resolve('/tmp/restore'),
      agentDefinitionId: 'agent-restore',
    },
  ])

  const { definition: redef } = await fixtureDefinition(
    scenario,
    'agent-restore',
  )
  const reagent = await rebuilt.spawnAgent(redef)
  await rebuilt.loadSession(reagent.agentId, 'sess-restore', {})

  expect(rebuilt.getSession('sess-restore')?.status).toBe('active')
})

test('restoreSessions drops unserializable stored events with a diagnostic', async () => {
  const poisoned: AcpEvent = {
    sessionId: 'sess-poison',
    seq: 1,
    ts: 0,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'ok' } },
  }
  const bad = {
    ...poisoned,
    seq: 2,
    payload: { content: () => 'not cloneable' },
  } as unknown as AcpEvent
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta() {},
    listSessions: () => [{ sessionId: 'sess-poison' }],
    loadEvents: () => [poisoned, bad],
  }
  const host = trackHost(createAcpHost({ storage }))
  const hostEvents = collectEvents(host, undefined)

  const restored = await host.restoreSessions()

  expect(restored).toEqual([
    { sessionId: 'sess-poison', status: 'disconnected' },
  ])
  const replayed = collectEvents(host, 'sess-poison') as AcpSessionEvent[]
  expect(replayed.map((event) => event.type)).toEqual([
    'agent-message-chunk',
    'session-status-change',
  ])
  const diag = diagnosticPayloads(hostEvents, 'event/unserializable').at(0)
  expect(diag?.sessionId).toBe('sess-poison')
})

test('memory storage is the default and supports listSessions/loadEvents', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-mem' },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, { cwd: '/tmp' })

  const stored = await host.options.storage.loadEvents('sess-mem')
  expect(stored.length).toBeGreaterThan(0)
  expect(await host.options.storage.listSessions()).toEqual([
    {
      sessionId: 'sess-mem',
      agentDefinitionId: 'fixture',
      cwd: resolve('/tmp'),
    },
  ])
})

test('restoreSessions announces each rebuilt session as session-created with disconnected status', async () => {
  const stored: AcpEvent = {
    sessionId: 'sess-restored',
    seq: 1,
    ts: 0,
    type: 'session-status-change',
    payload: { status: 'disconnected' },
  }
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta() {},
    listSessions: () => [
      { sessionId: 'sess-restored' },
      { sessionId: 'sess-empty' },
    ],
    loadEvents: (sessionId) => (sessionId === 'sess-restored' ? [stored] : []),
  }
  const host = trackHost(createAcpHost({ storage }))
  const hostEvents = collectEvents(host, undefined)

  await host.restoreSessions()

  const announces = hostEvents.filter(
    (event) => event.type === 'session-created',
  )
  expect(announces.map((event) => event.payload)).toEqual([
    { sessionId: 'sess-restored', status: 'disconnected' },
    { sessionId: 'sess-empty', status: 'disconnected' },
  ])
})

test('session announce events never enter the session log nor the storage adapter', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-clean' },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, { cwd: '/tmp' })
  const sessionEvents = collectEvents(host, 'sess-clean')
  await host.closeSession('sess-clean')

  const announceTypes = ['session-created', 'session-closed']
  expect(
    sessionEvents.some((event) => announceTypes.includes(event.type)),
  ).toBe(false)
  expect(await host.options.storage.listSessions()).toEqual([
    {
      sessionId: 'sess-clean',
      agentDefinitionId: 'fixture',
      cwd: resolve('/tmp'),
    },
  ])
  const persisted = await host.options.storage.loadEvents('sess-clean')
  expect(persisted.length).toBeGreaterThan(0)
  expect(persisted.some((event) => announceTypes.includes(event.type))).toBe(
    false,
  )
})
