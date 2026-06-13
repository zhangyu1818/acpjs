import { useCallback } from 'react'

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'

import { useAcpClient } from './context.ts'

import type { ConnectionStatusSnapshot } from '@acpjs/client'

const identity = <S>(s: S): S => s

export function useConnectionStatus(): ConnectionStatusSnapshot
export function useConnectionStatus<T>(
  selector: (status: ConnectionStatusSnapshot) => T,
  isEqual?: (a: T, b: T) => boolean,
): T
export function useConnectionStatus<T = ConnectionStatusSnapshot>(
  selector: ((status: ConnectionStatusSnapshot) => T) | undefined = undefined,
  isEqual: ((a: T, b: T) => boolean) | undefined = undefined,
): T | ConnectionStatusSnapshot {
  const client = useAcpClient()
  return useSyncExternalStoreWithSelector<ConnectionStatusSnapshot, T>(
    useCallback(
      (onStoreChange: () => void) => client.status.subscribe(onStoreChange),
      [client],
    ),
    client.status.getSnapshot,
    null,
    (selector ?? identity) as (status: ConnectionStatusSnapshot) => T,
    isEqual,
  )
}
