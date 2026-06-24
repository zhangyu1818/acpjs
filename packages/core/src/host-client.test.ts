import {
  agent as createAgentApp,
  methods,
  type ClientRequestResponsesByMethod,
} from '@agentclientprotocol/sdk'
import { expect, test } from 'vitest'

import { createAgentClient } from './host-client.ts'

type CreateAgentClientContext = Parameters<typeof createAgentClient>[0]
type TerminalCreateResponse =
  ClientRequestResponsesByMethod[typeof methods.client.terminal.create]

function terminalStub() {
  return {
    async createTerminal(): Promise<TerminalCreateResponse> {
      return { terminalId: 't1' }
    },
    async terminalOutput() {
      return { output: '', truncated: false }
    },
    async waitForTerminalExit() {
      return { exitCode: 0 }
    },
    async killTerminal() {
      return {}
    },
    async releaseTerminal() {
      return {}
    },
    cleanupSession() {},
  }
}

function contextWithTwoSessions(): CreateAgentClientContext {
  const sessions = new Map<string, unknown>([
    ['A', { sessionId: 'A', agentId: 'agent-1', status: 'active' }],
    ['B', { sessionId: 'B', agentId: 'agent-1', status: 'active' }],
  ])
  return {
    sessions: { sessions },
    bus: {},
    router: {},
    fsHandler: {},
    terminalHandler: terminalStub(),
  } as unknown as CreateAgentClientContext
}

test('host rejects terminal access from a session that does not own the terminal', async () => {
  const clientApp = createAgentClient(contextWithTwoSessions(), 'agent-1')
  const agentApp = createAgentApp({
    name: '@acpjs/core-host-client-test',
  }).onRequest(methods.agent.session.prompt, async ({ client }) => {
    const created = await client.request(methods.client.terminal.create, {
      sessionId: 'A',
      command: 'x',
    })

    await expect(
      client.request(methods.client.terminal.output, {
        sessionId: 'A',
        terminalId: created.terminalId,
      }),
    ).resolves.toBeDefined()

    await expect(
      client.request(methods.client.terminal.output, {
        sessionId: 'B',
        terminalId: created.terminalId,
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('belongs to another session'),
    })
    await expect(
      client.request(methods.client.terminal.waitForExit, {
        sessionId: 'B',
        terminalId: created.terminalId,
      }),
    ).rejects.toMatchObject({ code: -32602 })
    await expect(
      client.request(methods.client.terminal.kill, {
        sessionId: 'B',
        terminalId: created.terminalId,
      }),
    ).rejects.toMatchObject({ code: -32602 })
    await expect(
      client.request(methods.client.terminal.release, {
        sessionId: 'B',
        terminalId: created.terminalId,
      }),
    ).rejects.toMatchObject({ code: -32602 })

    await expect(
      client.request(methods.client.terminal.release, {
        sessionId: 'A',
        terminalId: created.terminalId,
      }),
    ).resolves.toBeDefined()
    await expect(
      client.request(methods.client.terminal.output, {
        sessionId: 'A',
        terminalId: created.terminalId,
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('unknown terminal'),
    })
    await expect(
      client.request(methods.client.terminal.output, {
        sessionId: 'A',
        terminalId: 'missing',
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('unknown terminal'),
    })
    return { stopReason: 'end_turn' }
  })
  const connection = clientApp.connect(agentApp)
  try {
    await expect(
      connection.agent.request(methods.agent.session.prompt, {
        sessionId: 'A',
        prompt: [{ type: 'text', text: 'go' }],
      }),
    ).resolves.toEqual({ stopReason: 'end_turn' })
  } finally {
    connection.close()
  }
})
