import { expect, test } from 'vitest'

import { MAX_DIAGNOSTICS } from './client-diagnostics.ts'
import { createAcpClient, type AcpClient } from './index.ts'
import { createFakeHub, type FakeHub } from './test-support.ts'

import type { DiagnosticLevel } from '@acpjs/protocol'

function diagnostic(
  code: string,
  overrides: {
    level?: DiagnosticLevel
    message?: string
    agentId?: string
    data?: unknown
  } = {},
): {
  type: 'diagnostic'
  agentId?: string
  payload: {
    level: DiagnosticLevel
    code: string
    message: string
    data?: unknown
  }
} {
  return {
    type: 'diagnostic',
    ...(overrides.agentId === undefined ? {} : { agentId: overrides.agentId }),
    payload: {
      level: overrides.level ?? 'error',
      code,
      message: overrides.message ?? code,
      ...(overrides.data === undefined ? {} : { data: overrides.data }),
    },
  }
}

async function setup(): Promise<{ hub: FakeHub; client: AcpClient }> {
  const hub = createFakeHub()
  const client = createAcpClient({ transport: hub.connection().transport })
  // wait for the host subscription to attach
  await Promise.resolve()
  await Promise.resolve()
  return { hub, client }
}

test('host diagnostic events land in the diagnostics snapshot and notify subscribers', async () => {
  const { hub, client } = await setup()
  const seen: (readonly unknown[])[] = []
  client.diagnostics.subscribe(() =>
    seen.push(client.diagnostics.getSnapshot()),
  )

  hub.emitHost(
    diagnostic('spawn-failed', { agentId: 'agent-1', message: 'boom' }),
  )

  expect(seen).toHaveLength(1)
  const snapshot = client.diagnostics.getSnapshot()
  expect(snapshot).toHaveLength(1)
  expect(snapshot[0]).toMatchObject({
    type: 'diagnostic',
    agentId: 'agent-1',
    payload: { level: 'error', code: 'spawn-failed', message: 'boom' },
  })
  expect(seen[0]).toBe(snapshot)
})

test('the diagnostics snapshot reference is stable until a new event arrives', async () => {
  const { hub, client } = await setup()
  const empty = client.diagnostics.getSnapshot()
  expect(empty).toEqual([])

  hub.emitHost(diagnostic('process-error'))
  const first = client.diagnostics.getSnapshot()
  expect(client.diagnostics.getSnapshot()).toBe(first)

  hub.emitHost(diagnostic('restart-scheduled', { data: { delayMs: 1000 } }))
  const second = client.diagnostics.getSnapshot()
  expect(second).not.toBe(first)
  expect(second).toHaveLength(2)
  expect(second[1]?.payload.data).toEqual({ delayMs: 1000 })
})

test('non-diagnostic host events are ignored by the diagnostics channel', async () => {
  const { hub, client } = await setup()
  hub.emitHost({
    type: 'agent-updated',
    payload: { agentId: 'agent-1', status: 'ready', restartCount: 0 },
  })
  expect(client.diagnostics.getSnapshot()).toEqual([])
})

test('the diagnostics log is bounded to the most recent MAX_DIAGNOSTICS entries', async () => {
  const { hub, client } = await setup()
  const total = MAX_DIAGNOSTICS + 25
  for (let index = 0; index < total; index += 1) {
    hub.emitHost(diagnostic('stderr', { message: `line-${index}` }))
  }

  const snapshot = client.diagnostics.getSnapshot()
  expect(snapshot).toHaveLength(MAX_DIAGNOSTICS)
  expect(snapshot[0]?.payload.message).toBe(`line-${total - MAX_DIAGNOSTICS}`)
  expect(snapshot.at(-1)?.payload.message).toBe(`line-${total - 1}`)
})

test('dispose clears the diagnostics snapshot', async () => {
  const { hub, client } = await setup()
  hub.emitHost(diagnostic('stderr'))
  expect(client.diagnostics.getSnapshot()).toHaveLength(1)

  await client.dispose()

  expect(client.diagnostics.getSnapshot()).toEqual([])
})
