import { StrictMode, type ReactElement } from 'react'

import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { createCountingClient } from './counting-client.ts'
import {
  AcpProvider,
  useAgent,
  useAgents,
  useConnectionStatus,
  usePermissionRequests,
  useSession,
  useSessions,
} from './index.ts'

function AllHooks(): ReactElement {
  useAgent('agent-1')
  useAgents()
  useSessions()
  useConnectionStatus()
  const session = useSession('sess-1')
  usePermissionRequests()
  const text = session?.state.messages
    .map((message) =>
      message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(''),
    )
    .join('|')
  return <div data-testid="all">{text ?? 'none'}</div>
}

test('unmounting removes every store subscription the hooks created', () => {
  const harness = createCountingClient()
  const { unmount } = render(
    <AcpProvider client={harness.client}>
      <AllHooks />
    </AcpProvider>,
  )

  expect(harness.counts()).toEqual({
    agents: 2,
    agentState: 1,
    sessions: 2,
    sessionState: 1,
    permissions: 1,
    status: 1,
  })

  unmount()

  expect(harness.counts()).toEqual({
    agents: 0,
    agentState: 0,
    sessions: 0,
    sessionState: 0,
    permissions: 0,
    status: 0,
  })
})

test('StrictMode double-invocation leaves exactly one subscription per store and renders correct state', () => {
  const harness = createCountingClient()
  const { unmount } = render(
    <StrictMode>
      <AcpProvider client={harness.client}>
        <AllHooks />
      </AcpProvider>
    </StrictMode>,
  )

  expect(harness.counts()).toEqual({
    agents: 2,
    agentState: 1,
    sessions: 2,
    sessionState: 1,
    permissions: 1,
    status: 1,
  })

  act(() => harness.pushSessionEvent('strict'))

  expect(screen.getByTestId('all').textContent).toBe('strict')

  unmount()

  expect(harness.counts()).toEqual({
    agents: 0,
    agentState: 0,
    sessions: 0,
    sessionState: 0,
    permissions: 0,
    status: 0,
  })
})
