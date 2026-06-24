import { expect, test } from 'vitest'

import {
  createAcpHost,
  createHostEndpoint,
  type StorageAdapter,
} from './index.ts'
import {
  fixtureDefinition,
  sessionParams,
  trackHost,
  waitFor,
} from './test-harness.ts'

import type { FixtureScenario } from '@acpjs/fixture-agent'
import type { AcpjsEvent, InboundRequest, HostResponse } from '@acpjs/protocol'

const PERMISSION_SCENARIO: FixtureScenario = {
  turns: [
    {
      steps: [
        {
          kind: 'permission',
          toolCall: { toolCallId: 'call_1', kind: 'execute' },
          options: [
            { kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' },
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
        },
      ],
    },
  ],
}

async function spawnAndCreate(scenario: FixtureScenario) {
  const host = trackHost(createAcpHost())
  const endpoint = createHostEndpoint(host)
  const { definition } = await fixtureDefinition(scenario)
  const spawned = await endpoint.request({
    id: 'r-spawn',
    method: 'agents/spawn',
    params: { definition },
  })
  if (!spawned.ok) throw new Error('spawn failed')
  const agentId = (spawned.result as { agentId: string }).agentId
  const created = await endpoint.request({
    id: 'r-create',
    method: 'sessions/create',
    params: { agentId, ...sessionParams('/tmp') },
  })
  if (!created.ok) throw new Error('create failed')
  const sessionId = (created.result as { sessionId: string }).sessionId
  return { host, endpoint, agentId, sessionId, spawned, created }
}

test('the endpoint maps envelope requests onto host methods and answers with HostResponse', async () => {
  const { endpoint, sessionId, spawned, created } = await spawnAndCreate({
    turns: [
      {
        steps: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hi' },
            },
          },
        ],
      },
    ],
  })

  expect(spawned).toMatchObject({ id: 'r-spawn', ok: true })
  expect(created).toMatchObject({
    id: 'r-create',
    ok: true,
    result: { status: 'active', sessionId },
  })

  const events: AcpjsEvent[] = []
  endpoint.subscribe({ sessionId, fromSeq: 0 }, (event) => events.push(event))

  const prompted = await endpoint.request({
    id: 'r-prompt',
    method: 'sessions/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
  })

  expect(prompted).toEqual({
    id: 'r-prompt',
    ok: true,
    result: { stopReason: 'end_turn' },
  })
  expect(events.some((event) => event.type === 'agent-message-chunk')).toBe(
    true,
  )
  for (const value of [spawned, created, prompted, ...events]) {
    expect(() => structuredClone(value)).not.toThrow()
  }
})

test('host errors cross the envelope as typed ErrorObject responses', async () => {
  const { endpoint, agentId } = await spawnAndCreate({})

  const gated = await endpoint.request({
    id: 'r-list',
    method: 'sessions/list',
    params: { agentId },
  })
  expect(gated).toEqual({
    id: 'r-list',
    ok: false,
    error: {
      code: 'acpjs/capability-unsupported',
      message: 'agent does not support session/list',
      retryable: false,
    },
  })

  const unknown = await endpoint.request({
    id: 'r-unknown',
    method: 'nope/never',
    params: {},
  })
  expect(unknown).toMatchObject({
    id: 'r-unknown',
    ok: false,
    error: { code: 'acpjs/config-invalid' },
  })
})

test('prompt protocol errors cross the adapter as acpjs/agent-error responses', async () => {
  const { host, endpoint, sessionId } = await spawnAndCreate({
    turns: [
      {
        steps: [
          { kind: 'error', code: -32603, message: 'boom', data: { x: 1 } },
        ],
      },
    ],
  })

  const prompted = await endpoint.request({
    id: 'r-prompt-error',
    method: 'sessions/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
  })

  expect(prompted).toEqual({
    id: 'r-prompt-error',
    ok: false,
    error: {
      code: 'acpjs/agent-error',
      message: 'boom',
      data: { code: -32603, message: 'boom', data: { x: 1 } },
      retryable: false,
    },
  })
  expect(host.getSession(sessionId)?.status).toBe('active')
  await expect(
    endpoint.request({
      id: 'r-prompt-retry',
      method: 'sessions/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'retry' }] },
    }),
  ).resolves.toEqual({
    id: 'r-prompt-retry',
    ok: true,
    result: { stopReason: 'end_turn' },
  })
})

test('requests missing required params are rejected with acpjs/config-invalid at the adapter boundary', async () => {
  const { endpoint } = await spawnAndCreate({})

  const cases: { method: string; params: Record<string, unknown> }[] = [
    { method: 'agents/spawn', params: {} },
    { method: 'sessions/create', params: { cwd: '/tmp' } },
    {
      method: 'sessions/resume',
      params: {
        agentId: 'agent-1',
        sessionId: 's',
        additionalDirectories: [],
      },
    },
    { method: 'sessions/prompt', params: { prompt: [] } },
    { method: 'sessions/setMode', params: { sessionId: 's' } },
    {
      method: 'sessions/setConfigOption',
      params: { sessionId: 's', configId: 'c' },
    },
  ]
  for (const [index, { method, params }] of cases.entries()) {
    const response = await endpoint.request({
      id: `r-missing-${index}`,
      method,
      params,
    })
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'acpjs/config-invalid' },
    })
  }
})

test('pending permissions are forwarded as inbound requests and answered via respondInbound', async () => {
  const { endpoint, sessionId } = await spawnAndCreate(PERMISSION_SCENARIO)
  const inbound: InboundRequest[] = []
  endpoint.onInboundRequest((request) => inbound.push(request))

  const prompting = endpoint.request({
    id: 'r-prompt',
    method: 'sessions/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
  })
  await waitFor(() => inbound.length === 1)

  expect(inbound[0]).toMatchObject({
    kind: 'permission',
    payload: {
      sessionId,
      toolCall: { toolCallId: 'call_1', kind: 'execute' },
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' }],
    },
  })
  expect(() => structuredClone(inbound[0])).not.toThrow()

  await endpoint.respondInbound({
    id: inbound[0]?.id ?? '',
    result: { outcome: 'selected', optionId: 'opt-allow' },
  })
  const prompted: HostResponse = await prompting
  expect(prompted).toMatchObject({
    ok: true,
    result: { stopReason: 'end_turn' },
  })

  await expect(
    endpoint.respondInbound({
      id: inbound[0]?.id ?? '',
      result: { outcome: 'cancelled' },
    }),
  ).rejects.toMatchObject({ code: 'acpjs/already-answered' })
})

test('a throwing inbound handler is isolated and reported as a subscriber/error diagnostic', async () => {
  const { host, endpoint, sessionId } =
    await spawnAndCreate(PERMISSION_SCENARIO)
  const hostEvents: AcpjsEvent[] = []
  host.subscribe(undefined, 0, (event) => hostEvents.push(event))
  const inbound: InboundRequest[] = []
  endpoint.onInboundRequest(() => {
    throw new Error('boom')
  })
  endpoint.onInboundRequest((request) => inbound.push(request))

  const prompting = endpoint.request({
    id: 'r-prompt',
    method: 'sessions/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
  })
  await waitFor(() => inbound.length === 1)

  expect(
    hostEvents.some(
      (event) =>
        event.type === 'diagnostic' &&
        event.payload.code === 'subscriber/error' &&
        event.payload.message.includes('boom'),
    ),
  ).toBe(true)

  await endpoint.respondInbound({
    id: inbound[0]?.id ?? '',
    result: { outcome: 'cancelled' },
  })
  await prompting
})

test('a handler attached after the permission was created still receives it while pending', async () => {
  const { endpoint, sessionId } = await spawnAndCreate(PERMISSION_SCENARIO)
  const events: AcpjsEvent[] = []
  endpoint.subscribe({ sessionId, fromSeq: 0 }, (event) => events.push(event))

  const prompting = endpoint.request({
    id: 'r-prompt',
    method: 'sessions/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
  })
  await waitFor(() =>
    events.some((event) => event.type === 'permission-request-created'),
  )

  const inbound: InboundRequest[] = []
  endpoint.onInboundRequest((request) => inbound.push(request))
  expect(inbound).toHaveLength(1)

  await endpoint.respondInbound({
    id: inbound[0]?.id ?? '',
    result: { outcome: 'cancelled' },
  })
  await prompting
})

test('a reattached inbound handler receives permissions that are still pending', async () => {
  const { endpoint, sessionId } = await spawnAndCreate(PERMISSION_SCENARIO)
  const events: AcpjsEvent[] = []
  endpoint.subscribe({ sessionId, fromSeq: 0 }, (event) => events.push(event))
  const inbound: InboundRequest[] = []
  const retained: InboundRequest[] = []
  endpoint.onInboundRequest((request) => retained.push(request))
  const handler = (request: InboundRequest): void => {
    inbound.push(request)
  }
  const unsubscribe = endpoint.onInboundRequest(handler)

  const prompting = endpoint.request({
    id: 'r-prompt',
    method: 'sessions/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
  })
  await waitFor(() =>
    events.some((event) => event.type === 'permission-request-created'),
  )
  expect(inbound).toHaveLength(1)
  expect(retained).toHaveLength(1)

  unsubscribe()
  endpoint.onInboundRequest(handler)
  expect(inbound).toHaveLength(2)
  expect(retained).toHaveLength(1)

  await endpoint.respondInbound({
    id: inbound[0]?.id ?? '',
    result: { outcome: 'cancelled' },
  })
  await prompting
})

test('non-AcpError failures map to acpjs/agent-error envelopes, protocol errors keep their info in data', async () => {
  const stubHost = {
    async spawnAgent() {
      throw new TypeError('native boom')
    },
    async createSession() {
      const error = new Error('agent said no') as Error & {
        code: number
        data: unknown
      }
      error.code = -32603
      error.data = { detail: 'x' }
      throw error
    },
  } as unknown as Parameters<typeof createHostEndpoint>[0]
  const endpoint = createHostEndpoint(stubHost)

  const native = await endpoint.request({
    id: 'r-native',
    method: 'agents/spawn',
    params: { definition: { id: 'a', command: 'node' } },
  })
  expect(native).toEqual({
    id: 'r-native',
    ok: false,
    error: {
      code: 'acpjs/agent-error',
      message: 'native boom',
      retryable: false,
    },
  })

  const protocol = await endpoint.request({
    id: 'r-protocol',
    method: 'sessions/create',
    params: {
      agentId: 'a',
      cwd: '/tmp',
      mcpServers: [],
      additionalDirectories: [],
    },
  })
  expect(protocol).toEqual({
    id: 'r-protocol',
    ok: false,
    error: {
      code: 'acpjs/agent-error',
      message: 'agent said no',
      data: { code: -32603, message: 'agent said no', data: { detail: 'x' } },
      retryable: false,
    },
  })
})

test('discovery queries sessions/getAll, agents/list and sessions/restore round-trip through the endpoint', async () => {
  const stored: AcpjsEvent = {
    sessionId: 'sess-old',
    seq: 1,
    ts: 0,
    type: 'session-status-change',
    payload: { status: 'disconnected' },
  }
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta() {},
    listSessions: () => [
      { sessionId: 'sess-old', cwd: '', additionalDirectories: [] },
    ],
    loadEvents: () => [stored],
    replaceSession() {},
  }
  const host = trackHost(createAcpHost({ storage }))
  const endpoint = createHostEndpoint(host)
  const { definition } = await fixtureDefinition({
    session: { sessionId: 'sess-live' },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')

  const sessions = await endpoint.request({
    id: 'r-all',
    method: 'sessions/getAll',
    params: {},
  })
  expect(sessions).toEqual({
    id: 'r-all',
    ok: true,
    result: [
      {
        sessionId: 'sess-live',
        status: 'active',
        agentId: agent.agentId,
        cwd: '/tmp',
        mcpServers: [],
        additionalDirectories: [],
        agentDefinitionId: 'fixture',
      },
    ],
  })

  const agents = await endpoint.request({
    id: 'r-agents',
    method: 'agents/list',
    params: {},
  })
  expect(agents).toEqual({
    id: 'r-agents',
    ok: true,
    result: host.getAgents(),
  })

  const restored = await endpoint.request({
    id: 'r-restore',
    method: 'sessions/restore',
    params: {},
  })
  expect(restored).toEqual({
    id: 'r-restore',
    ok: true,
    result: [
      {
        sessionId: 'sess-old',
        status: 'disconnected',
        cwd: '',
        additionalDirectories: [],
      },
    ],
  })
  expect(host.getSessions()).toContainEqual({
    sessionId: 'sess-old',
    status: 'disconnected',
    cwd: '',
    additionalDirectories: [],
  })
})
