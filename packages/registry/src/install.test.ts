import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { createRegistryClient, DEFAULT_INDEX_URL } from './index.ts'
import {
  binaryResponse,
  claudeEntry,
  jsonFetch,
  makeIndex,
  makeStoredZip,
  makeTarGz,
  makeTmpDir,
  routedFetch,
} from './test-support.ts'

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
    .filter((stage, index, all) => stage !== all[index - 1])
}

const codexEntry = {
  id: 'codex-acp',
  name: 'Codex CLI',
  version: '0.16.0',
  description: 'ACP adapter',
  distribution: {
    binary: {
      'darwin-aarch64': {
        archive: 'https://example.com/codex-acp-darwin-aarch64.tar.gz',
        cmd: './codex-acp',
        args: ['acp'],
        env: { CODEX_MODE: 'acp' },
      },
    },
    npx: { package: '@zed-industries/codex-acp@0.16.0' },
  },
}

test('ensureInstalled uses an executable already on PATH before direct-run or download', async () => {
  const cacheDir = await makeTmpDir()
  const probed: string[][] = []
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([codexEntry])),
    platform: 'darwin',
    arch: 'arm64',
    pathProbe(candidates) {
      probed.push(candidates)
      return Promise.resolve('/usr/local/bin/codex-acp')
    },
  })
  const events = collect(client)

  const definition = await client.ensureInstalled('codex-acp')

  expect(probed).toEqual([['codex-acp']])
  expect(definition).toEqual({
    id: 'codex-acp',
    command: '/usr/local/bin/codex-acp',
    args: ['acp'],
    env: { CODEX_MODE: 'acp' },
    meta: { name: 'Codex CLI', version: '0.16.0', registryId: 'codex-acp' },
  })
  expect(stages(events)).toEqual(['resolving', 'installed'])
})

const noHit = () => Promise.resolve(undefined)

test('ensureInstalled resolves an npx distribution to a direct-run definition', async () => {
  const cacheDir = await makeTmpDir()
  const entry = {
    ...claudeEntry,
    distribution: {
      npx: {
        package: '@augmentcode/auggie@0.29.0',
        args: ['--acp'],
        env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
      },
    },
  }
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([entry])),
    pathProbe: noHit,
  })
  const events = collect(client)

  const definition = await client.ensureInstalled('claude-acp')

  expect(definition).toMatchObject({
    id: 'claude-acp',
    command: 'npx',
    args: ['@augmentcode/auggie@0.29.0', '--acp'],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  })
  expect(stages(events)).toEqual(['resolving', 'installed'])
})

test('ensureInstalled resolves a uvx distribution to a direct-run definition', async () => {
  const cacheDir = await makeTmpDir()
  const entry = {
    id: 'fast-agent',
    name: 'fast-agent',
    version: '0.7.16',
    description: 'uvx agent',
    distribution: {
      uvx: { package: 'fast-agent-acp==0.7.16', args: ['-x'] },
    },
  }
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([entry])),
    pathProbe: noHit,
  })

  const definition = await client.ensureInstalled('fast-agent')

  expect(definition).toMatchObject({
    id: 'fast-agent',
    command: 'uvx',
    args: ['fast-agent-acp==0.7.16', '-x'],
  })
  expect(definition.env).toBeUndefined()
})

const binaryOnlyEntry = {
  ...codexEntry,
  distribution: { binary: codexEntry.distribution.binary },
}

test('ensureInstalled downloads, extracts, and chmods a tar.gz binary distribution into the versioned cache', async () => {
  const cacheDir = await makeTmpDir()
  const archive = await makeTarGz({ 'codex-acp': '#!/bin/sh\necho hi\n' })
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([binaryOnlyEntry])),
      'https://example.com/codex-acp-darwin-aarch64.tar.gz': () =>
        binaryResponse(archive),
    }),
    platform: 'darwin',
    arch: 'arm64',
    pathProbe: noHit,
    now: () => 7_000,
  })
  const events = collect(client)

  const definition = await client.ensureInstalled('codex-acp')

  const expectedPath = join(
    cacheDir,
    'agents',
    'codex-acp',
    '0.16.0',
    'darwin-aarch64',
    'contents',
    'codex-acp',
  )
  expect(definition).toMatchObject({
    id: 'codex-acp',
    command: expectedPath,
    args: ['acp'],
    env: { CODEX_MODE: 'acp' },
  })
  await expect(readFile(expectedPath, 'utf8')).resolves.toContain('echo hi')
  const fileInfo = await stat(expectedPath)
  expect(fileInfo.mode & 0o111).not.toBe(0)
  expect(stages(events)).toEqual([
    'resolving',
    'downloading',
    'extracting',
    'installed',
  ])
})

test('ensureInstalled skips the download on a versioned cache hit', async () => {
  const cacheDir = await makeTmpDir()
  const archive = await makeTarGz({ 'codex-acp': 'binary' })
  let downloads = 0
  const fetch = routedFetch({
    [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([binaryOnlyEntry])),
    'https://example.com/codex-acp-darwin-aarch64.tar.gz': () => {
      downloads += 1
      return binaryResponse(archive)
    },
  })
  const makeClient = () =>
    createRegistryClient({
      cacheDir,
      fetch,
      platform: 'darwin',
      arch: 'arm64',
      pathProbe: noHit,
    })

  const first = await makeClient().ensureInstalled('codex-acp')
  const second = makeClient()
  const events = collect(second)
  const definition = await second.ensureInstalled('codex-acp')

  expect(downloads).toBe(1)
  expect(definition).toEqual(first)
  expect(stages(events)).toEqual(['resolving', 'cache-hit', 'installed'])
})

test('ensureInstalled maps win32/arm64 to windows-aarch64 and writes a raw .exe without extraction', async () => {
  const cacheDir = await makeTmpDir()
  const entry = {
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
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([entry])),
      'https://example.com/grok-build-win-arm64.exe': () =>
        binaryResponse(Buffer.from('MZ raw binary')),
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
  expect(definition).toMatchObject({
    command: expectedPath,
    args: ['acp'],
  })
  await expect(readFile(expectedPath, 'utf8')).resolves.toBe('MZ raw binary')
  expect(stages(events)).toEqual(['resolving', 'downloading', 'installed'])
})

test('ensureInstalled extracts a zip archive and resolves a nested cmd path', async () => {
  const cacheDir = await makeTmpDir()
  const entry = {
    id: 'cursor',
    name: 'Cursor Agent',
    version: '3.1.0',
    description: 'nested cmd agent',
    distribution: {
      binary: {
        'linux-x86_64': {
          archive: 'https://example.com/agent-cli-package.zip',
          cmd: './dist-package/cursor-agent',
          args: ['acp'],
        },
      },
    },
  }
  const zip = makeStoredZip({
    'dist-package/': '',
    'dist-package/cursor-agent': '#!/bin/sh\nnested\n',
    'dist-package/lib/helper.txt': 'helper',
  })
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([entry])),
      'https://example.com/agent-cli-package.zip': () => binaryResponse(zip),
    }),
    platform: 'linux',
    arch: 'x64',
    pathProbe: noHit,
  })
  const events = collect(client)

  const definition = await client.ensureInstalled('cursor')

  const expectedPath = join(
    cacheDir,
    'agents',
    'cursor',
    '3.1.0',
    'linux-x86_64',
    'contents',
    'dist-package',
    'cursor-agent',
  )
  expect(definition.command).toBe(expectedPath)
  await expect(readFile(expectedPath, 'utf8')).resolves.toContain('nested')
  const fileInfo = await stat(expectedPath)
  expect(fileInfo.mode & 0o111).not.toBe(0)
  expect(stages(events)).toEqual([
    'resolving',
    'downloading',
    'extracting',
    'installed',
  ])
})

test('ensureInstalled emits failed and leaves no partial cache when the download fails', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([binaryOnlyEntry])),
      'https://example.com/codex-acp-darwin-aarch64.tar.gz': () =>
        new Response('nope', { status: 500 }),
    }),
    platform: 'darwin',
    arch: 'arm64',
    pathProbe: noHit,
  })
  const events = collect(client)

  await expect(client.ensureInstalled('codex-acp')).rejects.toMatchObject({
    code: 'registry/download-failed',
  })

  expect(stages(events)).toEqual(['resolving', 'downloading', 'failed'])
  await expect(stat(join(cacheDir, 'agents', 'codex-acp'))).rejects.toThrow()
})

test('ensureInstalled rejects installer archive formats without downloading or leaving residue', async () => {
  const cacheDir = await makeTmpDir()
  const entry = {
    ...binaryOnlyEntry,
    distribution: {
      binary: {
        'darwin-aarch64': {
          archive: 'https://example.com/codex.dmg',
          cmd: './codex-acp',
        },
      },
    },
  }
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([entry])),
    }),
    platform: 'darwin',
    arch: 'arm64',
    pathProbe: noHit,
  })
  const events = collect(client)

  await expect(client.ensureInstalled('codex-acp')).rejects.toMatchObject({
    code: 'registry/unsupported-archive',
  })

  expect(stages(events)).toEqual(['resolving', 'failed'])
  await expect(stat(join(cacheDir, 'agents', 'codex-acp'))).rejects.toThrow()
})

test('ensureInstalled fails with install-failed and leaves no partial cache when the extracted archive lacks the cmd', async () => {
  const cacheDir = await makeTmpDir()
  const archive = await makeTarGz({ 'something-else': 'not the cmd' })
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([binaryOnlyEntry])),
      'https://example.com/codex-acp-darwin-aarch64.tar.gz': () =>
        binaryResponse(archive),
    }),
    platform: 'darwin',
    arch: 'arm64',
    pathProbe: noHit,
  })
  const events = collect(client)

  await expect(client.ensureInstalled('codex-acp')).rejects.toMatchObject({
    code: 'registry/install-failed',
  })

  expect(stages(events)).toEqual([
    'resolving',
    'downloading',
    'extracting',
    'failed',
  ])
  await expect(
    stat(join(cacheDir, 'agents', 'codex-acp', '0.16.0', 'darwin-aarch64')),
  ).rejects.toThrow()
})

test('getInstallArtifact returns the persisted artifact after a binary install', async () => {
  const cacheDir = await makeTmpDir()
  const archive = await makeTarGz({ 'codex-acp': 'binary' })
  const client = createRegistryClient({
    cacheDir,
    fetch: routedFetch({
      [DEFAULT_INDEX_URL]: () => Response.json(makeIndex([binaryOnlyEntry])),
      'https://example.com/codex-acp-darwin-aarch64.tar.gz': () =>
        binaryResponse(archive),
    }),
    platform: 'darwin',
    arch: 'arm64',
    pathProbe: noHit,
    now: () => 123_456,
  })

  await expect(client.getInstallArtifact('codex-acp')).resolves.toBeUndefined()
  const definition = await client.ensureInstalled('codex-acp')
  await expect(client.getInstallArtifact('codex-acp')).resolves.toEqual({
    agentId: 'codex-acp',
    version: '0.16.0',
    platform: 'darwin-aarch64',
    executablePath: definition.command,
    installedAt: 123_456,
  })
})

test('ensureInstalled fails with platform-unsupported when no binary target matches the host platform', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([binaryOnlyEntry])),
    platform: 'linux',
    arch: 'x64',
    pathProbe: noHit,
  })
  const events = collect(client)

  await expect(client.ensureInstalled('codex-acp')).rejects.toMatchObject({
    code: 'registry/platform-unsupported',
  })
  expect(stages(events)).toEqual(['resolving', 'failed'])
})

test('ensureInstalled fails with agent-not-found for ids missing from the index', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([claudeEntry])),
    pathProbe: noHit,
  })

  await expect(client.ensureInstalled('missing-agent')).rejects.toMatchObject({
    code: 'registry/agent-not-found',
  })
})

test('a throwing subscriber does not break event delivery to other subscribers', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: () => Promise.reject(new Error('must not fetch')),
  })
  client.subscribe(() => {
    throw new Error('listener boom')
  })
  const events = collect(client)

  await client.ensureInstalled('any', { command: '/bin/agent' })

  expect(stages(events)).toEqual(['resolving', 'installed'])
  expect(events.map((event) => event.seq)).toEqual([1, 2])
})

test('ensureInstalled prefers an explicitly provided command without touching the index', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: () => Promise.reject(new Error('must not fetch')),
  })
  const events = collect(client)

  const definition = await client.ensureInstalled('claude-acp', {
    command: '/opt/agents/claude',
    args: ['--acp'],
    env: { FOO: 'bar' },
  })

  expect(definition).toEqual({
    id: 'claude-acp',
    command: '/opt/agents/claude',
    args: ['--acp'],
    env: { FOO: 'bar' },
  })
  expect(stages(events)).toEqual(['resolving', 'installed'])
})
