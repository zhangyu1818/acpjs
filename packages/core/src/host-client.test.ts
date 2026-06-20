import { expect, test } from 'vitest'

import { createAgentClient } from './host-client.ts'

type CreateAgentClientContext = Parameters<typeof createAgentClient>[0]

function terminalStub() {
  return {
    async createTerminal() {
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
  const client = createAgentClient(contextWithTwoSessions(), 'agent-1')
  const {
    createTerminal,
    terminalOutput,
    waitForTerminalExit,
    killTerminal,
    releaseTerminal,
  } = client
  if (
    !createTerminal ||
    !terminalOutput ||
    !waitForTerminalExit ||
    !killTerminal ||
    !releaseTerminal
  ) {
    throw new Error('terminal methods were not installed')
  }

  const created = await createTerminal({ sessionId: 'A', command: 'x' })
  expect(created.terminalId).toBe('t1')

  // The owning session can use the terminal.
  await expect(
    terminalOutput({ sessionId: 'A', terminalId: 't1' }),
  ).resolves.toBeDefined()

  // A sibling session under the same agent cannot touch another session's
  // terminal across any read/control op.
  await expect(
    terminalOutput({ sessionId: 'B', terminalId: 't1' }),
  ).rejects.toMatchObject({
    code: -32602,
    message: expect.stringContaining('belongs to another session'),
  })
  await expect(
    waitForTerminalExit({ sessionId: 'B', terminalId: 't1' }),
  ).rejects.toMatchObject({ code: -32602 })
  await expect(
    killTerminal({ sessionId: 'B', terminalId: 't1' }),
  ).rejects.toMatchObject({ code: -32602 })
  await expect(
    releaseTerminal({ sessionId: 'B', terminalId: 't1' }),
  ).rejects.toMatchObject({ code: -32602 })

  // The owner can still release it.
  await expect(
    releaseTerminal({ sessionId: 'A', terminalId: 't1' }),
  ).resolves.toBeDefined()
})
