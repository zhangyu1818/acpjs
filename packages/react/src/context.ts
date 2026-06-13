import {
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from 'react'

import type { AcpClient } from '@acpjs/client'

const AcpClientContext = createContext<AcpClient | null>(null)

export interface AcpProviderProps {
  client: AcpClient
  children?: ReactNode
}

export function AcpProvider(props: AcpProviderProps): ReactElement {
  return createElement(
    AcpClientContext.Provider,
    { value: props.client },
    props.children,
  )
}

export function useAcpClient(): AcpClient {
  const client = useContext(AcpClientContext)
  if (client === null) {
    throw new Error(
      '@acpjs/react hooks must be used within an <AcpProvider client={...}>',
    )
  }
  return client
}
