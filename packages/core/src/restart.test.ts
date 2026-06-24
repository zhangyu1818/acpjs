import { writeFile } from 'node:fs/promises'

import { expect, test } from 'vitest'

import { createAcpHost, type HostOptions } from './index.ts'
import {
  agentStatusPayloads,
  collectEvents,
  diagnosticPayloads,
  fixtureDefinition,
  rejectionOf,
  resumeParams,
  sessionParams,
  trackHost,
  waitFor,
} from './test-harness.ts'

import type { FixtureScenario } from '@acpjs/fixture-agent'
import type { AcpjsEvent, SessionStatusChangePayload } from '@acpjs/protocol'

const tinyBackoff = { initialMs: 5, factor: 2, maxMs: 50 }

function sessionStatusPayloads(
  events: AcpjsEvent[],
): SessionStatusChangePayload[] {
  const found: SessionStatusChangePayload[] = []
  for (const event of events) {
    if (event.type === 'session-status-change') found.push(event.payload)
  }
  return found
}

const crashTurnScenario = (
  extra: Partial<FixtureScenario> = {},
): FixtureScenario => ({
  session: { sessionId: 'sess-crash' },
  turns: [
    {
      steps: [
        {
          kind: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'before-crash' },
          },
        },
        { kind: 'exit', code: 7 },
      ],
    },
  ],
  ...extra,
})

async function crashSession(options: HostOptions, scenario: FixtureScenario) {
  const host = trackHost(createAcpHost(options))
  const { definition, scenarioPath } = await fixtureDefinition(scenario)
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const sessionEvents = collectEvents(host, created.sessionId)
  const hostEvents = collectEvents(host, undefined)
  const error = await rejectionOf(
    host.prompt(created.sessionId, [{ type: 'text', text: 'go' }]),
  )
  return {
    host,
    agentId: agent.agentId,
    sessionId: created.sessionId,
    sessionEvents,
    hostEvents,
    scenarioPath,
    error,
  }
}

test('restart never: crash is terminal, session stays disconnected', async () => {
  const { host, agentId, sessionId, hostEvents, error } = await crashSession(
    {},
    crashTurnScenario(),
  )

  expect(error).toMatchObject({ code: 'acpjs/agent-exited' })
  await waitFor(
    () =>
      host.getAgent(agentId)?.status === 'exited' &&
      host.getAgent(agentId)?.exit !== undefined,
  )

  expect(host.getAgent(agentId)?.reason).toBe('crashed')
  expect(host.getAgent(agentId)?.exit).toEqual({ code: 7 })
  expect(host.getSession(sessionId)?.status).toBe('disconnected')
  const statuses = agentStatusPayloads(hostEvents).map((p) => p.status)
  expect(statuses).not.toContain('restarting')
  expect(
    diagnosticPayloads(hostEvents, 'agent/restart-suppressed').length,
  ).toBeGreaterThan(0)
})

test('on-crash restart with resumeSession recovers the session as active(resumed) without duplicating history', async () => {
  const { host, agentId, sessionId, sessionEvents, hostEvents } =
    await crashSession(
      { restart: 'on-crash', restartBackoff: tinyBackoff },
      crashTurnScenario({
        initialize: {
          agentCapabilities: {
            sessionCapabilities: { resume: {} },
          },
        },
      }),
    )

  await waitFor(
    () =>
      host.getSession(sessionId)?.status === 'active' &&
      host.getAgent(agentId)?.status === 'ready',
  )

  const chunkCount = sessionEvents.filter(
    (event) => event.type === 'agent-message-chunk',
  ).length
  expect(chunkCount).toBe(1)
  const statuses = sessionStatusPayloads(sessionEvents)
  expect(statuses.map((p) => p.status)).toEqual([
    'active',
    'prompting',
    'disconnected',
    'resuming',
    'active',
  ])
  expect(statuses.at(-1)).toEqual({ status: 'active', resumed: true })
  expect(host.getAgent(agentId)?.restartCount).toBe(0)
  const payloads = agentStatusPayloads(hostEvents)
  expect(payloads.map((p) => p.status)).toEqual([
    'spawning',
    'initializing',
    'ready',
    'restarting',
    'spawning',
    'initializing',
    'ready',
  ])
  expect(payloads.map((p) => p.restartCount)).toEqual([0, 0, 0, 1, 1, 1, 0])
})

test('on-crash restart without resumeSession capability keeps the session disconnected', async () => {
  const { host, agentId, sessionId, hostEvents } = await crashSession(
    { restart: 'on-crash', restartBackoff: tinyBackoff },
    crashTurnScenario(),
  )

  await waitFor(() => host.getAgent(agentId)?.status === 'ready')
  await waitFor(
    () =>
      diagnosticPayloads(hostEvents, 'session/recovery-skipped').length !== 0,
  )

  expect(host.getSession(sessionId)?.status).toBe('disconnected')
})

test('session/resume failure during auto recovery keeps the session disconnected with a diagnostic', async () => {
  const { host, agentId, sessionId, hostEvents } = await crashSession(
    { restart: 'on-crash', restartBackoff: tinyBackoff },
    crashTurnScenario({
      initialize: {
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      },
      resumeSession: { error: { code: -32603, message: 'resume boom' } },
    }),
  )

  await waitFor(() => host.getAgent(agentId)?.status === 'ready')
  await waitFor(
    () => diagnosticPayloads(hostEvents, 'session/resume-failed').length !== 0,
  )

  expect(host.getAgent(agentId)?.status).toBe('ready')
  expect(host.getSession(sessionId)?.status).toBe('disconnected')
  const failed = diagnosticPayloads(hostEvents, 'session/resume-failed')[0]
  expect(failed).toMatchObject({
    level: 'warn',
    sessionId,
    message: expect.stringContaining('resume boom'),
  })
})

test('explicit loadSession failure rejects without mutating the existing session, and a later load fully recovers', async () => {
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const mcpServers = [{ name: 'svc', command: '/bin/echo', args: [], env: [] }]
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
      },
    },
    session: { sessionId: 'sess-load' },
    loadSession: {
      error: { code: -32603, message: 'first load boom' },
      failures: 1,
    },
    resumeSession: { expectMcpServers: mcpServers },
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'after-recovery' },
            },
          },
        ],
      },
    ],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const sessionId = created.sessionId
  const sessionEvents = collectEvents(host, sessionId)

  const error = await rejectionOf(
    host.loadSession(agent.agentId, sessionId, sessionParams('/tmp')),
  )
  expect(error).toMatchObject({ message: expect.stringContaining('boom') })
  expect(host.getSession(sessionId)?.status).toBe('active')
  expect(diagnosticPayloads(hostEvents, 'session/load-failed')).toHaveLength(1)
  expect(sessionStatusPayloads(sessionEvents).map((p) => p.status)).toEqual([
    'active',
    'resuming',
    'active',
  ])

  await host.loadSession(
    agent.agentId,
    sessionId,
    sessionParams('/tmp', { mcpServers }),
  )
  expect(host.getSession(sessionId)?.status).toBe('active')
  expect(sessionStatusPayloads(sessionEvents).at(-1)).toEqual({
    status: 'active',
    resumed: true,
  })

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  const chunks = sessionEvents.filter(
    (event) => event.type === 'agent-message-chunk',
  )
  expect(chunks).toHaveLength(1)

  await host.resumeSession(
    agent.agentId,
    sessionId,
    resumeParams('/tmp', { mcpServers }),
  )
  expect(host.getSession(sessionId)?.status).toBe('active')
})

test('repeated pre-ready failures during restart exhaust the limit (restart-exhausted)', async () => {
  const { host, agentId, scenarioPath, hostEvents } = await crashSession(
    { restart: 'on-crash', restartLimit: 2, restartBackoff: tinyBackoff },
    crashTurnScenario(),
  )
  await writeFile(scenarioPath, 'not json at all', 'utf8')

  await waitFor(
    () =>
      host.getAgent(agentId)?.status === 'exited' &&
      host.getAgent(agentId)?.reason === 'restart-exhausted',
    10_000,
  )

  expect(host.getAgent(agentId)?.reason).toBe('restart-exhausted')
  expect(diagnosticPayloads(hostEvents, 'agent/restart-exhausted').length).toBe(
    1,
  )
  const scheduled = diagnosticPayloads(hostEvents, 'agent/restart-scheduled')
  expect(scheduled.length).toBe(2)
}, 15_000)

test('dispose during the restarting backoff window settles exited(disposed) without respawn', async () => {
  const { host, agentId, hostEvents } = await crashSession(
    {
      restart: 'on-crash',
      restartBackoff: { initialMs: 60_000, factor: 2, maxMs: 60_000 },
    },
    crashTurnScenario(),
  )
  await waitFor(() => host.getAgent(agentId)?.status === 'restarting')

  await host.dispose()

  expect(host.getAgent(agentId)?.status).toBe('exited')
  expect(host.getAgent(agentId)?.reason).toBe('disposed')
  const statuses = agentStatusPayloads(hostEvents).map((p) => p.status)
  expect(statuses.at(-1)).toBe('exited')
  expect(statuses.filter((status) => status === 'spawning')).toHaveLength(1)
  const lastPayload = agentStatusPayloads(hostEvents).at(-1)
  expect(lastPayload).toMatchObject({ status: 'exited', reason: 'disposed' })
})

test('capability loss across restart keeps the session disconnected', async () => {
  const { host, agentId, sessionId, hostEvents, scenarioPath } =
    await crashSession(
      { restart: 'on-crash', restartBackoff: tinyBackoff },
      crashTurnScenario({
        initialize: { agentCapabilities: { loadSession: true } },
        loadSession: { replay: [] },
      }),
    )
  const downgraded = crashTurnScenario({
    initialize: { agentCapabilities: { loadSession: false } },
  })
  await writeFile(scenarioPath, JSON.stringify(downgraded), 'utf8')

  await waitFor(() => host.getAgent(agentId)?.status === 'ready')
  await waitFor(
    () =>
      diagnosticPayloads(hostEvents, 'session/recovery-skipped').length !== 0,
  )

  expect(host.getSession(sessionId)?.status).toBe('disconnected')
})

test('on-crash policy does not restart an agent that never reached ready: spawn failure exits terminally', async () => {
  const host = trackHost(
    createAcpHost({ restart: 'on-crash', restartBackoff: tinyBackoff }),
  )
  const hostEvents = collectEvents(host, undefined)

  const error = await rejectionOf(
    host.spawnAgent({ id: 'missing', command: '/nonexistent/definitely-not' }),
  )

  expect(error).toMatchObject({ code: 'acpjs/agent-exited' })
  await waitFor(
    () => agentStatusPayloads(hostEvents).at(-1)?.status === 'exited',
  )

  const payloads = agentStatusPayloads(hostEvents)
  expect(payloads.at(-1)).toMatchObject({
    status: 'exited',
    reason: 'spawn-failed',
  })
  expect(payloads.map((payload) => payload.status)).not.toContain('restarting')
  expect(diagnosticPayloads(hostEvents, 'agent/restart-scheduled').length).toBe(
    0,
  )
})
