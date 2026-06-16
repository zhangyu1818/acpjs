import { useCallback } from 'react'

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'

import { useAcpClient } from './context.ts'

import type { DiagnosticEvent } from '@acpjs/client'

const identity = <S>(s: S): S => s

export function useDiagnostics(): readonly DiagnosticEvent[]
export function useDiagnostics<T>(
  selector: (diagnostics: readonly DiagnosticEvent[]) => T,
  isEqual?: (a: T, b: T) => boolean,
): T
export function useDiagnostics<T = readonly DiagnosticEvent[]>(
  selector:
    | ((diagnostics: readonly DiagnosticEvent[]) => T)
    | undefined = undefined,
  isEqual: ((a: T, b: T) => boolean) | undefined = undefined,
): T | readonly DiagnosticEvent[] {
  const client = useAcpClient()
  return useSyncExternalStoreWithSelector<readonly DiagnosticEvent[], T>(
    useCallback(
      (onStoreChange: () => void) =>
        client.diagnostics.subscribe(onStoreChange),
      [client],
    ),
    client.diagnostics.getSnapshot,
    null,
    (selector ?? identity) as (diagnostics: readonly DiagnosticEvent[]) => T,
    isEqual,
  )
}
