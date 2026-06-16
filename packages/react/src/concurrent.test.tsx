import { startTransition, useState, type ReactElement } from 'react'

import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { AcpProvider, useAgents, useSession, useSessions } from './index.ts'
import { createTestHarness, sessionParams } from './test-support.ts'

import type { AcpAgent, AcpSession } from '@acpjs/client'
import type { SessionState } from '@acpjs/protocol'

const torn: { a: SessionState | undefined; b: SessionState | undefined }[] = []

function DoubleReader({ label }: { label: string }): ReactElement {
  const a = useSession('sess-1')
  const b = useSession('sess-1')
  if (a?.state !== b?.state) torn.push({ a: a?.state, b: b?.state })
  const text = a?.state.messages
    .map((message) =>
      message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(''),
    )
    .join('|')
  return (
    <div data-testid={`reader-${label}`}>
      {label}:{text ?? ''}
    </div>
  )
}

let forceTransition: () => void = () => {}

function App(): ReactElement {
  const [, setTick] = useState(0)
  forceTransition = () => {
    startTransition(() => setTick((tick) => tick + 1))
  }
  return (
    <>
      <DoubleReader label="a" />
      <DoubleReader label="b" />
    </>
  )
}

test('updates landing during a transition never tear across useSyncExternalStore reads', async () => {
  torn.length = 0
  const harness = createTestHarness()
  render(
    <AcpProvider client={harness.client}>
      <App />
    </AcpProvider>,
  )
  await act(async () => {
    const agent = await harness.client.agents.spawn({
      id: 'a',
      command: 'node',
    })
    await agent.sessions.create(sessionParams())
  })

  for (let index = 0; index < 5; index += 1) {
    act(() => {
      forceTransition()
      harness.emit('sess-1', 'agent-message-chunk', {
        content: { type: 'text', text: `e${index}` },
        messageId: `m${index}`,
      })
      forceTransition()
    })
  }

  expect(torn).toEqual([])
  expect(screen.getByTestId('reader-a').textContent).toBe('a:e0|e1|e2|e3|e4')
  expect(screen.getByTestId('reader-b').textContent).toBe('b:e0|e1|e2|e3|e4')
})

const tornRegistries: {
  agents?: [readonly AcpAgent[], readonly AcpAgent[]]
  sessions?: [readonly AcpSession[], readonly AcpSession[]]
}[] = []

function RegistryReader(): ReactElement {
  const agentsA = useAgents()
  const agentsB = useAgents()
  const sessionsA = useSessions()
  const sessionsB = useSessions()
  if (agentsA !== agentsB) tornRegistries.push({ agents: [agentsA, agentsB] })
  if (sessionsA !== sessionsB) {
    tornRegistries.push({ sessions: [sessionsA, sessionsB] })
  }
  const text = agentsA
    .map((agent) => `${agent.agentId}:${agent.getSnapshot().status}`)
    .join(',')
  return (
    <div data-testid="registries">
      {text};{sessionsA.map((session) => session.sessionId).join(',')}
    </div>
  )
}

test('registry snapshots never tear across reads during transitions', async () => {
  tornRegistries.length = 0
  const harness = createTestHarness()
  render(
    <AcpProvider client={harness.client}>
      <App />
      <RegistryReader />
    </AcpProvider>,
  )
  await act(async () => {
    const agent = await harness.client.agents.spawn({
      id: 'a',
      command: 'node',
    })
    await agent.sessions.create(sessionParams())
  })

  const statuses = ['exited', 'restarting', 'ready', 'exited', 'ready'] as const
  for (const status of statuses) {
    act(() => {
      forceTransition()
      harness.emitHost({
        agentId: 'agent-1',
        type: 'agent-updated',
        payload: { agentId: 'agent-1', status, restartCount: 0 },
      })
      forceTransition()
    })
  }

  expect(tornRegistries).toEqual([])
  expect(screen.getByTestId('registries').textContent).toBe(
    'agent-1:ready;sess-1',
  )
})
