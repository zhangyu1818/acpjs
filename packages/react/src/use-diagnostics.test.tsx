import type { ReactElement } from 'react'

import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'

import { AcpProvider, useDiagnostics } from './index.ts'
import { createTestHarness } from './test-support.ts'

import type { DiagnosticEvent } from '@acpjs/client'

function DiagnosticsList(): ReactElement {
  const diagnostics = useDiagnostics()
  return (
    <ul data-testid="list">
      {diagnostics.map((event) => (
        <li key={event.seq}>{event.payload.code}</li>
      ))}
    </ul>
  )
}

test('useDiagnostics surfaces host diagnostic events as they arrive', async () => {
  const harness = createTestHarness()
  let latest: readonly DiagnosticEvent[] = []
  function Probe(): null {
    latest = useDiagnostics()
    return null
  }
  render(
    <AcpProvider client={harness.client}>
      <DiagnosticsList />
      <Probe />
    </AcpProvider>,
  )

  expect(screen.getByTestId('list').textContent).toBe('')
  await waitFor(() =>
    expect(harness.client.status.getSnapshot().status).toBe('connected'),
  )
  await act(async () => {
    await Promise.resolve()
  })

  act(() =>
    harness.emitHost({
      type: 'diagnostic',
      agentId: 'agent-1',
      payload: { level: 'error', code: 'spawn-failed', message: 'boom' },
    }),
  )

  await waitFor(() =>
    expect(screen.getByTestId('list').textContent).toBe('spawn-failed'),
  )
  expect(latest[0]).toMatchObject({
    type: 'diagnostic',
    agentId: 'agent-1',
    payload: { level: 'error', code: 'spawn-failed', message: 'boom' },
  })
})

test('a selector projects diagnostics without resubscribing', async () => {
  const harness = createTestHarness()
  let count = -1
  function Probe(): null {
    count = useDiagnostics((events) => events.length)
    return null
  }
  render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  await waitFor(() =>
    expect(harness.client.status.getSnapshot().status).toBe('connected'),
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(count).toBe(0)

  act(() =>
    harness.emitHost({
      type: 'diagnostic',
      payload: { level: 'warn', code: 'restart-scheduled', message: 'retry' },
    }),
  )

  await waitFor(() => expect(count).toBe(1))
})

test('the diagnostics list reference is stable across re-renders without changes', async () => {
  const harness = createTestHarness()
  const seen: (readonly DiagnosticEvent[])[] = []
  function Probe(): null {
    seen.push(useDiagnostics())
    return null
  }
  const { rerender } = render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  await waitFor(() =>
    expect(harness.client.status.getSnapshot().status).toBe('connected'),
  )
  await act(async () => {
    await Promise.resolve()
  })
  act(() =>
    harness.emitHost({
      type: 'diagnostic',
      payload: { level: 'info', code: 'stderr', message: 'log' },
    }),
  )
  await waitFor(() => expect(seen.at(-1)?.length).toBe(1))
  const before = seen.at(-1)

  rerender(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(seen.at(-1)).toBe(before)
})
