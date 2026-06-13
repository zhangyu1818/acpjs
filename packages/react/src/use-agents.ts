import { useCallback } from 'react'

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'

import { useAcpClient } from './context.ts'

import type { AcpAgent } from '@acpjs/client'

const identity = <S>(s: S): S => s

export function useAgents(): readonly AcpAgent[]
export function useAgents<T>(
  selector: (agents: readonly AcpAgent[]) => T,
  isEqual?: (a: T, b: T) => boolean,
): T
export function useAgents<T = readonly AcpAgent[]>(
  selector: ((agents: readonly AcpAgent[]) => T) | undefined = undefined,
  isEqual: ((a: T, b: T) => boolean) | undefined = undefined,
): T | readonly AcpAgent[] {
  const client = useAcpClient()
  return useSyncExternalStoreWithSelector<readonly AcpAgent[], T>(
    useCallback(
      (onStoreChange: () => void) => client.agents.subscribe(onStoreChange),
      [client],
    ),
    client.agents.getSnapshot,
    null,
    (selector ?? identity) as (agents: readonly AcpAgent[]) => T,
    isEqual,
  )
}
