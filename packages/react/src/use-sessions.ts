import { useCallback } from 'react'

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'

import { useAcpClient } from './context.ts'

import type { AcpSession } from '@acpjs/client'

const identity = <S>(s: S): S => s

export function useSessions(): readonly AcpSession[]
export function useSessions<T>(
  selector: (sessions: readonly AcpSession[]) => T,
  isEqual?: (a: T, b: T) => boolean,
): T
export function useSessions<T = readonly AcpSession[]>(
  selector: ((sessions: readonly AcpSession[]) => T) | undefined = undefined,
  isEqual: ((a: T, b: T) => boolean) | undefined = undefined,
): T | readonly AcpSession[] {
  const client = useAcpClient()
  return useSyncExternalStoreWithSelector<readonly AcpSession[], T>(
    useCallback(
      (onStoreChange: () => void) => client.sessions.subscribe(onStoreChange),
      [client],
    ),
    client.sessions.getSnapshot,
    null,
    (selector ?? identity) as (sessions: readonly AcpSession[]) => T,
    isEqual,
  )
}
