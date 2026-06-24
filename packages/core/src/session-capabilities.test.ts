import { expect, test } from 'vitest'

import { createAcpHost } from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  resumeParams,
  sessionParams,
  trackHost,
} from './test-harness.ts'

import type { FixtureScenario } from '@acpjs/fixture-agent'
import type { AcpjsSessionEvent } from '@acpjs/protocol'

async function activeSession(scenario: FixtureScenario) {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition(scenario)
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active session')
  return { host, agentId: agent.agentId, sessionId: created.sessionId }
}

test('capability-gated methods reject with acpjs/capability-unsupported when undeclared', async () => {
  const { host, agentId, sessionId } = await activeSession({})

  expect(await rejectionOf(host.listSessions(agentId))).toMatchObject({
    code: 'acpjs/capability-unsupported',
  })
  expect(
    await rejectionOf(host.resumeSession(agentId, sessionId, resumeParams())),
  ).toMatchObject({
    code: 'acpjs/capability-unsupported',
  })
  expect(
    await rejectionOf(host.loadSession(agentId, sessionId, sessionParams())),
  ).toMatchObject({ code: 'acpjs/capability-unsupported' })
  expect(await rejectionOf(host.setMode(sessionId, 'plan'))).toMatchObject({
    code: 'acpjs/capability-unsupported',
  })
  expect(
    await rejectionOf(host.setConfigOption(sessionId, 'x', { value: 'y' })),
  ).toMatchObject({ code: 'acpjs/capability-unsupported' })
  await host.deleteSession(agentId, sessionId)
  expect(host.getSession(sessionId)).toBeUndefined()
})

test('capability-gated methods pass through when declared', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: {
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
      },
    },
    session: {
      sessionId: 'sess-caps',
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      configOptions: [
        {
          type: 'boolean',
          id: 'verbose',
          name: 'Verbose',
          currentValue: false,
        },
      ],
    },
    listSessions: {
      sessions: [{ sessionId: 'sess-caps', cwd: '/tmp' }],
      nextCursor: 'cursor-2',
    },
    setConfigOption: {
      configOptions: [
        { type: 'boolean', id: 'verbose', name: 'Verbose', currentValue: true },
      ],
    },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')
  const sessionId = created.sessionId
  const events = collectEvents(host, sessionId) as AcpjsSessionEvent[]

  const listed = await host.listSessions(agent.agentId)
  expect(listed.sessions).toEqual([{ sessionId: 'sess-caps', cwd: '/tmp' }])
  expect(listed.nextCursor).toBe('cursor-2')

  await expect(host.setMode(sessionId, 'plan')).rejects.toMatchObject({
    code: 'acpjs/capability-unsupported',
  })

  const configOptions = await host.setConfigOption(sessionId, 'verbose', {
    type: 'boolean',
    value: true,
  })
  expect(configOptions).toEqual([
    { type: 'boolean', id: 'verbose', name: 'Verbose', currentValue: true },
  ])
  const configEvent = events.findLast(
    (event) => event.type === 'config-options-update',
  )
  expect(configEvent?.payload).toEqual({ configOptions })

  await host.resumeSession(agent.agentId, sessionId, resumeParams('/tmp'))
  expect(host.getSession(sessionId)?.status).toBe('active')

  await host.deleteSession(agent.agentId, sessionId)
  expect(host.getSession(sessionId)).toBeUndefined()
})

test('closeSession closes locally when the agent declares the close capability', async () => {
  const host = trackHost(createAcpHost())
  const { definition } = await fixtureDefinition({
    initialize: {
      agentCapabilities: { sessionCapabilities: { close: {} } },
    },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')

  await host.closeSession(created.sessionId)

  expect(host.getSession(created.sessionId)?.status).toBe('closed')
})
