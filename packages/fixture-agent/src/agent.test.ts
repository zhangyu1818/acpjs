import {
  client as createClientApp,
  methods,
  type McpServer,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { expect, test } from 'vitest'

import { createFixtureAgent, type FixtureIo } from './agent.ts'

function fixtureIo(): FixtureIo {
  return {
    disconnect() {},
    exit(code) {
      throw new Error(`exit ${String(code)}`)
    },
  }
}

function connectFixtureAgent(
  scenario: Parameters<typeof createFixtureAgent>[0],
  io = fixtureIo(),
) {
  const updates: SessionNotification[] = []
  const clientApp = createClientApp({ name: '@acpjs/fixture-agent-unit' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params)
    })
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: 'cancelled' },
    }))
  const connection = clientApp.connect(createFixtureAgent(scenario, io))
  return { connection, updates }
}

test('loadSession error script fails the first N calls then replays normally', async () => {
  const replayUpdate: SessionNotification['update'] = {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'replayed' },
  }
  const { connection, updates } = connectFixtureAgent({
    initialize: { agentCapabilities: { loadSession: true } },
    loadSession: {
      error: { code: -32603, message: 'load boom' },
      failures: 1,
      replay: [replayUpdate],
    },
  })
  const params = { sessionId: 'sess-load', cwd: '/tmp', mcpServers: [] }

  await expect(
    connection.agent.request(methods.agent.session.load, params),
  ).rejects.toMatchObject({
    code: -32603,
    message: expect.stringContaining('load boom'),
  })
  await expect(
    connection.agent.request(methods.agent.session.load, params),
  ).resolves.toEqual({})
  expect(updates).toEqual([{ sessionId: 'sess-load', update: replayUpdate }])
})

test('resumeSession with expectMcpServers rejects calls whose mcpServers differ', async () => {
  const mcpServers: McpServer[] = [
    { name: 'svc', command: '/bin/echo', args: [], env: [] },
  ]
  const { connection } = connectFixtureAgent({
    initialize: {
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    },
    resumeSession: { expectMcpServers: mcpServers },
  })

  await expect(
    connection.agent.request(methods.agent.session.resume, {
      sessionId: 's',
      cwd: '/tmp',
      mcpServers,
    }),
  ).resolves.toEqual({})
  await expect(
    connection.agent.request(methods.agent.session.resume, {
      sessionId: 's',
      cwd: '/tmp',
      mcpServers: [],
    }),
  ).rejects.toMatchObject({ code: -32602 })
})
