import { useCallback } from 'react'

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'

import { useAcpClient } from './context.ts'

import type { PermissionRequest } from '@acpjs/client'

const identity = <S>(s: S): S => s

export function usePermissionRequests(): readonly PermissionRequest[]
export function usePermissionRequests<T>(
  selector: (requests: readonly PermissionRequest[]) => T,
  isEqual?: (a: T, b: T) => boolean,
): T
export function usePermissionRequests<T = readonly PermissionRequest[]>(
  selector:
    | ((requests: readonly PermissionRequest[]) => T)
    | undefined = undefined,
  isEqual: ((a: T, b: T) => boolean) | undefined = undefined,
): T | readonly PermissionRequest[] {
  const client = useAcpClient()
  return useSyncExternalStoreWithSelector<readonly PermissionRequest[], T>(
    useCallback(
      (onStoreChange: () => void) =>
        client.permissions.subscribe(onStoreChange),
      [client],
    ),
    client.permissions.getSnapshot,
    null,
    (selector ?? identity) as (requests: readonly PermissionRequest[]) => T,
    isEqual,
  )
}
