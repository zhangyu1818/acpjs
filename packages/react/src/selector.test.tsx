import { StrictMode, type ReactElement } from 'react'

import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import {
  AcpProvider,
  shallowEqual,
  useAgents,
  useConnectionStatus,
  useSession,
} from './index.ts'
import {
  createTestHarness,
  sessionParams,
  type TestHarness,
} from './test-support.ts'

import type { ToolCallState } from '@acpjs/protocol'

async function setup(): Promise<TestHarness> {
  const harness = createTestHarness()
  return harness
}

async function spawnSession(harness: TestHarness): Promise<void> {
  await act(async () => {
    const agent = await harness.client.agents.spawn({
      id: 'a',
      command: 'node',
    })
    await agent.sessions.create(sessionParams())
  })
}

test('an unchanged slice keeps a stable reference and does not re-render', async () => {
  const harness = await setup()
  let renderCount = 0
  let captured: Record<string, ToolCallState> | undefined

  function Reader(): ReactElement {
    renderCount += 1
    captured = useSession('sess-1', (s) => s.toolCalls)?.state
    return <div data-testid="reader" />
  }

  render(
    <AcpProvider client={harness.client}>
      <Reader />
    </AcpProvider>,
  )
  await spawnSession(harness)

  const before = captured
  const countBefore = renderCount
  act(() => {
    harness.emit('sess-1', 'agent-message-chunk', {
      content: { type: 'text', text: 'x' },
      messageId: 'm0',
    })
  })

  expect(captured).toBe(before)
  expect(renderCount).toBe(countBefore)
})

test('a changed slice re-renders with the new value', async () => {
  const harness = await setup()
  let renderCount = 0
  let captured: Record<string, ToolCallState> | undefined

  function Reader(): ReactElement {
    renderCount += 1
    captured = useSession('sess-1', (s) => s.toolCalls)?.state
    return <div data-testid="reader" />
  }

  render(
    <AcpProvider client={harness.client}>
      <Reader />
    </AcpProvider>,
  )
  await spawnSession(harness)

  const before = captured
  const countBefore = renderCount
  act(() => {
    harness.emit('sess-1', 'tool-call', {
      toolCallId: 't1',
      title: 'X',
      status: 'pending',
      kind: 'other',
    })
  })

  expect(renderCount).toBeGreaterThan(countBefore)
  expect(captured).not.toBe(before)
  expect(captured?.t1.toolCallId).toBe('t1')
})

test('a derived selector with shallowEqual suppresses re-render when shallow-equal', async () => {
  const harness = await setup()
  let equalRenders = 0
  let defaultRenders = 0

  function EqualReader(): ReactElement {
    equalRenders += 1
    useSession(
      'sess-1',
      (s) => s.messages.map((m) => m.messageId ?? ''),
      shallowEqual,
    )
    return <div data-testid="equal" />
  }

  function DefaultReader(): ReactElement {
    defaultRenders += 1
    useSession('sess-1', (s) => s.messages.map((m) => m.messageId ?? ''))
    return <div data-testid="default" />
  }

  render(
    <AcpProvider client={harness.client}>
      <EqualReader />
      <DefaultReader />
    </AcpProvider>,
  )
  await spawnSession(harness)

  act(() => {
    harness.emit('sess-1', 'agent-message-chunk', {
      content: { type: 'text', text: 'hello' },
      messageId: 'm0',
    })
  })

  const equalBefore = equalRenders
  const defaultBefore = defaultRenders
  act(() => {
    harness.emit('sess-1', 'usage-update', { used: 1, size: 10 })
  })

  expect(equalRenders).toBe(equalBefore)
  expect(defaultRenders).toBeGreaterThan(defaultBefore)
})

test('a selected slice never tears under StrictMode and concurrent transitions', async () => {
  const harness = await setup()
  const torn: { a: string; b: string }[] = []

  function DoubleReader(): ReactElement {
    const a = useSession('sess-1', (s) => s.connection.status)
    const b = useSession('sess-1', (s) => s.connection.status)
    if (a?.state !== b?.state) {
      torn.push({ a: a?.state ?? '', b: b?.state ?? '' })
    }
    return <div data-testid="reader">{a?.state ?? ''}</div>
  }

  render(
    <StrictMode>
      <AcpProvider client={harness.client}>
        <DoubleReader />
      </AcpProvider>
    </StrictMode>,
  )
  await spawnSession(harness)

  const statuses = [
    'active',
    'prompting',
    'active',
    'prompting',
    'active',
  ] as const
  for (const status of statuses) {
    act(() => {
      harness.emit('sess-1', 'session-status-change', { status })
    })
  }

  expect(torn).toEqual([])
  expect(screen.getByTestId('reader').textContent).toBe('active')
})

test('list-hook selector reads stay value-identical across host emits', async () => {
  const harness = await setup()
  const torn: { a: number; b: number }[] = []

  function RegistryReader(): ReactElement {
    const a = useAgents((agents) => agents.length)
    const b = useAgents((agents) => agents.length)
    if (a !== b) torn.push({ a, b })
    return <div data-testid="registry">{a}</div>
  }

  render(
    <StrictMode>
      <AcpProvider client={harness.client}>
        <RegistryReader />
      </AcpProvider>
    </StrictMode>,
  )
  await spawnSession(harness)

  const statuses = ['exited', 'restarting', 'ready', 'exited', 'ready'] as const
  for (const status of statuses) {
    act(() => {
      harness.emitHost({
        agentId: 'agent-1',
        type: 'agent-updated',
        payload: { agentId: 'agent-1', status, restartCount: 0 },
      })
    })
  }

  expect(torn).toEqual([])
  expect(screen.getByTestId('registry').textContent).toBe('1')
})

test('a no-selector call returns the full snapshot (identity default preserved)', async () => {
  const harness = await setup()
  let connectionSnapshot: unknown
  let agentsSnapshot: unknown

  function Reader(): ReactElement {
    connectionSnapshot = useConnectionStatus()
    agentsSnapshot = useAgents()
    return <div data-testid="reader" />
  }

  render(
    <AcpProvider client={harness.client}>
      <Reader />
    </AcpProvider>,
  )
  await spawnSession(harness)

  expect(connectionSnapshot).toEqual(harness.client.status.getSnapshot())
  expect(agentsSnapshot).toBe(harness.client.agents.getSnapshot())
})
