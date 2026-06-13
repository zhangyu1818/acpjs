import { act, render } from '@testing-library/react'
import { expect, test } from 'vitest'

import { AcpProvider, useConnectionStatus } from './index.ts'
import { createTestHarness } from './test-support.ts'

import type { ConnectionStatusSnapshot } from '@acpjs/client'

test('useConnectionStatus follows the transport lifecycle from connecting to connected to closed', async () => {
  const harness = createTestHarness()
  const seen: ConnectionStatusSnapshot[] = []
  function Probe(): null {
    seen.push(useConnectionStatus())
    return null
  }
  render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(seen.at(-1)).toEqual({ status: 'connecting' })

  await act(async () => {})

  expect(seen.at(-1)).toEqual({ status: 'connected' })

  act(() => harness.close())

  expect(seen.at(-1)).toEqual({ status: 'closed' })
})

test('useConnectionStatus returns the same snapshot reference across re-renders without changes', async () => {
  const harness = createTestHarness()
  const seen: ConnectionStatusSnapshot[] = []
  function Probe(): null {
    seen.push(useConnectionStatus())
    return null
  }
  const { rerender } = render(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )
  await act(async () => {})
  const before = seen.at(-1)

  rerender(
    <AcpProvider client={harness.client}>
      <Probe />
    </AcpProvider>,
  )

  expect(seen.at(-1)).toBe(before)
})
