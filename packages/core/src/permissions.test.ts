import { expect, test } from 'vitest'

import { createAcpHost, type HostOptions } from './index.ts'
import {
  collectEvents,
  fixtureDefinition,
  rejectionOf,
  trackHost,
  waitFor,
} from './test-harness.ts'

import type { FixtureScenario, FixtureStep } from '@acpjs/fixture-agent'
import type {
  AcpSessionEvent,
  PermissionRequestCreatedPayload,
  PermissionRequestResolvedPayload,
} from '@acpjs/protocol'

function permissionStep(
  overrides: Partial<FixtureStep & { kind: 'permission' }> = {},
): FixtureStep {
  return {
    kind: 'permission',
    toolCall: { toolCallId: 'call_1', kind: 'execute' },
    options: [
      { kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' },
      { kind: 'reject_once', name: 'Reject', optionId: 'opt-reject' },
    ],
    onSelected: {
      'opt-allow': [
        {
          kind: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'granted' },
          },
        },
      ],
    },
    ...overrides,
  }
}

async function sessionWithPermission(
  options: HostOptions,
  scenario?: FixtureScenario,
) {
  const host = trackHost(createAcpHost(options))
  const { definition } = await fixtureDefinition(
    scenario ?? { turns: [{ steps: [permissionStep()] }] },
  )
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, { cwd: '/tmp' })
  if (created.status !== 'active') throw new Error('expected active')
  const events = collectEvents(host, created.sessionId) as AcpSessionEvent[]
  return { host, agentId: agent.agentId, sessionId: created.sessionId, events }
}

function createdPayload(
  events: AcpSessionEvent[],
): PermissionRequestCreatedPayload | undefined {
  const event = events.find(
    (candidate) => candidate.type === 'permission-request-created',
  )
  return event?.type === 'permission-request-created'
    ? event.payload
    : undefined
}

function resolvedPayload(
  events: AcpSessionEvent[],
): PermissionRequestResolvedPayload | undefined {
  const event = events.find(
    (candidate) => candidate.type === 'permission-request-resolved',
  )
  return event?.type === 'permission-request-resolved'
    ? event.payload
    : undefined
}

test('unmatched permission floats up, respondPermission answers the protocol once', async () => {
  const { host, sessionId, events } = await sessionWithPermission({})

  const prompting = host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  await waitFor(() => createdPayload(events) !== undefined)
  const created = createdPayload(events)
  expect(created?.requestId).toMatch(/^perm-\d+$/)
  expect(created?.toolCall).toEqual({ toolCallId: 'call_1', kind: 'execute' })
  expect(created?.options).toHaveLength(2)

  host.respondPermission(created?.requestId ?? '', {
    outcome: 'selected',
    optionId: 'opt-allow',
  })
  const result = await prompting

  expect(result.stopReason).toBe('end_turn')
  expect(resolvedPayload(events)).toEqual({
    requestId: created?.requestId,
    status: 'answered',
    outcome: { outcome: 'selected', optionId: 'opt-allow' },
  })
  const granted = events.find((event) => event.type === 'agent-message-chunk')
  expect(granted?.payload).toEqual({
    content: { type: 'text', text: 'granted' },
  })
})

test('second respond is rejected with acpjs/already-answered (INV-8)', async () => {
  const { host, sessionId, events } = await sessionWithPermission({})

  const prompting = host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  await waitFor(() => createdPayload(events) !== undefined)
  const requestId = createdPayload(events)?.requestId ?? ''

  host.respondPermission(requestId, {
    outcome: 'selected',
    optionId: 'opt-allow',
  })
  expect(() =>
    host.respondPermission(requestId, {
      outcome: 'selected',
      optionId: 'opt-reject',
    }),
  ).toThrowError(expect.objectContaining({ code: 'acpjs/already-answered' }))
  await prompting
})

test('matching allow policy answers automatically but still emits audit events', async () => {
  const { host, sessionId, events } = await sessionWithPermission({
    permissionPolicy: [{ kind: 'execute', action: 'allow' }],
  })

  const result = await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  expect(result.stopReason).toBe('end_turn')
  const created = createdPayload(events)
  expect(created).toBeDefined()
  expect(resolvedPayload(events)).toEqual({
    requestId: created?.requestId,
    status: 'answered',
    outcome: { outcome: 'selected', optionId: 'opt-allow' },
  })
  const granted = events.find((event) => event.type === 'agent-message-chunk')
  expect(granted?.payload).toEqual({
    content: { type: 'text', text: 'granted' },
  })
})

test('matching reject policy answers automatically with the reject option', async () => {
  const { host, sessionId, events } = await sessionWithPermission({
    permissionPolicy: [{ action: 'reject' }],
  })

  await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  expect(resolvedPayload(events)).toMatchObject({
    status: 'answered',
    outcome: { outcome: 'selected', optionId: 'opt-reject' },
  })
  expect(
    events.find((event) => event.type === 'agent-message-chunk'),
  ).toBeUndefined()
})

test('auto policy falls back to the *_always option when no *_once option exists', async () => {
  const { host, sessionId, events } = await sessionWithPermission(
    { permissionPolicy: [{ action: 'allow' }] },
    {
      turns: [
        {
          steps: [
            permissionStep({
              options: [
                {
                  kind: 'allow_always',
                  name: 'Always allow',
                  optionId: 'opt-always',
                },
                { kind: 'reject_once', name: 'Reject', optionId: 'opt-reject' },
              ],
              onSelected: {
                'opt-always': [
                  {
                    kind: 'update',
                    update: {
                      sessionUpdate: 'agent_message_chunk',
                      content: { type: 'text', text: 'granted' },
                    },
                  },
                ],
              },
            }),
          ],
        },
      ],
    },
  )

  const result = await host.prompt(sessionId, [{ type: 'text', text: 'go' }])

  expect(result.stopReason).toBe('end_turn')
  expect(resolvedPayload(events)).toMatchObject({
    status: 'answered',
    outcome: { outcome: 'selected', optionId: 'opt-always' },
  })
})

test('kind-specific rules do not match permission requests without kind', async () => {
  const { host, sessionId, events } = await sessionWithPermission(
    { permissionPolicy: [{ kind: 'execute', action: 'allow' }] },
    {
      turns: [
        {
          steps: [permissionStep({ toolCall: { toolCallId: 'call_1' } })],
        },
      ],
    },
  )

  const prompting = host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  await waitFor(() => createdPayload(events) !== undefined)
  const requestId = createdPayload(events)?.requestId ?? ''
  expect(resolvedPayload(events)).toBeUndefined()

  host.respondPermission(requestId, { outcome: 'cancelled' })
  await prompting
})

test('cancel supersedes pending permission requests', async () => {
  const { host, sessionId, events } = await sessionWithPermission({})

  const prompting = host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  await waitFor(() => createdPayload(events) !== undefined)
  const requestId = createdPayload(events)?.requestId ?? ''

  await host.cancel(sessionId)
  const result = await prompting

  expect(result.stopReason).toBe('cancelled')
  expect(resolvedPayload(events)).toEqual({
    requestId,
    status: 'superseded',
  })
  expect(() =>
    host.respondPermission(requestId, { outcome: 'cancelled' }),
  ).toThrowError(expect.objectContaining({ code: 'acpjs/already-answered' }))
})

test('agent crash supersedes pending permissions and rejects the in-flight prompt', async () => {
  const host = trackHost(createAcpHost())
  const hostEvents = collectEvents(host, undefined)
  const { definition } = await fixtureDefinition({
    turns: [{ steps: [permissionStep()] }],
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, { cwd: '/tmp' })
  if (created.status !== 'active') throw new Error('expected active')
  const sessionId = created.sessionId
  const events = collectEvents(host, sessionId) as AcpSessionEvent[]

  const prompting = host.prompt(sessionId, [{ type: 'text', text: 'go' }])
  await waitFor(() => createdPayload(events) !== undefined)
  const requestId = createdPayload(events)?.requestId ?? ''

  const spawnDiag = hostEvents.find(
    (event) =>
      event.type === 'diagnostic' && event.payload.code === 'agent/spawn',
  )
  const pid = (
    (spawnDiag?.type === 'diagnostic' ? spawnDiag.payload.data : undefined) as
      | { pid?: number }
      | undefined
  )?.pid
  expect(pid).toBeDefined()
  process.kill(pid ?? 0, 'SIGKILL')

  const error = await rejectionOf(prompting)
  expect(error).toMatchObject({ code: 'acpjs/agent-exited' })
  await waitFor(() => resolvedPayload(events)?.status === 'superseded')
  expect(resolvedPayload(events)).toEqual({ requestId, status: 'superseded' })
  expect(host.getAgent(agent.agentId)?.reason).toBe('crashed')
  expect(host.getSession(sessionId)?.status).toBe('disconnected')
})
