import { expect, test, vi } from 'vitest'

import { createFixtureAgent, type FixtureIo } from './agent.ts'

import type { AgentSideConnection } from '@agentclientprotocol/sdk'

test('rawUpdate writes the session/update envelope through raw io, bypassing the SDK connection entirely', async () => {
  const sessionUpdate = vi.fn(async () => {})
  const conn = { sessionUpdate } as unknown as AgentSideConnection
  const writeRaw = vi.fn()
  const io: FixtureIo = {
    writeRaw,
    exit(code) {
      throw new Error(`exit ${String(code)}`)
    },
  }
  const update = { sessionUpdate: 'vendor_custom', payload: { deep: [1] } }
  const agent = createFixtureAgent(
    { turns: [{ steps: [{ kind: 'rawUpdate', update }] }] },
    conn,
    io,
  )

  const result = await agent.prompt({
    sessionId: 'sess-raw',
    prompt: [{ type: 'text', text: 'go' }],
  })

  expect(result).toEqual({ stopReason: 'end_turn' })
  expect(writeRaw).toHaveBeenCalledTimes(1)
  expect(writeRaw).toHaveBeenCalledWith({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'sess-raw', update },
  })
  expect(sessionUpdate).not.toHaveBeenCalled()
})

test('loadSession error script fails the first N calls then replays normally', async () => {
  const sessionUpdate = vi.fn(async () => {})
  const conn = { sessionUpdate } as unknown as AgentSideConnection
  const io: FixtureIo = {
    writeRaw: vi.fn(),
    exit(code) {
      throw new Error(`exit ${String(code)}`)
    },
  }
  const agent = createFixtureAgent(
    {
      initialize: { agentCapabilities: { loadSession: true } },
      loadSession: {
        error: { code: -32603, message: 'load boom' },
        failures: 1,
        replay: [
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'replayed' },
          },
        ],
      },
    },
    conn,
    io,
  )

  const params = { sessionId: 'sess-load', cwd: '/tmp', mcpServers: [] }
  await expect(agent.loadSession?.(params)).rejects.toMatchObject({
    code: -32603,
    message: expect.stringContaining('load boom'),
  })
  await expect(agent.loadSession?.(params)).resolves.toEqual({})
  expect(sessionUpdate).toHaveBeenCalledTimes(1)
})

test('resumeSession with expectMcpServers rejects calls whose mcpServers differ', async () => {
  const conn = {
    sessionUpdate: vi.fn(async () => {}),
  } as unknown as AgentSideConnection
  const io: FixtureIo = {
    writeRaw: vi.fn(),
    exit(code) {
      throw new Error(`exit ${String(code)}`)
    },
  }
  const mcpServers = [{ name: 'svc', command: '/bin/echo', args: [] }]
  const agent = createFixtureAgent(
    {
      initialize: {
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      },
      resumeSession: { expectMcpServers: mcpServers },
    },
    conn,
    io,
  )

  await expect(
    agent.resumeSession?.({ sessionId: 's', cwd: '/tmp', mcpServers }),
  ).resolves.toEqual({})
  await expect(
    agent.resumeSession?.({ sessionId: 's', cwd: '/tmp', mcpServers: [] }),
  ).rejects.toMatchObject({ code: -32602 })
})
