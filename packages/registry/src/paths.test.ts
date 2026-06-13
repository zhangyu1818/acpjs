import { homedir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { defaultCacheDir, probeExecutableOnPath } from './paths.ts'
import { makeTmpDir } from './test-support.ts'

const realPlatform = process.platform

function stubPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
}

afterEach(() => {
  stubPlatform(realPlatform)
  vi.unstubAllEnvs()
})

test('defaultCacheDir on darwin uses Library/Caches', () => {
  stubPlatform('darwin')
  expect(defaultCacheDir()).toBe(join(homedir(), 'Library', 'Caches', 'acpjs'))
})

test('defaultCacheDir on win32 prefers LOCALAPPDATA', () => {
  stubPlatform('win32')
  vi.stubEnv('LOCALAPPDATA', join('C:', 'Users', 'me', 'AppData', 'Local'))
  expect(defaultCacheDir()).toBe(
    join('C:', 'Users', 'me', 'AppData', 'Local', 'acpjs', 'Cache'),
  )
})

test('defaultCacheDir on win32 without LOCALAPPDATA falls back to the home AppData path', () => {
  stubPlatform('win32')
  vi.stubEnv('LOCALAPPDATA', '')
  expect(defaultCacheDir()).toBe(
    join(homedir(), 'AppData', 'Local', 'acpjs', 'Cache'),
  )
})

test('defaultCacheDir elsewhere honors XDG_CACHE_HOME', () => {
  stubPlatform('linux')
  vi.stubEnv('XDG_CACHE_HOME', '/custom/cache')
  expect(defaultCacheDir()).toBe(join('/custom/cache', 'acpjs'))
})

test('defaultCacheDir elsewhere falls back to ~/.cache', () => {
  stubPlatform('linux')
  vi.stubEnv('XDG_CACHE_HOME', '')
  expect(defaultCacheDir()).toBe(join(homedir(), '.cache', 'acpjs'))
})

test('probeExecutableOnPath resolves undefined when nothing on PATH matches', async () => {
  const emptyDir = await makeTmpDir()
  vi.stubEnv('PATH', emptyDir)
  await expect(
    probeExecutableOnPath(['definitely-not-installed-anywhere']),
  ).resolves.toBeUndefined()
})
