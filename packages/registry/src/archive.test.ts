import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { expect, test } from 'vitest'

import { extractZip, resolveCommandPath } from './archive.ts'
import { makeStoredZip, makeTmpDir } from './test-support.ts'

test('extractZip refuses zip-slip entries and leaves nothing outside the destination', async () => {
  const parent = await makeTmpDir()
  const destDir = join(parent, 'dest')
  const zip = makeStoredZip({ '../evil.txt': 'pwned' })

  await expect(extractZip(zip, destDir)).rejects.toThrow(
    'escapes extraction directory',
  )
  expect(await readdir(parent)).toEqual(['dest'])
  expect(await readdir(destDir)).toEqual([])
})

test('resolveCommandPath refuses cmd values escaping the install directory', async () => {
  const contentsDir = await makeTmpDir()

  expect(() => resolveCommandPath(contentsDir, '../../evil')).toThrow(
    'escapes the install directory',
  )
  expect(resolveCommandPath(contentsDir, './bin/agent')).toBe(
    join(contentsDir, 'bin', 'agent'),
  )
  expect(dirname(resolveCommandPath(contentsDir, 'agent'))).toBe(contentsDir)
})

test('extractZip rejects a buffer without an end-of-central-directory record', async () => {
  const destDir = join(await makeTmpDir(), 'dest')

  await expect(
    extractZip(Buffer.from('definitely not a zip archive at all'), destDir),
  ).rejects.toThrow('end of central directory not found')
})

test('extractZip rejects a zip whose central directory is corrupted', async () => {
  const destDir = join(await makeTmpDir(), 'dest')
  const zip = makeStoredZip({ 'a.txt': 'hi' })
  const centralStart = 30 + 'a.txt'.length + 'hi'.length
  zip[centralStart] = 0xff

  await expect(extractZip(zip, destDir)).rejects.toThrow(
    'malformed central directory',
  )
})

test('extractZip rejects entries with an unsupported compression method', async () => {
  const destDir = join(await makeTmpDir(), 'dest')
  const zip = makeStoredZip({ 'a.txt': 'hi' })
  const centralStart = 30 + 'a.txt'.length + 'hi'.length
  zip.writeUInt16LE(99, centralStart + 10)

  await expect(extractZip(zip, destDir)).rejects.toThrow(
    'unsupported compression method 99',
  )
  expect(await readdir(destDir)).toEqual([])
})
