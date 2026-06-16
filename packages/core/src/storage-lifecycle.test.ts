import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from 'vitest'

import {
  createAcpHost,
  createJsonlStorage,
  type StorageAdapter,
} from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  sessionParams,
  trackHost,
} from './test-harness.ts'

import type { AcpSessionEvent } from '@acpjs/protocol'

test('closeSession rejects when the lifecycle tombstone cannot be committed', async () => {
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta(meta) {
      if (meta.lifecycle === 'closed') throw new Error('tombstone failed')
    },
    listSessions: () => [],
    loadEvents: () => [],
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-close-commit' },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))

  await expect(host.closeSession('sess-close-commit')).rejects.toThrow(
    'tombstone failed',
  )
  expect(host.getSession('sess-close-commit')?.status).toBe('active')
})

test('restoreSessions skips closed and deleted lifecycle metadata', async () => {
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta() {},
    listSessions: () => [
      {
        sessionId: 'sess-closed',
        cwd: '/tmp',
        additionalDirectories: [],
        lifecycle: 'closed',
      },
      {
        sessionId: 'sess-deleted',
        cwd: '/tmp',
        additionalDirectories: [],
        lifecycle: 'deleted',
      },
    ],
    loadEvents: () => [],
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))

  const restored = await host.restoreSessions()

  expect(restored).toEqual([])
  expect(host.getSessions()).toEqual([])
})

test('JSONL storage ignores malformed lines during restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-jsonl-bad-line-'))
  const file = join(dir, 'events.jsonl')
  await writeFile(
    file,
    [
      JSON.stringify({
        kind: 'session-meta',
        sessionId: 'sess-good',
        cwd: '/tmp',
        additionalDirectories: [],
        lifecycle: 'open',
      }),
      '{"broken"',
      JSON.stringify({
        sessionId: 'sess-good',
        seq: 1,
        ts: 0,
        type: 'agent-message-chunk',
        payload: { content: { type: 'text', text: 'ok' } },
      }),
      '',
    ].join('\n'),
    'utf8',
  )
  const host = trackHost(createAcpHost({ storage: createJsonlStorage(file) }))

  const restored = await host.restoreSessions()

  expect(restored.map((session) => session.sessionId)).toEqual(['sess-good'])
})

test('loadSession rejects without publishing replay when atomic storage replace fails', async () => {
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta() {},
    listSessions: () => [],
    loadEvents: () => [],
    replaceSession() {
      throw new Error('replace failed')
    },
  }
  const host = trackHost(createAcpHost({ storage }))
  const { definition } = await fixtureDefinition({
    initialize: { agentCapabilities: { loadSession: true } },
    session: { sessionId: 'sess-load-replace-fail' },
    loadSession: {
      replay: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'loaded' },
        },
      ],
    },
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp/original'))
  const events = collectEvents(
    host,
    'sess-load-replace-fail',
  ) as AcpSessionEvent[]

  const error = await rejectionOf(
    host.loadSession(
      agent.agentId,
      'sess-load-replace-fail',
      sessionParams('/tmp/loaded'),
    ),
  )

  expect(error).toMatchObject({ message: 'replace failed' })
  expect(host.getSession('sess-load-replace-fail')?.status).toBe('active')
  expect(host.getSession('sess-load-replace-fail')?.cwd).toBe(
    resolve('/tmp/original'),
  )
  expect(events.some((event) => event.type === 'session-reset')).toBe(false)
  expect(
    events.some(
      (event) =>
        event.type === 'agent-message-chunk' &&
        event.payload.content.text === 'loaded',
    ),
  ).toBe(false)
})

test('dispose waits for async session-info metadata writes', async () => {
  let infoMetaStarted = false
  let infoMetaFinished = false
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta(meta) {
      if (meta.title !== 'Flushed title') return
      infoMetaStarted = true
      return new Promise<void>((resolvePromise) => {
        setTimeout(() => {
          infoMetaFinished = true
          resolvePromise()
        }, 50)
      })
    },
    listSessions: () => [],
    loadEvents: () => [],
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-info-flush' },
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'session_info_update',
              title: 'Flushed title',
            },
          },
        ],
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  await host.createSession(agent.agentId, sessionParams('/tmp'))
  await host.prompt('sess-info-flush', [{ type: 'text', text: 'go' }])

  expect(infoMetaStarted).toBe(true)
  expect(infoMetaFinished).toBe(false)
  await host.dispose()
  expect(infoMetaFinished).toBe(true)
})
