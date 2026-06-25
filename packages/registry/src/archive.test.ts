import { readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { expect, test } from 'vitest'

import { extractTar, extractZip, resolveCommandPath } from './archive.ts'
import {
  makeDeflatedZip,
  makeStoredZip,
  makeTar,
  makeTmpDir,
} from './test-support.ts'

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

test('extractZip rejects a deflate entry whose inflated size exceeds the cap', async () => {
  const destDir = join(await makeTmpDir(), 'dest')
  const zip = makeDeflatedZip({ 'a.txt': 'a'.repeat(4096) })

  await expect(extractZip(zip, destDir, 64)).rejects.toThrow(
    'larger than 64 bytes',
  )
  expect(await readdir(destDir)).toEqual([])
})

test('extractTar writes nothing outside the destination for a `..` traversal entry', async () => {
  const parent = await makeTmpDir()
  const destDir = join(parent, 'dest')
  const archivePath = join(parent, 'evil.tar')
  await writeFile(
    archivePath,
    makeTar([{ name: '../evil.txt', content: 'pwned' }]),
  )

  await extractTar(archivePath, destDir)

  expect(await readdir(destDir)).toEqual([])
  expect(await readdir(parent)).toEqual(['dest', 'evil.tar'])
})

test('extractTar refuses to write through a symlink that escapes the destination', async () => {
  const parent = await makeTmpDir()
  const destDir = join(parent, 'dest')
  const archivePath = join(parent, 'evil.tar')
  await writeFile(
    archivePath,
    makeTar([
      { name: 'sneaky', linkname: '..' },
      { name: 'sneaky/escaped.txt', content: 'pwned' },
    ]),
  )

  await extractTar(archivePath, destDir)

  const parentEntries = await readdir(parent)
  const destEntries = await readdir(destDir)
  expect(parentEntries.includes('escaped.txt')).toBe(false)
  expect(destEntries.includes('escaped.txt')).toBe(false)
})
