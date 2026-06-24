import { expect, test } from 'vitest'

import { chunk, startSession } from './e2e-harness.ts'

import type { SessionNotification } from '@agentclientprotocol/sdk'

test('prompt replays all 13 session/update variants in order and returns scripted stopReason with usage', async () => {
  const text = { type: 'text' as const, text: 'hi' }
  const allUpdates: SessionNotification['update'][] = [
    { sessionUpdate: 'user_message_chunk', content: text, messageId: 'm1' },
    { sessionUpdate: 'agent_message_chunk', content: text, messageId: 'm2' },
    { sessionUpdate: 'agent_thought_chunk', content: text },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Read file',
      kind: 'read',
      status: 'pending',
      locations: [{ path: '/tmp/a.txt', line: 1 }],
      rawInput: { path: '/tmp/a.txt' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [
        { type: 'content', content: text },
        { type: 'diff', path: '/tmp/a.txt', oldText: 'a', newText: 'b' },
        { type: 'terminal', terminalId: 'term-1' },
      ],
      rawOutput: { ok: true },
    },
    {
      sessionUpdate: 'plan',
      entries: [{ content: 'step', priority: 'high', status: 'pending' }],
    },
    {
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        id: 'p1',
        entries: [{ content: 'step', priority: 'low', status: 'completed' }],
      },
    },
    { sessionUpdate: 'plan_removed', id: 'p1' },
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'review', description: 'review code', input: { hint: 'path' } },
      ],
    },
    { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          type: 'boolean',
          id: 'verbose',
          name: 'Verbose',
          currentValue: true,
        },
      ],
    },
    { sessionUpdate: 'session_info_update', title: 'My session' },
    {
      sessionUpdate: 'usage_update',
      size: 200_000,
      used: 1234,
      cost: { amount: 0.5, currency: 'USD' },
    },
  ]
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
  const { conn, sessionId, updates } = await startSession({
    turns: [
      {
        steps: allUpdates.map((update) => ({ kind: 'update', update })),
        stopReason: 'max_tokens',
        usage,
      },
    ],
  })

  const result = await conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'go' }],
  })

  expect(result).toEqual({ stopReason: 'max_tokens', usage })
  expect(updates.map((notification) => notification.sessionId)).toEqual(
    Array.from({ length: 13 }, () => sessionId),
  )
  expect(updates.map((notification) => notification.update)).toEqual(allUpdates)
})

test('consecutive prompts consume scripted turns in order then fall back to end_turn', async () => {
  const { conn, sessionId } = await startSession({
    turns: [{ stopReason: 'max_tokens' }, { stopReason: 'refusal' }],
  })
  const prompt = [{ type: 'text' as const, text: 'go' }]

  await expect(conn.prompt({ sessionId, prompt })).resolves.toEqual({
    stopReason: 'max_tokens',
  })
  await expect(conn.prompt({ sessionId, prompt })).resolves.toEqual({
    stopReason: 'refusal',
  })
  await expect(conn.prompt({ sessionId, prompt })).resolves.toEqual({
    stopReason: 'end_turn',
  })
})

test('error step rejects the prompt with the scripted protocol error', async () => {
  const { conn, sessionId, updates } = await startSession({
    turns: [
      {
        steps: [
          { kind: 'update', update: chunk('before failure') },
          {
            kind: 'error',
            code: -32603,
            message: 'scripted failure',
            data: { reason: 'broken' },
          },
        ],
      },
    ],
  })

  await expect(
    conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }),
  ).rejects.toMatchObject({
    code: -32603,
    message: 'scripted failure',
    data: { reason: 'broken' },
  })
  expect(updates.map((notification) => notification.update)).toEqual([
    chunk('before failure'),
  ])
})

test('exit step crashes the agent process with the scripted exit code mid-prompt', async () => {
  const { child, conn, sessionId } = await startSession({
    turns: [
      {
        steps: [
          { kind: 'update', update: chunk('about to crash') },
          { kind: 'exit', code: 7 },
        ],
      },
    ],
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })

  await expect(
    conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }),
  ).rejects.toThrow()

  await expect(exited).resolves.toBe(7)
})

test('session/cancel interrupts a sleeping prompt, ends the turn with stopReason cancelled and discards remaining steps', async () => {
  let started: (() => void) | undefined
  const firstUpdate = new Promise<void>((resolve) => {
    started = resolve
  })
  const received: SessionNotification['update'][] = []
  const { conn, sessionId } = await startSession(
    {
      turns: [
        {
          steps: [
            { kind: 'update', update: chunk('begin') },
            { kind: 'sleep', ms: 60_000 },
            { kind: 'update', update: chunk('never sent') },
          ],
        },
      ],
    },
    {
      async sessionUpdate(params) {
        received.push(params.update)
        started?.()
      },
    },
  )

  const promptPromise = conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'go' }],
  })
  await firstUpdate
  await conn.cancel({ sessionId })

  await expect(promptPromise).resolves.toEqual({ stopReason: 'cancelled' })

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(received).toEqual([chunk('begin')])
})
