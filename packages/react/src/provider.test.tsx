import { Component, type ReactNode } from 'react'

import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { AcpProvider, useAcpClient } from './index.ts'
import { createTestHarness } from './test-support.ts'

import type { AcpClient } from '@acpjs/client'

class Catcher extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  override state: { message: string | null } = { message: null }

  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: error.message }
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return <div data-testid="caught">{this.state.message}</div>
    }
    return this.props.children
  }
}

test('useAcpClient returns the client passed to AcpProvider', () => {
  const { client } = createTestHarness()
  let observed: AcpClient | undefined
  function Probe(): null {
    observed = useAcpClient()
    return null
  }

  render(
    <AcpProvider client={client}>
      <Probe />
    </AcpProvider>,
  )

  expect(observed).toBe(client)
})

function BareProbe(): null {
  useAcpClient()
  return null
}

test('useAcpClient outside of AcpProvider throws a clear error', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})

  render(
    <Catcher>
      <BareProbe />
    </Catcher>,
  )

  expect(screen.getByTestId('caught').textContent).toContain('AcpProvider')
})
