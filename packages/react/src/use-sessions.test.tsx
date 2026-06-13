import type { ReactElement } from 'react'

import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { AcpProvider, useSessions } from './index.ts'
import { createTestHarness } from './test-support.ts'

function SessionList(): ReactElement {
  const sessions = useSessions()
  return (
    <div data-testid="sessions">
      {sessions.map((session) => session.sessionId).join(',')}
    </div>
  )
}

test('useSessions starts empty and reactively lists created and attached sessions', async () => {
  const harness = createTestHarness()
  harness.handle('sessions/getAll', () => [
    { sessionId: 'sess-1', status: 'active' },
    { sessionId: 'sess-2', status: 'disconnected' },
  ])
  render(
    <AcpProvider client={harness.client}>
      <SessionList />
    </AcpProvider>,
  )

  expect(screen.getByTestId('sessions').textContent).toBe('')

  await act(async () => {
    const agent = await harness.client.agents.spawn({
      id: 'a',
      command: 'node',
    })
    await agent.sessions.create({ cwd: '/tmp' })
  })

  expect(screen.getByTestId('sessions').textContent).toBe('sess-1')

  await act(async () => {
    await harness.client.sessions.attach('sess-2')
  })

  expect(screen.getByTestId('sessions').textContent).toBe('sess-1,sess-2')
})

test('useSessions returns the same array reference across re-renders without changes', async () => {
  const harness = createTestHarness()
  const seen: (readonly unknown[])[] = []
  function Probe(): null {
    seen.push(useSessions())
    return null
  }
  const { rerender } = render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  await act(async () => {
    const agent = await harness.client.agents.spawn({
      id: 'a',
      command: 'node',
    })
    await agent.sessions.create({ cwd: '/tmp' })
  })
  const before = seen.at(-1)

  rerender(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(seen.at(-1)).toBe(before)
})
