import { expect, test } from 'vitest'

import { createRegistryClient } from './index.ts'
import { jsonFetch, makeIndex, makeTmpDir } from './test-support.ts'

import type { AcpHostEvent } from '@acpjs/protocol'

function collect(client: {
  subscribe(listener: (event: AcpHostEvent) => void): () => void
}): AcpHostEvent[] {
  const events: AcpHostEvent[] = []
  client.subscribe((event) => events.push(event))
  return events
}

function stages(events: AcpHostEvent[]): string[] {
  return events
    .filter((event) => event.type === 'install-progress')
    .map((event) => event.payload.stage)
}

test('ensureInstalled rejects registry/platform-unsupported when no binary matches the platform', async () => {
  const cacheDir = await makeTmpDir()
  const entry = {
    id: 'codex-acp',
    name: 'Codex CLI',
    version: '0.16.0',
    description: 'ACP adapter',
    distribution: {
      binary: {
        'darwin-aarch64': {
          archive: 'https://example.com/codex-acp-darwin-aarch64.tar.gz',
          cmd: './codex-acp',
        },
      },
    },
  }
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([entry])),
    platform: 'linux',
    arch: 'x64',
    pathProbe: () => Promise.resolve(undefined),
  })
  const events = collect(client)

  await expect(client.ensureInstalled('codex-acp')).rejects.toMatchObject({
    code: 'registry/platform-unsupported',
  })
  expect(stages(events)).toEqual(['resolving', 'failed'])
})

test('an unrecognized platform/arch pair resolves no platform key and fails the same way', async () => {
  const cacheDir = await makeTmpDir()
  const entry = {
    id: 'codex-acp',
    name: 'Codex CLI',
    version: '0.16.0',
    description: 'ACP adapter',
    distribution: {
      binary: {
        'darwin-aarch64': {
          archive: 'https://example.com/codex-acp-darwin-aarch64.tar.gz',
          cmd: './codex-acp',
        },
      },
    },
  }
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([entry])),
    platform: 'sunos',
    arch: 'mips',
    pathProbe: () => Promise.resolve(undefined),
  })

  await expect(client.ensureInstalled('codex-acp')).rejects.toMatchObject({
    code: 'registry/platform-unsupported',
  })
  await expect(client.getInstallArtifact('codex-acp')).resolves.toBeUndefined()
})
