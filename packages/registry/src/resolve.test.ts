import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, test, vi } from 'vitest'

import { createRegistryClient } from './index.ts'
import {
  claudeEntry,
  jsonFetch,
  makeIndex,
  makeTmpDir,
} from './test-support.ts'

test('the default PATH probe finds an executable agent binary on PATH', async () => {
  const cacheDir = await makeTmpDir()
  const binDir = await makeTmpDir()
  const executable = join(binDir, 'codex-probe')
  await writeFile(executable, '#!/bin/sh\n')
  await chmod(executable, 0o755)
  vi.stubEnv('PATH', binDir)
  try {
    const entry = {
      id: 'codex-probe',
      name: 'Codex Probe',
      version: '1.0.0',
      description: 'probe target',
      distribution: { npx: { package: 'codex-probe@1.0.0', args: ['--acp'] } },
    }
    const client = createRegistryClient({
      cacheDir,
      fetch: jsonFetch(makeIndex([entry])),
    })

    const definition = await client.ensureInstalled('codex-probe')

    expect(definition.command).toBe(executable)
    expect(definition.args).toEqual(['--acp'])
  } finally {
    vi.unstubAllEnvs()
  }
})

test('getEntry returns the parsed entry by id and undefined for unknown ids', async () => {
  const cacheDir = await makeTmpDir()
  const client = createRegistryClient({
    cacheDir,
    fetch: jsonFetch(makeIndex([claudeEntry])),
  })

  const entry = await client.getEntry('claude-acp')
  expect(entry?.name).toBe('Claude Agent')
  await expect(client.getEntry('nope')).resolves.toBeUndefined()
})
