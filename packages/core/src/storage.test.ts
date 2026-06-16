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
  sessionParams,
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
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
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
    additionalDirectories: [],
  })
  await storage.appendMeta({
    sessionId: 'sess-b',
    cwd: '',
    additionalDirectories: [],
  })

  expect(await storage.listSessions()).toEqual([
    {
      sessionId: 'sess-a',
      agentDefinitionId: 'agent-x',
      cwd: '/work',
      additionalDirectories: [],
    },
    { sessionId: 'sess-b', cwd: '', additionalDirectories: [] },
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
  await host.createSession(agent.agentId, sessionParams('/tmp/work'))

  expect(await host.options.storage.listSessions()).toEqual([
    {
      sessionId: 'sess-meta',
      agentDefinitionId: 'agent-meta',
      cwd: resolve('/tmp/work'),
      mcpServers: [],
      additionalDirectories: [],
      lifecycle: 'open',
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
  await host.createSession(agent.agentId, sessionParams('/tmp/jwork'))

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
      mcpServers: [],
      additionalDirectories: [],
      lifecycle: 'open',
    },
  ])
  const replayed = await reader.loadEvents('sess-jsonl-meta')
  expect(replayed.length).toBeGreaterThan(0)
  expect(replayed.some((event) => 'kind' in event)).toBe(false)
})

test('closeSession waits for the JSONL tombstone meta before returning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-jsonl-close-'))
  const file = join(dir, 'events.jsonl')
  const host = trackHost(createAcpHost({ storage: createJsonlStorage(file) }))
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-jsonl-close' },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp/closed'))

  await host.closeSession('sess-jsonl-close')

  expect(await createJsonlStorage(file).listSessions()).toEqual([
    {
      sessionId: 'sess-jsonl-close',
      agentDefinitionId: 'fixture',
      cwd: resolve('/tmp/closed'),
      mcpServers: [],
      additionalDirectories: [],
      lifecycle: 'closed',
    },
  ])
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
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-meta-fail' },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))
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
    replaceSession() {
      throw new Error('replace disk on fire')
    },
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
    async replaceSession() {
      throw new Error('async replace failure')
    },
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
      mcpServers: [],
      additionalDirectories: [],
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

test('JSONL restore backfills cwd and agentDefinitionId and loadSession requires fresh config', async () => {
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
  const created = await host.createSession(
    agent.agentId,
    sessionParams('/tmp/restore'),
  )
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
      mcpServers: [],
      additionalDirectories: [],
      agentDefinitionId: 'agent-restore',
    },
  ])

  const { definition: redef } = await fixtureDefinition(
    scenario,
    'agent-restore',
  )
  const reagent = await rebuilt.spawnAgent(redef)
  await rebuilt.loadSession(
    reagent.agentId,
    'sess-restore',
    sessionParams('/tmp/restore'),
  )

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
    listSessions: () => [
      { sessionId: 'sess-poison', cwd: '', additionalDirectories: [] },
    ],
    loadEvents: () => [poisoned, bad],
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const hostEvents = collectEvents(host, undefined)

  const restored = await host.restoreSessions()

  expect(restored).toEqual([
    {
      sessionId: 'sess-poison',
      status: 'disconnected',
      cwd: '',
      additionalDirectories: [],
    },
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
  await host.createSession(agent.agentId, sessionParams('/tmp'))

  const stored = await host.options.storage.loadEvents('sess-mem')
  expect(stored.length).toBeGreaterThan(0)
  expect(await host.options.storage.listSessions()).toEqual([
    {
      sessionId: 'sess-mem',
      agentDefinitionId: 'fixture',
      cwd: resolve('/tmp'),
      mcpServers: [],
      additionalDirectories: [],
      lifecycle: 'open',
    },
  ])
})

test('restoreSessions publishes session-updated projections for rebuilt disconnected sessions', async () => {
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
      { sessionId: 'sess-restored', cwd: '', additionalDirectories: [] },
      { sessionId: 'sess-empty', cwd: '', additionalDirectories: [] },
    ],
    loadEvents: (sessionId) => (sessionId === 'sess-restored' ? [stored] : []),
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const hostEvents = collectEvents(host, undefined)

  await host.restoreSessions()

  const projections = hostEvents.filter(
    (event) => event.type === 'session-updated',
  )
  expect(projections.map((event) => event.payload)).toEqual([
    {
      sessionId: 'sess-restored',
      status: 'disconnected',
      cwd: '',
      additionalDirectories: [],
    },
    {
      sessionId: 'sess-empty',
      status: 'disconnected',
      cwd: '',
      additionalDirectories: [],
    },
  ])
})

test('session projection events never enter the session log nor the storage adapter', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: { sessionCapabilities: { close: {} } },
    },
    session: { sessionId: 'sess-clean' },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))
  const sessionEvents = collectEvents(host, 'sess-clean')
  await host.closeSession('sess-clean')

  const projectionTypes = ['session-updated']
  expect(
    sessionEvents.some((event) => projectionTypes.includes(event.type)),
  ).toBe(false)
  expect(await host.options.storage.listSessions()).toEqual([
    {
      sessionId: 'sess-clean',
      agentDefinitionId: 'fixture',
      cwd: resolve('/tmp'),
      mcpServers: [],
      additionalDirectories: [],
      lifecycle: 'closed',
    },
  ])
  const persisted = await host.options.storage.loadEvents('sess-clean')
  expect(persisted.length).toBeGreaterThan(0)
  expect(persisted.some((event) => projectionTypes.includes(event.type))).toBe(
    false,
  )
})
