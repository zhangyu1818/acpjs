import { expect, test } from 'vitest'

import { chunk, startSession } from './e2e-harness.ts'

import type { FixtureScenario } from './index.ts'

const permissionScenario: FixtureScenario = {
  turns: [
    {
      steps: [
        {
          kind: 'permission',
          toolCall: { toolCallId: 'call_1', status: 'pending' },
          options: [
            { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
            { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
          ],
          onSelected: { allow: [{ kind: 'update', update: chunk('allowed') }] },
          onCancelled: [{ kind: 'update', update: chunk('cancelled') }],
        },
      ],
    },
  ],
}

test('permission round-trip with selected outcome runs the matching branch', async () => {
  const received: unknown[] = []
  const { conn, sessionId, updates } = await startSession(permissionScenario, {
    async requestPermission(params) {
      received.push(params)
      return { outcome: { outcome: 'selected', optionId: 'allow' } }
    },
  })

  const result = await conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'go' }],
  })

  expect(received).toEqual([
    {
      sessionId,
      toolCall: { toolCallId: 'call_1', status: 'pending' },
      options: [
        { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
    },
  ])
  expect(updates.map((notification) => notification.update)).toEqual([
    chunk('allowed'),
  ])
  expect(result).toEqual({ stopReason: 'end_turn' })
})

test('permission round-trip with cancelled outcome runs the onCancelled branch', async () => {
  const { conn, sessionId, updates } = await startSession(permissionScenario, {
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' } }
    },
  })

  await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

  expect(updates.map((notification) => notification.update)).toEqual([
    chunk('cancelled'),
  ])
})

test('fs steps call the client fs methods with scripted params', async () => {
  const calls: unknown[] = []
  const { conn, sessionId } = await startSession(
    {
      turns: [
        {
          steps: [
            { kind: 'readTextFile', path: '/tmp/in.txt', line: 2, limit: 10 },
            { kind: 'writeTextFile', path: '/tmp/out.txt', content: 'data' },
          ],
        },
      ],
    },
    {
      async readTextFile(params) {
        calls.push(['read', params])
        return { content: 'file body' }
      },
      async writeTextFile(params) {
        calls.push(['write', params])
        return {}
      },
    },
  )

  const result = await conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'go' }],
  })

  expect(result).toEqual({ stopReason: 'end_turn' })
  expect(calls).toEqual([
    ['read', { sessionId, path: '/tmp/in.txt', line: 2, limit: 10 }],
    ['write', { sessionId, path: '/tmp/out.txt', content: 'data' }],
  ])
})

test('terminal step drives the full create/output/wait/kill/release chain against the client', async () => {
  const calls: unknown[] = []
  const { conn, sessionId } = await startSession(
    {
      turns: [
        {
          steps: [
            {
              kind: 'terminal',
              command: 'echo',
              args: ['hi'],
              env: [{ name: 'FOO', value: 'bar' }],
              cwd: '/tmp',
              outputByteLimit: 1024,
              actions: ['output', 'waitForExit', 'kill', 'release'],
            },
          ],
        },
      ],
    },
    {
      async createTerminal(params) {
        calls.push(['create', params])
        return { terminalId: 'term-1' }
      },
      async terminalOutput(params) {
        calls.push(['output', params])
        return { output: 'hi', truncated: false }
      },
      async waitForTerminalExit(params) {
        calls.push(['wait', params])
        return { exitCode: 0 }
      },
      async killTerminal(params) {
        calls.push(['kill', params])
        return {}
      },
      async releaseTerminal(params) {
        calls.push(['release', params])
        return {}
      },
    },
  )

  await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

  expect(calls).toEqual([
    [
      'create',
      {
        sessionId,
        command: 'echo',
        args: ['hi'],
        env: [{ name: 'FOO', value: 'bar' }],
        cwd: '/tmp',
        outputByteLimit: 1024,
      },
    ],
    ['output', { sessionId, terminalId: 'term-1' }],
    ['wait', { sessionId, terminalId: 'term-1' }],
    ['kill', { sessionId, terminalId: 'term-1' }],
    ['release', { sessionId, terminalId: 'term-1' }],
  ])
})
