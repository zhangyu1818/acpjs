import type { ReactElement } from 'react'

import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { AcpProvider, usePermissionRequests } from './index.ts'
import { createTestHarness } from './test-support.ts'

import type { PermissionRequest } from '@acpjs/client'

const PERMISSION = {
  requestId: 'perm-1',
  sessionId: 'sess-1',
  toolCall: { toolCallId: 'call_1', kind: 'execute' },
  options: [{ kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' }],
}

function PermissionList(): ReactElement {
  const requests = usePermissionRequests()
  return (
    <ul data-testid="list">
      {requests.map((request) => (
        <li key={request.requestId}>{request.requestId}</li>
      ))}
    </ul>
  )
}

test('usePermissionRequests surfaces pending requests and converges after respond', async () => {
  const harness = createTestHarness()
  let latest: readonly PermissionRequest[] = []
  function Probe(): null {
    latest = usePermissionRequests()
    return null
  }
  render(
    <AcpProvider client={harness.client}>
      <PermissionList />
      <Probe />
    </AcpProvider>,
  )

  expect(screen.getByTestId('list').textContent).toBe('')

  act(() => harness.pushPermission(PERMISSION))

  expect(screen.getByTestId('list').textContent).toBe('perm-1')
  expect(latest[0]).toMatchObject({
    requestId: 'perm-1',
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'call_1', kind: 'execute' },
  })

  await act(async () => {
    await latest[0]?.respond({ outcome: 'selected', optionId: 'opt-allow' })
  })

  expect(harness.inboundResponses).toEqual([
    { id: 'perm-1', result: { outcome: 'selected', optionId: 'opt-allow' } },
  ])
  expect(screen.getByTestId('list').textContent).toBe('')
  expect(latest).toEqual([])
})

test('the request list reference is stable across re-renders without changes', () => {
  const harness = createTestHarness()
  const seen: (readonly PermissionRequest[])[] = []
  function Probe(): null {
    seen.push(usePermissionRequests())
    return null
  }
  const { rerender } = render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  act(() => harness.pushPermission(PERMISSION))
  const before = seen.at(-1)

  rerender(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(seen.at(-1)).toBe(before)
})
