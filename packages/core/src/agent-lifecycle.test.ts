import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import {
  agentStatusPayloads,
  collectEvents,
  diagnosticPayloads,
  fixtureDefinition,
  rejectionOf,
  trackHost,
  waitFor,
} from './test-harness.ts'

import type { AcpEvent } from '@acpjs/protocol'

function statuses(events: AcpEvent[]): string[] {
  return agentStatusPayloads(events).map((payload) => payload.status)
}

function exitReason(events: AcpEvent[]): string | undefined {
  return agentStatusPayloads(events).find(
    (payload) => payload.status === 'exited',
  )?.reason
}

test('spawnAgent walks spawning → initializing → ready and caches initialize results', async () => {
  const host = trackHost(createAcpHost())
  const events = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'oauth', name: 'OAuth' }],
    },
  })

  const agent = await host.spawnAgent(definition)

  expect(agent.agentId).toMatch(/^agent-\d+$/)
  expect(agent.status).toBe('ready')
  expect(agent.capabilities).toEqual({ loadSession: true })
  expect(agent.authMethods).toEqual([{ id: 'oauth', name: 'OAuth' }])
  expect(statuses(events)).toEqual(['spawning', 'initializing', 'ready'])
  const seqs = events.map((event) => event.seq)
  expect(seqs).toEqual(seqs.map((_, index) => index + 1))
})

test('spawn failure ends exited(spawn-failed) and rejects with acpjs/agent-exited', async () => {
  const host = trackHost(createAcpHost())
  const events = collectEvents(host, undefined)

  const error = await rejectionOf(
    host.spawnAgent({ id: 'missing', command: '/nonexistent/definitely-not' }),
  )

  expect(error).toMatchObject({ code: 'acpjs/agent-exited' })
  expect(exitReason(events)).toBe('spawn-failed')
})

test('protocol version mismatch ends exited(initialize-failed)', async () => {
  const host = trackHost(createAcpHost())
  const events = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    initialize: { protocolVersion: 999 },
  })

  const error = await rejectionOf(host.spawnAgent(definition))

  expect(error).toMatchObject({ code: 'acpjs/agent-exited' })
  expect(exitReason(events)).toBe('initialize-failed')
})

test('initialize failure still records the process exit on the agent record', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: { protocolVersion: 999 },
  })

  await rejectionOf(host.spawnAgent(definition))

  await waitFor(() => host.getAgent('agent-1')?.exit !== undefined)
  expect(host.getAgent('agent-1')).toMatchObject({
    status: 'exited',
    reason: 'initialize-failed',
  })
})

test('agent process exit before initialize ends exited(initialize-failed)', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({})
  definition.args = [
    definition.args?.[0] ?? '',
    '--scenario',
    '/nonexistent/scenario.json',
  ]

  const error = await rejectionOf(host.spawnAgent(definition))

  expect(error).toMatchObject({ code: 'acpjs/agent-exited' })
  expect(host.getAgent('agent-1')?.reason).toBe('initialize-failed')
})

test('agent stderr output surfaces as diagnostic events', async () => {
  const host = trackHost(createAcpHost())
  const events = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({})
  definition.args = [
    definition.args?.[0] ?? '',
    '--scenario',
    '/nonexistent/scenario.json',
  ]

  await rejectionOf(host.spawnAgent(definition))

  await waitFor(() => diagnosticPayloads(events, 'agent/stderr').length !== 0)
  expect(diagnosticPayloads(events, 'agent/stderr').length).toBeGreaterThan(0)
})

test('spawn diagnostics record env key names only (INV-7)', async () => {
  const host = trackHost(createAcpHost())
  const events = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({})
  definition.env = { MY_TOKEN: 'super-secret-value' }

  await host.spawnAgent(definition)

  const spawnDiag = diagnosticPayloads(events, 'agent/spawn').at(0)
  expect(spawnDiag).toBeDefined()
  expect(JSON.stringify(spawnDiag)).toContain('MY_TOKEN')
  expect(JSON.stringify(events)).not.toContain('super-secret-value')
})

test('dispose terminates the agent process and emits exited(disposed)', async () => {
  const host = createAcpHost()
  const events = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({})
  const agent = await host.spawnAgent(definition)

  await host.dispose()

  expect(host.getAgent(agent.agentId)?.status).toBe('exited')
  expect(host.getAgent(agent.agentId)?.reason).toBe('disposed')
  expect(statuses(events)).toEqual([
    'spawning',
    'initializing',
    'ready',
    'exited',
  ])
})

test('dispose kills a slow agent with SIGKILL after the injected kill timeout', async () => {
  const host = createAcpHost({ killTimeoutMs: 25 })
  const events = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-slow' },
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'started' },
            },
          },
          { kind: 'sleep', ms: 60_000 },
        ],
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, { cwd: '/tmp' })
  if (created.status !== 'active') throw new Error('expected active')
  const sessionEvents = collectEvents(host, created.sessionId)
  const pending = rejectionOf(
    host.prompt(created.sessionId, [{ type: 'text', text: 'go' }]),
  )
  await waitFor(() =>
    sessionEvents.some((event) => event.type === 'agent-message-chunk'),
  )

  await host.dispose()

  expect(diagnosticPayloads(events, 'agent/kill')).toHaveLength(1)
  expect(await pending).toMatchObject({ code: 'acpjs/agent-exited' })
  expect(host.getAgent(agent.agentId)?.status).toBe('exited')
  expect(host.getAgent(agent.agentId)?.reason).toBe('disposed')
})

test('getAgents returns a snapshot for every spawned agent including status', async () => {
  const host = trackHost(createAcpHost())
  const first = await fixtureDefinition({}, 'first')
  const second = await fixtureDefinition({}, 'second')

  const a = await host.spawnAgent(first.definition)
  const b = await host.spawnAgent(second.definition)

  const agents = host.getAgents()
  expect(agents.map((agent) => agent.agentId).toSorted()).toEqual(
    [a.agentId, b.agentId].toSorted(),
  )
  expect(agents.map((agent) => agent.status)).toEqual(['ready', 'ready'])
  expect(agents.map((agent) => agent.restartCount)).toEqual([0, 0])
})
