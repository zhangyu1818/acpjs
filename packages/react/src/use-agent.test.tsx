import type { ReactElement } from 'react'

import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { createCountingClient } from './counting-client.ts'
import { AcpProvider, useAgent } from './index.ts'
import { createTestHarness } from './test-support.ts'

import type { AcpAgent } from '@acpjs/client'

test('useAgent is undefined until the agent is spawned, then returns the stable handle', async () => {
  const harness = createTestHarness()
  harness.handle('agents/spawn', () => ({
    agentId: 'agent-1',
    capabilities: { loadSession: true },
  }))
  const seen: (AcpAgent | undefined)[] = []
  function Probe(): null {
    seen.push(useAgent('agent-1'))
    return null
  }
  render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(seen.at(-1)).toBeUndefined()

  let spawned: AcpAgent | undefined
  await act(async () => {
    spawned = await harness.client.agents.spawn({ id: 'a', command: 'node' })
  })

  expect(seen.at(-1)).toBe(spawned)
  expect(seen.at(-1)?.getSnapshot().capabilities).toEqual({
    loadSession: true,
  })
})

test('swapping the provider client re-subscribes to the new client and unsubscribes the old one', async () => {
  const counting = createCountingClient()
  const harness = createTestHarness()
  const seen: (AcpAgent | undefined)[] = []
  function Probe(): null {
    seen.push(useAgent('agent-1'))
    return null
  }
  const { rerender } = render(
    <AcpProvider client={counting.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(counting.counts().agents).toBe(1)

  rerender(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(counting.counts().agents).toBe(0)

  let spawned: AcpAgent | undefined
  await act(async () => {
    spawned = await harness.client.agents.spawn({ id: 'a', command: 'node' })
  })

  expect(spawned).toBeDefined()
  expect(seen.at(-1)).toBe(spawned)
})

function StatusProbe(): ReactElement {
  const agent = useAgent('agent-1')
  return (
    <div data-testid="status">
      {agent ? agent.getSnapshot().status : 'none'}
    </div>
  )
}

test('a host agent-updated projection re-renders useAgent with the updated snapshot', async () => {
  const harness = createTestHarness()
  render(
    <AcpProvider client={harness.client}>
      <StatusProbe />
    </AcpProvider>,
  )

  let spawned: AcpAgent | undefined
  await act(async () => {
    spawned = await harness.client.agents.spawn({ id: 'a', command: 'node' })
  })
  expect(screen.getByTestId('status').textContent).toBe('ready')
  const before = spawned!.getSnapshot()

  act(() => {
    harness.emitHost({
      agentId: 'agent-1',
      type: 'agent-updated',
      payload: {
        agentId: 'agent-1',
        status: 'exited',
        restartCount: 0,
        reason: 'crashed',
        exit: { code: 1 },
      },
    })
  })

  expect(screen.getByTestId('status').textContent).toBe('exited')
  expect(spawned!.getSnapshot()).not.toBe(before)
  expect(spawned!.getSnapshot()).toMatchObject({
    status: 'exited',
    reason: 'crashed',
    exit: { code: 1 },
  })
})

test('an agent-updated projection without a state change neither re-renders nor swaps the snapshot reference', async () => {
  const harness = createTestHarness()
  let renders = 0
  function Probe(): null {
    renders += 1
    useAgent('agent-1')
    return null
  }
  render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  let spawned: AcpAgent | undefined
  await act(async () => {
    spawned = await harness.client.agents.spawn({ id: 'a', command: 'node' })
  })
  const stable = spawned!.getSnapshot()
  const rendersBefore = renders

  act(() => {
    harness.emitHost({
      agentId: 'agent-1',
      type: 'agent-updated',
      payload: { agentId: 'agent-1', status: 'ready', restartCount: 0 },
    })
  })

  expect(renders).toBe(rendersBefore)
  expect(spawned!.getSnapshot()).toBe(stable)
})
