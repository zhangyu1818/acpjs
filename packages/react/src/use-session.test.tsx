import type { ReactElement } from 'react'

import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { AcpProvider, useSession, type UseSessionResult } from './index.ts'
import {
  createTestHarness,
  sessionParams,
  type TestHarness,
} from './test-support.ts'

function messageText(result: UseSessionResult): string {
  return result.state.messages
    .map((message) =>
      message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(''),
    )
    .join('|')
}

function SessionView({ id }: { id: string }): ReactElement {
  const session = useSession(id)
  return <div data-testid="view">{session ? messageText(session) : 'none'}</div>
}

async function createSession(harness: TestHarness): Promise<void> {
  await act(async () => {
    const agent = await harness.client.agents.spawn({
      id: 'a',
      command: 'node',
    })
    await agent.sessions.create(sessionParams())
  })
}

test('useSession is undefined for an unknown sessionId and picks the session up once created', async () => {
  const harness = createTestHarness()
  render(
    <AcpProvider client={harness.client}>
      <SessionView id="sess-1" />
    </AcpProvider>,
  )

  expect(screen.getByTestId('view').textContent).toBe('none')

  await createSession(harness)

  expect(screen.getByTestId('view').textContent).toBe('')
})

test('an arriving event re-renders the hook with the reduced SessionState content', async () => {
  const harness = createTestHarness()
  render(
    <AcpProvider client={harness.client}>
      <SessionView id="sess-1" />
    </AcpProvider>,
  )
  await createSession(harness)

  act(() => {
    harness.emit('sess-1', 'agent-message-chunk', {
      content: { type: 'text', text: 'Hel' },
      messageId: 'm1',
    })
  })
  act(() => {
    harness.emit('sess-1', 'agent-message-chunk', {
      content: { type: 'text', text: 'lo' },
      messageId: 'm1',
    })
  })

  expect(screen.getByTestId('view').textContent).toBe('Hello')
})

test('re-rendering without new events keeps the exact same result reference', async () => {
  const harness = createTestHarness()
  const results: (UseSessionResult | undefined)[] = []
  function Probe(): null {
    results.push(useSession('sess-1'))
    return null
  }
  const { rerender } = render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  await createSession(harness)
  act(() => {
    harness.emit('sess-1', 'agent-message-chunk', {
      content: { type: 'text', text: 'hi' },
    })
  })
  const before = results.at(-1)
  expect(before).toBeDefined()

  rerender(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(results.at(-1)).toBe(before)
})

test('the returned methods call through to the session over the transport', async () => {
  const harness = createTestHarness()
  harness.handle('sessions/prompt', () => ({ stopReason: 'end_turn' }))
  let latest: UseSessionResult | undefined
  function Probe(): null {
    latest = useSession('sess-1')
    return null
  }
  render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  await createSession(harness)

  await act(async () => {
    await latest?.prompt([{ type: 'text', text: 'go' }])
  })

  expect(harness.requests.at(-1)).toMatchObject({
    method: 'sessions/prompt',
    params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'go' }] },
  })
})

test('changing the sessionId argument switches the hook to the other session state', async () => {
  const harness = createTestHarness()
  const sessionIds = ['sess-a', 'sess-b']
  harness.handle('sessions/create', () => ({
    status: 'active',
    sessionId: sessionIds.shift(),
  }))
  const { rerender } = render(
    <AcpProvider client={harness.client}>
      <SessionView id="sess-a" />
    </AcpProvider>,
  )
  await act(async () => {
    const agent = await harness.client.agents.spawn({
      id: 'a',
      command: 'node',
    })
    await agent.sessions.create(sessionParams())
    await agent.sessions.create(sessionParams())
  })
  act(() => {
    harness.emit('sess-a', 'agent-message-chunk', {
      content: { type: 'text', text: 'from-a' },
    })
    harness.emit('sess-b', 'agent-message-chunk', {
      content: { type: 'text', text: 'from-b' },
    })
  })

  expect(screen.getByTestId('view').textContent).toBe('from-a')

  rerender(
    <AcpProvider client={harness.client}>
      <SessionView id="sess-b" />
    </AcpProvider>,
  )

  expect(screen.getByTestId('view').textContent).toBe('from-b')
})

test('two hooks observing the same session render the identical state reference', async () => {
  const harness = createTestHarness()
  let first: UseSessionResult | undefined
  let second: UseSessionResult | undefined
  function First(): null {
    first = useSession('sess-1')
    return null
  }
  function Second(): null {
    second = useSession('sess-1')
    return null
  }
  render(
    <AcpProvider client={harness.client}>
      <First />
      <Second />
    </AcpProvider>,
  )
  await createSession(harness)

  act(() => {
    harness.emit('sess-1', 'agent-message-chunk', {
      content: { type: 'text', text: 'shared' },
    })
  })

  expect(first?.state).toBeDefined()
  expect(first?.state).toBe(second?.state)
  expect(messageText(first!)).toBe('shared')
})
