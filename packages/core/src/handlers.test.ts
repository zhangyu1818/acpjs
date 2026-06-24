import {
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import {
  createAcpHost,
  createDefaultFsHandler,
  createDefaultTerminalHandler,
  deriveClientCapabilities,
  type FsHandler,
  type TerminalHandler,
} from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  sessionParams,
  trackHost,
} from './test-harness.ts'

import type { AcpjsSessionEvent } from '@acpjs/protocol'

const sessionId = 'sess-handlers'

test('default fs handler reads with 1-based line and limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-fs-'))
  const file = join(dir, 'sample.txt')
  await writeFile(file, 'one\ntwo\nthree\nfour', 'utf8')
  const fs = createDefaultFsHandler(() => [dir])

  expect(await fs.readTextFile({ sessionId, path: file })).toEqual({
    content: 'one\ntwo\nthree\nfour',
  })
  expect(await fs.readTextFile({ sessionId, path: file, line: 2 })).toEqual({
    content: 'two\nthree\nfour',
  })
  expect(
    await fs.readTextFile({ sessionId, path: file, line: 2, limit: 2 }),
  ).toEqual({ content: 'two\nthree' })
  expect(await fs.readTextFile({ sessionId, path: file, limit: 1 })).toEqual({
    content: 'one',
  })
})

test('default fs handler creates missing files on write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-fs-'))
  const file = join(dir, 'created.txt')
  const fs = createDefaultFsHandler(() => [dir])

  await fs.writeTextFile({ sessionId, path: file, content: 'fresh' })

  expect(await readFile(file, 'utf8')).toBe('fresh')
})

test('default fs handler rejects symlinks that resolve outside session roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acpjs-fs-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'acpjs-fs-outside-'))
  const outsideFile = join(outside, 'secret.txt')
  const link = join(root, 'secret-link.txt')
  await writeFile(outsideFile, 'secret', 'utf8')
  await symlink(outsideFile, link)
  const fs = createDefaultFsHandler(() => [root])
  const resolvedOutside = await realpath(outsideFile)

  await expect(
    fs.readTextFile({ sessionId, path: link }),
  ).rejects.toMatchObject({
    code: -32602,
    message: expect.stringContaining('path outside session roots'),
    data: { path: resolvedOutside },
  })
  await expect(
    fs.writeTextFile({ sessionId, path: link, content: 'changed' }),
  ).rejects.toMatchObject({
    code: -32602,
    message: expect.stringContaining('path outside session roots'),
    data: { path: resolvedOutside },
  })
  expect(await readFile(outsideFile, 'utf8')).toBe('secret')
})

test('default fs handler rejects non-absolute paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-fs-relative-'))
  await writeFile(join(dir, 'sample.txt'), 'body', 'utf8')
  const fs = createDefaultFsHandler(() => [dir])

  await expect(
    fs.readTextFile({ sessionId, path: 'sample.txt' }),
  ).rejects.toMatchObject({
    code: -32602,
    message: expect.stringContaining('fs path must be absolute'),
    data: { path: 'sample.txt' },
  })
  await expect(
    fs.writeTextFile({ sessionId, path: 'sample.txt', content: 'x' }),
  ).rejects.toMatchObject({
    code: -32602,
    message: expect.stringContaining('fs path must be absolute'),
    data: { path: 'sample.txt' },
  })
})

test('default terminal handler runs the full create/output/wait/kill/release chain', async () => {
  const terminal = createDefaultTerminalHandler()

  const { terminalId } = await terminal.createTerminal({
    sessionId,
    command: process.execPath,
    args: ['-e', "process.stdout.write('hello world')"],
  })
  const exit = await terminal.waitForTerminalExit({ sessionId, terminalId })
  expect(exit).toEqual({ exitCode: 0 })
  const output = await terminal.terminalOutput({ sessionId, terminalId })
  expect(output.output).toBe('hello world')
  expect(output.truncated).toBe(false)
  expect(output.exitStatus).toEqual({ exitCode: 0 })

  await terminal.killTerminal({ sessionId, terminalId })
  const afterKill = await terminal.terminalOutput({ sessionId, terminalId })
  expect(afterKill.output).toBe('hello world')

  await terminal.releaseTerminal({ sessionId, terminalId })
  await expect(
    terminal.terminalOutput({ sessionId, terminalId }),
  ).rejects.toMatchObject({
    code: -32602,
    message: expect.stringContaining('unknown terminal'),
    data: { terminalId },
  })
})

test('terminal output truncates from the beginning at outputByteLimit', async () => {
  const terminal = createDefaultTerminalHandler()

  const { terminalId } = await terminal.createTerminal({
    sessionId,
    command: process.execPath,
    args: ['-e', "process.stdout.write('abcdefghij')"],
    outputByteLimit: 4,
  })
  await terminal.waitForTerminalExit({ sessionId, terminalId })
  const output = await terminal.terminalOutput({ sessionId, terminalId })

  expect(output.output).toBe('ghij')
  expect(output.truncated).toBe(true)
  await terminal.releaseTerminal({ sessionId, terminalId })
})

test('terminal output truncates multibyte output at a UTF-8 character boundary', async () => {
  const terminal = createDefaultTerminalHandler()

  const { terminalId } = await terminal.createTerminal({
    sessionId,
    command: process.execPath,
    args: [
      '-e',
      String.raw`process.stdout.write('\u{1F600}'.repeat(3) + '中')`,
    ],
    outputByteLimit: 7,
  })
  await terminal.waitForTerminalExit({ sessionId, terminalId })
  const output = await terminal.terminalOutput({ sessionId, terminalId })

  const bytes = Buffer.byteLength(output.output, 'utf8')
  expect(output.truncated).toBe(true)
  expect(bytes).toBeLessThanOrEqual(7)
  expect(output.output.includes('�')).toBe(false)
  expect(output.output.endsWith('中')).toBe(true)
  await terminal.releaseTerminal({ sessionId, terminalId })
})

test('terminal create applies env variables on top of the host environment', async () => {
  const terminal = createDefaultTerminalHandler()

  const { terminalId } = await terminal.createTerminal({
    sessionId,
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.ACPJS_TERM_VAR ?? "unset")'],
    env: [{ name: 'ACPJS_TERM_VAR', value: 'injected-value' }],
  })
  await terminal.waitForTerminalExit({ sessionId, terminalId })
  const output = await terminal.terminalOutput({ sessionId, terminalId })

  expect(output.output).toBe('injected-value')
  await terminal.releaseTerminal({ sessionId, terminalId })
})

test('terminal spawn failure rejects createTerminal instead of hanging', async () => {
  const terminal = createDefaultTerminalHandler()

  await expect(
    terminal.createTerminal({
      sessionId,
      command: '/nonexistent/definitely-not-a-command',
    }),
  ).rejects.toThrow()
})

test('terminal release kills a still-running process', async () => {
  const terminal = createDefaultTerminalHandler()

  const { terminalId } = await terminal.createTerminal({
    sessionId,
    command: process.execPath,
    args: [
      '-e',
      'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)',
    ],
  })
  let pidText = ''
  await (async () => {
    const deadline = Date.now() + 5000
    while (pidText === '') {
      const output = await terminal.terminalOutput({ sessionId, terminalId })
      pidText = output.output
      if (Date.now() > deadline) throw new Error('pid never arrived')
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
  })()
  const pid = Number(pidText)

  await terminal.releaseTerminal({ sessionId, terminalId })

  const deadline = Date.now() + 5000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      break
    }
    if (Date.now() > deadline) throw new Error('process was not killed')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  await expect(
    terminal.terminalOutput({ sessionId, terminalId }),
  ).rejects.toMatchObject({
    code: -32602,
    message: expect.stringContaining('unknown terminal'),
    data: { terminalId },
  })
})

test('terminal kill leaves terminalId usable for wait and output', async () => {
  const terminal = createDefaultTerminalHandler()

  const { terminalId } = await terminal.createTerminal({
    sessionId,
    command: process.execPath,
    args: [
      '-e',
      "process.stdout.write('started'); setInterval(() => {}, 1000)",
    ],
  })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  await terminal.killTerminal({ sessionId, terminalId })
  const exit = await terminal.waitForTerminalExit({ sessionId, terminalId })
  expect(exit.signal).toBe('SIGKILL')
  const output = await terminal.terminalOutput({ sessionId, terminalId })
  expect(output.exitStatus?.signal).toBe('SIGKILL')
  await terminal.releaseTerminal({ sessionId, terminalId })
})

test('agent-driven fs and injected terminal round trips succeed end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-roundtrip-'))
  const target = join(dir, 'agent-written.txt')
  const host = trackHost(
    createAcpHost({ terminal: createDefaultTerminalHandler() }),
  )
  const { definition } = await fixtureDefinition({
    turns: [
      {
        steps: [
          { kind: 'writeTextFile', path: target, content: 'from agent' },
          { kind: 'readTextFile', path: target, line: 1, limit: 1 },
          {
            kind: 'terminal',
            command: process.execPath,
            args: ['-e', "process.stdout.write('term ok')"],
            actions: ['waitForExit', 'output', 'kill', 'release'],
          },
        ],
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams(dir))
  if (created.status !== 'active') throw new Error('expected active')

  const result = await host.prompt(created.sessionId, [
    { type: 'text', text: 'go' },
  ])

  expect(result.stopReason).toBe('end_turn')
  expect(await readFile(target, 'utf8')).toBe('from agent')
})

test('host without an injected terminal handler reports terminal methods as unavailable', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition(
    {
      session: { sessionId: 'sess-term' },
      turns: [
        {
          steps: [
            {
              kind: 'terminal',
              command: process.execPath,
              args: ['-e', "process.stdout.write('term output here')"],
              actions: ['waitForExit', 'output', 'release'],
            },
          ],
        },
      ],
    },
    'agent-term',
  )
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const error = await rejectionOf(
    host.prompt('sess-term', [{ type: 'text', text: 'go' }]),
  )

  expect(error).toMatchObject({ code: -32601 })
})

test('an injected terminal handler does not broadcast terminal-output events', async () => {
  const injected = createDefaultTerminalHandler()
  const host = trackHost(createAcpHost({ terminal: injected }))
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-term-injected' },
    turns: [
      {
        steps: [
          {
            kind: 'terminal',
            command: process.execPath,
            args: ['-e', "process.stdout.write('quiet')"],
            actions: ['waitForExit', 'output', 'release'],
          },
        ],
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const events = collectEvents(
    host,
    'sess-term-injected',
  ) as AcpjsSessionEvent[]
  await host.prompt('sess-term-injected', [{ type: 'text', text: 'go' }])

  expect(events.some((event) => event.type === 'terminal-output')).toBe(false)
})

test('declared client capabilities converge on the actual handler surface (INV-6)', () => {
  const fullTerminal = createDefaultTerminalHandler()
  const partialTerminal: TerminalHandler = {
    createTerminal: fullTerminal.createTerminal,
    terminalOutput: fullTerminal.terminalOutput,
    waitForTerminalExit: fullTerminal.waitForTerminalExit,
    killTerminal: fullTerminal.killTerminal,
  }

  expect(
    deriveClientCapabilities(createDefaultFsHandler(), fullTerminal),
  ).toEqual({
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  })
  expect(
    deriveClientCapabilities(
      { readTextFile: createDefaultFsHandler().readTextFile },
      partialTerminal,
    ),
  ).toEqual({ fs: { readTextFile: true } })
  expect(deriveClientCapabilities({}, {})).toEqual({})
})

test('initialize declares exactly the derived client capabilities on the wire (INV-6)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acpjs-caps-'))
  const outFile = join(dir, 'caps.json')
  const script = [
    "const { writeFileSync } = require('node:fs')",
    "let buffer = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk',
    '  let index',
    String.raw`  while ((index = buffer.indexOf('\n')) >= 0) {`,
    '    const line = buffer.slice(0, index)',
    '    buffer = buffer.slice(index + 1)',
    '    if (!line.trim()) continue',
    '    const message = JSON.parse(line)',
    "    if (message.method !== 'initialize') continue",
    '    writeFileSync(',
    '      process.argv[1],',
    '      JSON.stringify(message.params.clientCapabilities ?? null),',
    '    )',
    '    process.stdout.write(',
    String.raw`      JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion } }) + '\n',`,
    '    )',
    '  }',
    '})',
  ].join('\n')
  const fs: FsHandler = {
    async readTextFile() {
      return { content: '' }
    },
  }
  const host = trackHost(createAcpHost({ fs, terminal: {} }))

  await host.spawnAgent({
    id: 'echo-caps',
    command: process.execPath,
    args: ['-e', script, outFile],
  })

  expect(JSON.parse(await readFile(outFile, 'utf8'))).toEqual({
    fs: { readTextFile: true },
  })
})

test('injected fs handler replaces the built-in implementation entirely', async () => {
  const reads: string[] = []
  const fs: FsHandler = {
    async readTextFile(params) {
      reads.push(params.path)
      return { content: 'injected' }
    },
  }
  const host = trackHost(createAcpHost({ fs, terminal: {} }))
  const { definition } = await fixtureDefinition({
    turns: [{ steps: [{ kind: 'readTextFile', path: '/virtual/file.txt' }] }],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')

  const readTurn = await host.prompt(created.sessionId, [
    { type: 'text', text: 'read' },
  ])

  expect(readTurn.stopReason).toBe('end_turn')
  expect(reads).toEqual(['/virtual/file.txt'])
})
