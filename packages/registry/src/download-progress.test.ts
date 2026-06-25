import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { createRegistryClient, DEFAULT_INDEX_URL } from './index.ts'
import { installBinary } from './installer.ts'
import {
  binaryResponse,
  chunkedResponse,
  makeIndex,
  makeTmpDir,
  routedFetch,
} from './test-support.ts'

import type { AcpjsHostEvent, InstallProgressPayload } from '@acpjs/protocol'

import type { BinaryTarget, RegistryEntry } from './types.ts'

const noHit = () => Promise.resolve(undefined)

const rawEntry = {
  id: 'grok-build',
  name: 'Grok Build',
  version: '2.0.0',
  description: 'raw exe agent',
  distribution: {
    binary: {
      'windows-aarch64': {
        archive: 'https://example.com/grok-build-win-arm64.exe',
        cmd: './grok-build.exe',
        args: ['acp'],
      },
    },
  },
}

function collect(client: {
  subscribe(listener: (event: AcpjsHostEvent) => void): () => void
}): AcpjsHostEvent[] {
  const events: AcpjsHostEvent[] = []
  client.subscribe((event) => events.push(event))
  return events
}

function downloadingProgress(
  events: AcpjsHostEvent[],
): InstallProgressPayload[] {
  return events
    .filter((event) => event.type === 'install-progress')
    .map((event) => event.payload)
    .filter(
      (payload) =>
        payload.stage === 'downloading' &&
        payload.downloadedBytes !== undefined,
    )
}

function bodyless(): Response {
  const response = binaryResponse(Buffer.from('MZ raw binary'))
  Object.defineProperty(response, 'body', { value: null })
  return response
}

test('ensureInstalled streams downloadedBytes monotonically up to a content-length total', async () => {
  const cacheDir = await makeTmpDir()
  const payload = Buffer.from('MZ '.repeat(40))
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([rawEntry])),
      'https://example.com/grok-build-win-arm64.exe': () =>
        chunkedResponse(payload, 32),
    }),
    platform: 'win32',
    arch: 'arm64',
    pathProbe: noHit,
  })
  const events = collect(client)

  await client.ensureInstalled('grok-build')

  const progress = downloadingProgress(events)
  expect(progress.length).toBeGreaterThan(1)
  const bytes = progress.map((p) => p.downloadedBytes)
  for (let i = 1; i < bytes.length; i += 1) {
    expect(bytes[i]!).toBeGreaterThan(bytes[i - 1]!)
  }
  expect(bytes.at(-1)).toBe(payload.length)
  for (const p of progress) {
    expect(p.totalBytes).toBe(payload.length)
    expect(p.version).toBe('2.0.0')
    expect(p.platform).toBe('windows-aarch64')
  }
})

test('ensureInstalled emits downloadedBytes but omits totalBytes when content-length is absent', async () => {
  const cacheDir = await makeTmpDir()
  const payload = Buffer.from('MZ '.repeat(40))
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([rawEntry])),
      'https://example.com/grok-build-win-arm64.exe': () =>
        chunkedResponse(payload, 32, { contentLength: false }),
    }),
    platform: 'win32',
    arch: 'arm64',
    pathProbe: noHit,
  })
  const events = collect(client)

  await client.ensureInstalled('grok-build')

  const progress = downloadingProgress(events)
  expect(progress.length).toBeGreaterThan(1)
  expect(progress.at(-1)!.downloadedBytes).toBe(payload.length)
  for (const p of progress) {
    expect(p.totalBytes).toBeUndefined()
    expect('totalBytes' in p).toBe(false)
  }
})

test('ensureInstalled falls back to the full body when the response stream is absent', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([rawEntry])),
      'https://example.com/grok-build-win-arm64.exe': bodyless,
    }),
    platform: 'win32',
    arch: 'arm64',
    pathProbe: noHit,
  })
  const events = collect(client)

  const definition = await client.ensureInstalled('grok-build')

  const expectedPath = join(
    cacheDir,
    'agents',
    'grok-build',
    '2.0.0',
    'windows-aarch64',
    'contents',
    'grok-build.exe',
  )
  expect(definition.command).toBe(expectedPath)
  await expect(readFile(expectedPath, 'utf8')).resolves.toBe('MZ raw binary')
  expect(downloadingProgress(events)).toEqual([])
})

test('ensureInstalled skips empty chunks, keeping downloadedBytes strictly monotonic', async () => {
  const cacheDir = await makeTmpDir()
  const parts = [
    Buffer.from('MZ '),
    Buffer.from(''),
    Buffer.from('raw '),
    Buffer.from(''),
    Buffer.from('binary'),
  ]
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([rawEntry])),
      'https://example.com/grok-build-win-arm64.exe': () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const part of parts) {
                controller.enqueue(Uint8Array.from(part))
              }
              controller.close()
            },
          }),
        ),
    }),
    platform: 'win32',
    arch: 'arm64',
    pathProbe: noHit,
  })
  const events = collect(client)

  await client.ensureInstalled('grok-build')

  const progress = downloadingProgress(events)
  const bytes = progress.map((p) => p.downloadedBytes)
  expect(progress.length).toBe(3)
  for (let i = 1; i < bytes.length; i += 1) {
    expect(bytes[i]!).toBeGreaterThan(bytes[i - 1]!)
  }
  expect(bytes.at(-1)).toBe(Buffer.concat(parts).length)
})

test('installBinary aborts and leaves no cache when the download exceeds the byte cap', async () => {
  const cacheDir = await makeTmpDir()
  const entry: RegistryEntry = {
    id: 'grok-build',
    name: 'Grok Build',
    version: '2.0.0',
    description: 'raw exe agent',
    distribution: {},
  }
  const target: BinaryTarget = {
    archive: 'https://example.com/grok-build-win-arm64.exe',
    cmd: './grok-build.exe',
  }
  await expect(
    installBinary(
      {
        cacheDir,
        fetchImpl: () =>
          Promise.resolve(chunkedResponse(Buffer.alloc(256), 32)),
        now: () => 0,
        emitProgress() {},
        maxDownloadBytes: 64,
      },
      'grok-build',
      entry,
      'windows-aarch64',
      target,
    ),
  ).rejects.toMatchObject({ code: 'registry/download-failed' })

  await expect(stat(join(cacheDir, 'agents', 'grok-build'))).rejects.toThrow()
})
