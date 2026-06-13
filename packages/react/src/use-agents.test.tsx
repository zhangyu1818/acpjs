import type { ReactElement } from 'react'

import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { AcpProvider, useAgents } from './index.ts'
import { createTestHarness } from './test-support.ts'

function AgentList(): ReactElement {
  const agents = useAgents()
  return (
    <div data-testid="agents">
      {agents.map((agent) => agent.agentId).join(',')}
    </div>
  )
}

test('useAgents starts empty and reactively lists spawned and attached agents', async () => {
  const harness = createTestHarness()
  harness.handle('agents/list', () => [
    { agentId: 'agent-1', status: 'ready', restartCount: 0 },
    { agentId: 'agent-2', status: 'ready', restartCount: 0 },
  ])
  render(
    <AcpProvider client={harness.client}>
      <AgentList />
    </AcpProvider>,
  )

  expect(screen.getByTestId('agents').textContent).toBe('')

  await act(async () => {
    await harness.client.agents.spawn({ id: 'a', command: 'node' })
  })

  expect(screen.getByTestId('agents').textContent).toBe('agent-1')

  await act(async () => {
    await harness.client.agents.attach('agent-2')
  })

  expect(screen.getByTestId('agents').textContent).toBe('agent-1,agent-2')
})

test('useAgents returns the same array reference across re-renders without changes', async () => {
  const harness = createTestHarness()
  const seen: (readonly unknown[])[] = []
  function Probe(): null {
    seen.push(useAgents())
    return null
  }
  const { rerender } = render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  await act(async () => {
    await harness.client.agents.spawn({ id: 'a', command: 'node' })
  })
  const before = seen.at(-1)

  rerender(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(seen.at(-1)).toBe(before)
})
