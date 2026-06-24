import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  fixtureAgentCliPath,
  writeScenarioFile,
  type FixtureScenario,
} from '@acpjs/fixture-agent'
import { afterAll, beforeAll, expect, test } from 'vitest'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const requireCjs = createRequire(import.meta.url)

interface RoleReport {
  error?: string
  handshakeFailed?: boolean
  message?: string
  sessionId?: string
  firstStop?: string
  secondStop?: string
  secondRespond?: { ok?: boolean; code?: string; message?: string }
  respondResult?: { ok?: boolean; code?: string }
  eventCount?: number
  unknownSubEvents?: number
  bridgeKeys?: string[]
  bridgeIpcRendererAbsent?: boolean
  leakedDestroyedListeners?: number
  state?: {
    messages?: unknown
    lastStopReason?: string
    pendingPermissionRequests?: unknown[]
  }
}

const scenario: FixtureScenario = {
  turns: [
    {
      steps: [
        {
          kind: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello ' },
          },
        },
        {
          kind: 'permission',
          toolCall: { toolCallId: 'tc-1', title: 'write file', kind: 'edit' },
          options: [
            { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
        {
          kind: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'world' },
          },
        },
      ],
      stopReason: 'end_turn',
    },
    {
      steps: [
        {
          kind: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'again' },
          },
        },
      ],
      stopReason: 'end_turn',
    },
  ],
}

let reports: Record<string, RoleReport | undefined> = {}
let child: ChildProcess | undefined

function role(name: string): RoleReport {
  const report = reports[name]
  if (report === undefined) {
    throw new Error(`missing report for window ${name}`)
  }
  return report
}

beforeAll(async () => {
  execSync('pnpm exec tsdown', {
    cwd: packageDir,
    stdio: 'pipe',
  })
  execSync('pnpm exec tsdown -c test-app/bundle.config.ts', {
    cwd: packageDir,
    stdio: 'pipe',
  })
  const scenarioPath = await writeScenarioFile(scenario)
  const electronPath = requireCjs('electron') as string
  const sessionCwd = mkdtempSync(path.join(tmpdir(), 'acpjs-electron-e2e-'))
  let stdout = ''
  let stderr = ''
  child = spawn(
    electronPath,
    ['--no-sandbox', path.join(packageDir, 'test-app/main.mjs')],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        ACP_E2E_NODE_BIN: process.execPath,
        ACP_E2E_FIXTURE_CLI: fixtureAgentCliPath,
        ACP_E2E_SCENARIO: scenarioPath,
        ACP_E2E_CWD: sessionCwd,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const app = child
  const resultLine = await new Promise<string>((resolve, reject) => {
    const fail = (reason: string): void => {
      reject(
        new Error(
          `${reason}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      )
    }
    const timer = setTimeout(() => fail('electron e2e timed out'), 90_000)
    const check = (): void => {
      const match = /^ACP_E2E_RESULT:(.*)$/m.exec(stdout)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    app.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      check()
    })
    app.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    app.on('error', (error) => {
      clearTimeout(timer)
      fail(`electron failed to start: ${error.message}`)
    })
    app.on('exit', () => {
      setTimeout(() => {
        check()
        clearTimeout(timer)
        fail('electron exited without a result')
      }, 200)
    })
  })
  reports = JSON.parse(resultLine) as Record<string, RoleReport | undefined>
}, 240_000)

afterAll(() => {
  child?.kill('SIGKILL')
})

test('window with contextIsolation disabled fails the handshake', () => {
  expect(role('c').handshakeFailed).toBe(true)
  expect(role('c').message).toContain('contextIsolation')
})

test('full prompt chain builds session state inside the renderer client', () => {
  expect(role('a').error).toBeUndefined()
  expect(role('a').firstStop).toBe('end_turn')
  const state = role('a').state
  expect(state?.lastStopReason).toBe('end_turn')
  expect(state?.pendingPermissionRequests).toEqual([])
  const messagesText = JSON.stringify(state?.messages)
  expect(messagesText).toContain('hello ')
  expect(messagesText).toContain('world')
})

test('both windows get their own port and reduce identical session state', () => {
  expect(role('b').error).toBeUndefined()
  expect(role('b').sessionId).toBe(role('a').sessionId)
  expect(role('b').eventCount).toBeGreaterThan(0)
  expect(role('b').state).toEqual(role('a').state)
})

test('window B receives each session event exactly once on its own port', () => {
  expect(role('b').eventCount).toBe(10)
})

test('preload exposes only the connect handshake on window.acp', () => {
  expect(role('a').bridgeKeys).toEqual(['connect'])
  expect(role('a').bridgeIpcRendererAbsent).toBe(true)
})

test('a permission request is answered exactly once across windows', () => {
  expect(role('b').respondResult).toEqual({ ok: true })
  expect(role('a').secondRespond?.code).toBe('acpjs/already-answered')
})

test('window A keeps prompting after window B tears down its transports', () => {
  expect(role('a').secondStop).toBe('end_turn')
})

test('a raw subscribe to an unknown session is isolated and does not crash main', () => {
  expect(reports.main).toBeUndefined()
  expect(role('b').unknownSubEvents).toBe(0)
})

test('repeated connect/close cycles leave no destroyed listeners behind in main', () => {
  expect(role('b').leakedDestroyedListeners).toBe(0)
})
