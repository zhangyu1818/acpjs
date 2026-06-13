import { expect, test } from 'vitest'

import { parseEntry, parseIndex } from './parse.ts'
import { claudeEntry } from './test-support.ts'

test.each([
  ['null', null],
  ['a string', 'registry'],
  ['an array', []],
  ['an object without agents', { version: '1.0.0' }],
  ['an object with non-array agents', { agents: 'all' }],
])('parseIndex throws registry/index-invalid for %s', (_name, raw) => {
  expect(() => parseIndex(raw)).toThrowError(
    expect.objectContaining({ code: 'registry/index-invalid' }),
  )
})

const validBinaryTarget = {
  archive: 'https://example.com/agent-darwin-aarch64.zip',
  cmd: './agent',
}

const invalidEntries: [string, unknown][] = [
  ['a non-record entry', 'just-a-string'],
  ['an entry missing id', { ...claudeEntry, id: undefined }],
  ['an entry missing name', { ...claudeEntry, name: '' }],
  ['an entry missing version', { ...claudeEntry, version: undefined }],
  ['an entry missing description', { ...claudeEntry, description: undefined }],
  [
    'an entry without distribution',
    { ...claudeEntry, distribution: undefined },
  ],
  [
    'an npx distribution missing package',
    { ...claudeEntry, distribution: { npx: { args: ['--acp'] } } },
  ],
  [
    'an npx distribution that is not a record',
    { ...claudeEntry, distribution: { npx: 'pkg@1.0.0' } },
  ],
  [
    'a uvx distribution that is not a record',
    { ...claudeEntry, distribution: { uvx: 42 } },
  ],
  [
    'a binary map that is not a record',
    { ...claudeEntry, distribution: { binary: 'archive.zip' } },
  ],
  [
    'a binary target missing cmd',
    {
      ...claudeEntry,
      distribution: {
        binary: { 'darwin-aarch64': { archive: 'https://example.com/a.zip' } },
      },
    },
  ],
  [
    'a binary target missing archive',
    {
      ...claudeEntry,
      distribution: { binary: { 'darwin-aarch64': { cmd: './agent' } } },
    },
  ],
  [
    'a binary map with only unknown platform keys',
    {
      ...claudeEntry,
      distribution: { binary: { 'amiga-68k': validBinaryTarget } },
    },
  ],
  [
    'a binary map with no targets at all',
    { ...claudeEntry, distribution: { binary: {} } },
  ],
  ['a distribution with no usable form', { ...claudeEntry, distribution: {} }],
]

test.each(invalidEntries)('parseEntry rejects %s', (_name, raw) => {
  expect(parseEntry(raw)).toBeUndefined()
})

test('parseIndex partitions bad entries into invalid without failing the whole index', () => {
  const bad = invalidEntries.map(([, raw]) => raw)
  const parsed = parseIndex({ version: '1.0.0', agents: [claudeEntry, ...bad] })

  expect(parsed.version).toBe('1.0.0')
  expect(parsed.entries.map((entry) => entry.id)).toEqual(['claude-acp'])
  expect(parsed.invalid).toHaveLength(bad.length)
  for (const item of parsed.invalid) {
    expect(item.reason).toBe('entry does not match the agent schema')
  }
  expect(
    parsed.invalid.filter((item) => item.id === 'claude-acp').length,
  ).toBeGreaterThan(0)
})

test('parseEntry keeps a binary target with args and env and a valid platform key', () => {
  const entry = parseEntry({
    ...claudeEntry,
    distribution: {
      binary: {
        'darwin-aarch64': {
          ...validBinaryTarget,
          args: ['acp'],
          env: { MODE: 'acp' },
        },
      },
    },
  })

  expect(entry?.distribution.binary?.['darwin-aarch64']).toEqual({
    archive: 'https://example.com/agent-darwin-aarch64.zip',
    cmd: './agent',
    args: ['acp'],
    env: { MODE: 'acp' },
  })
})
