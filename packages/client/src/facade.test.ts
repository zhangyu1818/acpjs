import { expect, test } from 'vitest'

import {
  createAcpClient,
  type AcpAgent,
  type AcpClient,
  type AcpSession,
} from './index.ts'
import {
  createFakeHub,
  rejectionOf,
  resumeParams,
  ScriptedError,
  sessionParams,
  type FakeHub,
} from './test-support.ts'

async function setup(): Promise<{
  hub: FakeHub
  client: AcpClient
  agent: AcpAgent
  session: AcpSession
}> {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({ agentId: 'agent-1' }))
  hub.handle('sessions/create', () => ({
    status: 'active',
    sessionId: 'sess-1',
  }))
  const client = createAcpClient({ transport: hub.connection().transport })
  const agent = await client.agents.spawn({ id: 'a', command: 'node' })
  const session = await agent.sessions.create(sessionParams('/tmp'))
  return { hub, client, agent, session }
}

test('prompt passes content blocks through untouched and returns the prompt result', async () => {
  const { hub, session } = await setup()
  hub.handle('sessions/prompt', () => ({
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  }))
  const blocks = [
    { type: 'text' as const, text: 'hello' },
    {
      type: 'image' as const,
      data: 'aGk=',
      mimeType: 'image/png',
    },
  ]

  const result = await session.prompt(blocks)

  expect(result).toEqual({
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  })
  expect(hub.requests.at(-1)).toMatchObject({
    method: 'sessions/prompt',
    params: { sessionId: 'sess-1', prompt: blocks },
  })
})

test('cancel, close, setMode and setConfigOption map to their session RPCs', async () => {
  const { hub, session } = await setup()
  hub.handle('sessions/cancel', () => null)
  hub.handle('sessions/close', () => null)
  hub.handle('sessions/setMode', () => null)
  hub.handle('sessions/setConfigOption', () => [
    { type: 'boolean', id: 'verbose', name: 'Verbose', currentValue: true },
  ])

  await session.cancel()
  await session.close()
  await session.setMode('plan')
  const configOptions = await session.setConfigOption('verbose', {
    type: 'boolean',
    value: true,
  })

  expect(configOptions).toEqual([
    { type: 'boolean', id: 'verbose', name: 'Verbose', currentValue: true },
  ])
  expect(
    hub.requests.slice(2).map((request) => [request.method, request.params]),
  ).toEqual([
    ['sessions/cancel', { sessionId: 'sess-1' }],
    ['sessions/close', { sessionId: 'sess-1' }],
    ['sessions/setMode', { sessionId: 'sess-1', modeId: 'plan' }],
    [
      'sessions/setConfigOption',
      {
        sessionId: 'sess-1',
        configId: 'verbose',
        value: { type: 'boolean', value: true },
      },
    ],
  ])
})

test('sessions.list, resume and delete map to their RPCs with capability errors passed through', async () => {
  const { hub, agent } = await setup()
  hub.handle('sessions/list', () => ({
    sessions: [{ sessionId: 'sess-1', cwd: '/tmp' }],
    nextCursor: 'cursor-2',
  }))
  hub.handle('sessions/resume', () => null)
  hub.handle('sessions/delete', () => {
    throw new ScriptedError({
      code: 'acpjs/capability-unsupported',
      message: 'agent does not support session/delete',
      retryable: false,
    })
  })

  const listed = await agent.sessions.list({ cursor: 'cursor-1' })
  expect(listed).toEqual({
    sessions: [{ sessionId: 'sess-1', cwd: '/tmp' }],
    nextCursor: 'cursor-2',
  })

  const resumed = await agent.sessions.resume('sess-1', resumeParams('/tmp'))
  expect(resumed.sessionId).toBe('sess-1')

  const error = await rejectionOf(agent.sessions.delete('sess-1'))
  expect(error).toMatchObject({ code: 'acpjs/capability-unsupported' })

  expect(
    hub.requests.slice(2).map((request) => [request.method, request.params]),
  ).toEqual([
    ['sessions/list', { agentId: 'agent-1', cursor: 'cursor-1' }],
    [
      'sessions/resume',
      { agentId: 'agent-1', sessionId: 'sess-1', ...resumeParams('/tmp') },
    ],
    ['sessions/delete', { agentId: 'agent-1', sessionId: 'sess-1' }],
  ])
})

test('agents.list returns the host agent snapshots over the agents/list RPC', async () => {
  const { hub, client } = await setup()
  hub.handle('agents/list', () => [
    { agentId: 'agent-1', status: 'ready', restartCount: 0 },
    {
      agentId: 'agent-2',
      status: 'exited',
      restartCount: 1,
      reason: 'crashed',
    },
  ])

  const listed = await client.agents.list()

  expect(listed).toEqual([
    { agentId: 'agent-1', status: 'ready', restartCount: 0 },
    {
      agentId: 'agent-2',
      status: 'exited',
      restartCount: 1,
      reason: 'crashed',
    },
  ])
  expect(hub.requests.at(-1)).toMatchObject({
    method: 'agents/list',
    params: {},
  })
})

test('sessions.list returns the host session snapshots over the sessions/getAll RPC', async () => {
  const { hub, client } = await setup()
  hub.handle('sessions/getAll', () => [
    { sessionId: 'sess-1', status: 'active', agentId: 'agent-1', cwd: '/tmp' },
    { sessionId: 'sess-old', status: 'disconnected' },
  ])

  const listed = await client.sessions.list()

  expect(listed).toEqual([
    { sessionId: 'sess-1', status: 'active', agentId: 'agent-1', cwd: '/tmp' },
    { sessionId: 'sess-old', status: 'disconnected' },
  ])
  expect(hub.requests.at(-1)).toMatchObject({
    method: 'sessions/getAll',
    params: {},
  })
})

test('sessions.restore triggers host recovery over the sessions/restore RPC and returns the snapshots', async () => {
  const { hub, client } = await setup()
  hub.handle('sessions/restore', () => [
    { sessionId: 'sess-old', status: 'disconnected' },
  ])

  const restored = await client.sessions.restore()

  expect(restored).toEqual([{ sessionId: 'sess-old', status: 'disconnected' }])
  expect(hub.requests.at(-1)).toMatchObject({
    method: 'sessions/restore',
    params: {},
  })
})
