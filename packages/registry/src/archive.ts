import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { extract } from 'tar'

export type ArchiveFormat = 'tar' | 'zip' | 'raw' | 'unsupported'

const ZIP_MAX_ENTRY_BYTES = 256 * 1024 * 1024

const TAR_SUFFIXES = ['.tar.gz', '.tgz']
const UNSUPPORTED_SUFFIXES = [
  '.tar.bz2',
  '.tbz2',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
]

export function archiveFormatFor(archiveUrl: string): ArchiveFormat {
  let pathname = archiveUrl
  try {
    pathname = new URL(archiveUrl).pathname
  } catch {
    pathname = archiveUrl
  }
  const lower = pathname.toLowerCase()
  if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return 'tar'
  if (lower.endsWith('.zip')) return 'zip'
  if (UNSUPPORTED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return 'unsupported'
  }
  return 'raw'
}

function containedPath(destDir: string, name: string): string {
  const target = resolve(destDir, name)
  if (target !== destDir && !target.startsWith(destDir + sep)) {
    throw new Error(`archive entry escapes extraction directory: ${name}`)
  }
  return target
}

export async function extractTar(
  archivePath: string,
  destDir: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true })
  await extract({ file: archivePath, cwd: destDir })
}

interface ZipEntry {
  name: string
  data: Buffer
}

function readZipEntries(buffer: Buffer, maxEntryBytes: number): ZipEntry[] {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('zip: malformed central directory')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    if (method !== 0 && method !== 8) {
      throw new Error(`zip: unsupported compression method ${method}`)
    }
    entries.push({
      name,
      data:
        method === 8
          ? inflateRawSync(raw, { maxOutputLength: maxEntryBytes })
          : Buffer.from(raw),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export async function extractZip(
  buffer: Buffer,
  destDir: string,
  maxEntryBytes: number = ZIP_MAX_ENTRY_BYTES,
): Promise<void> {
  await mkdir(destDir, { recursive: true })
  for (const entry of readZipEntries(buffer, maxEntryBytes)) {
    const target = containedPath(destDir, entry.name)
    if (entry.name.endsWith('/')) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.data)
  }
}

export function resolveCommandPath(contentsDir: string, cmd: string): string {
  const target = resolve(contentsDir, cmd)
  if (target !== contentsDir && !target.startsWith(contentsDir + sep)) {
    throw new Error(`binary cmd escapes the install directory: ${cmd}`)
  }
  return target
}
