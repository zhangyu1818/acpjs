import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { createRegistryClient } from './index.ts'
import {
  claudeEntry,
  jsonFetch,
  makeIndex,
  makeTmpDir,
} from './test-support.ts'

import type { AcpHostEvent } from '@acpjs/protocol'

test('getIndex within the TTL serves the disk cache without refetching, across client instances', async () => {
  const cacheDir = await makeTmpDir()
  const calls: string[] = []
  const fetch = jsonFetch(makeIndex([claudeEntry]), calls)
  let nowMs = 1_000_000

  const first = createRegistryClient({ cacheDir, fetch, now: () => nowMs })
  await first.getIndex()

  nowMs += 3_599_000
  const second = createRegistryClient({ cacheDir, fetch, now: () => nowMs })
  const index = await second.getIndex()

  expect(calls).toHaveLength(1)
  expect(index.entries.map((entry) => entry.id)).toEqual(['claude-acp'])
})

test('getIndex refetches once the TTL has elapsed', async () => {
  const cacheDir = await makeTmpDir()
  const calls: string[] = []
  const fetch = jsonFetch(makeIndex([claudeEntry]), calls)
  let nowMs = 1_000_000
  const client = createRegistryClient({ cacheDir, fetch, now: () => nowMs })

  await client.getIndex()
  nowMs += 3_600_000
  await client.getIndex()

  expect(calls).toHaveLength(2)
})

test('getIndex falls back to the stale cache on network failure and emits a warn diagnostic', async () => {
  const cacheDir = await makeTmpDir()
  let nowMs = 1_000_000
  const warm = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([claudeEntry])),
    now: () => nowMs,
  })
  await warm.getIndex()

  nowMs += 7_200_000
  const client = createRegistryClient({
    cacheDir,
    fetch: () => Promise.reject(new Error('offline')),
    now: () => nowMs,
  })
  const events: AcpHostEvent[] = []
  client.subscribe((event) => events.push(event))

  const index = await client.getIndex()

  expect(index.entries.map((entry) => entry.id)).toEqual(['claude-acp'])
  expect(events).toEqual([
    {
      seq: 1,
      ts: nowMs,
      type: 'diagnostic',
      payload: {
        level: 'warn',
        code: 'registry/index-stale-fallback',
        message: expect.stringContaining('offline') as string,
      },
    },
  ])
})

test('getIndex with no cache rejects with registry/index-unavailable on network failure', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: () => Promise.reject(new Error('offline')),
  })

  await expect(client.getIndex()).rejects.toMatchObject({
    name: 'RegistryError',
    code: 'registry/index-unavailable',
  })
})

test('getIndex skips unparseable entries with a diagnostic instead of failing the whole index', async () => {
  const cacheDir = await makeTmpDir()
  const badEntry = {
    id: 'broken-agent',
    name: 'Broken',
    version: '1.0.0',
    distribution: { npx: { package: 'broken' } },
  }
  const oddButValid = { ...claudeEntry, somethingNew: { nested: true } }
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([badEntry, oddButValid])),
    now: () => 42,
  })
  const events: AcpHostEvent[] = []
  client.subscribe((event) => events.push(event))

  const index = await client.getIndex()

  expect(index.entries.map((entry) => entry.id)).toEqual(['claude-acp'])
  expect(events).toEqual([
    {
      seq: 1,
      ts: 42,
      type: 'diagnostic',
      payload: {
        level: 'warn',
        code: 'registry/entry-invalid',
        message: expect.stringContaining('broken-agent') as string,
        data: { id: 'broken-agent' },
      },
    },
  ])
})

test('getIndex fetches the registry index from the CDN URL and returns parsed entries', async () => {
  const cacheDir = await makeTmpDir()
  const calls: string[] = []
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([claudeEntry]), calls),
  })

  const index = await client.getIndex()

  expect(calls).toEqual([
    'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
  ])
  expect(index.version).toBe('1.0.0')
  expect(index.entries).toEqual([
    {
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '0.44.0',
      description: "ACP wrapper for Anthropic's Claude",
      repository: 'https://github.com/agentclientprotocol/claude-agent-acp',
      authors: ['Anthropic', 'Zed Industries', 'JetBrains'],
      license: 'proprietary',
      distribution: {
        npx: { package: '@agentclientprotocol/claude-agent-acp@0.44.0' },
      },
      icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg',
    },
  ])
})

test('getIndex with no cache rejects with registry/index-unavailable on a non-2xx response', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
  })

  await expect(client.getIndex()).rejects.toMatchObject({
    code: 'registry/index-unavailable',
    message: expect.stringContaining('status 503'),
  })
})

test('a corrupt index cache file is ignored and the index is refetched', async () => {
  const cacheDir = await makeTmpDir()
  await writeFile(join(cacheDir, 'registry-index.json'), '{not json', 'utf8')
  const calls: string[] = []
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([claudeEntry]), calls),
  })

  const index = await client.getIndex()

  expect(index.entries.map((entry) => entry.id)).toEqual(['claude-acp'])
  expect(calls).toHaveLength(1)
})
