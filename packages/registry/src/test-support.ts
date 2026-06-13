import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'acpjs-registry-test-'))
}

export async function makeTarGz(
  files: Record<string, string>,
): Promise<Buffer> {
  const dir = await makeTmpDir()
  const contentDir = join(dir, 'content')
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(contentDir, name)), { recursive: true })
    await writeFile(join(contentDir, name), content)
  }
  const archivePath = join(dir, 'archive.tar.gz')
  execFileSync('tar', ['-czf', archivePath, '-C', contentDir, '.'])
  return readFile(archivePath)
}

export function makeStoredZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }
  const centralStart = offset
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...locals, ...centrals, eocd])
}

export function routedFetch(
  routes: Record<string, () => Response>,
): (url: string) => Promise<Response> {
  return (url) => {
    const route = routes[url]
    if (!route) return Promise.reject(new Error(`unexpected fetch: ${url}`))
    return Promise.resolve(route())
  }
}

export function binaryResponse(buffer: Buffer): Response {
  return new Response(new Uint8Array(buffer))
}

export function chunkedResponse(
  buffer: Buffer,
  chunkSize: number,
  options: { contentLength?: boolean } = {},
): Response {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(new Uint8Array(buffer.subarray(i, i + chunkSize)))
  }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift()
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  })
  const headers =
    options.contentLength === false
      ? undefined
      : { 'content-length': String(buffer.length) }
  return new Response(stream, headers === undefined ? {} : { headers })
}

export const claudeEntry = {
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
}

export function makeIndex(agents: unknown[]): unknown {
  return { version: '1.0.0', agents, extensions: [] }
}

export function jsonFetch(
  body: unknown,
  calls?: string[],
): (url: string) => Promise<Response> {
  return (url) => {
    calls?.push(url)
    return Promise.resolve(Response.json(body))
  }
}
