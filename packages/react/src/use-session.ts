import { useCallback, useMemo, useSyncExternalStore } from 'react'

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'

import { useAcpClient } from './context.ts'

import type { AcpSession } from '@acpjs/client'
import type { SessionState } from '@acpjs/protocol'

export interface UseSessionResult<TState = SessionState> {
  sessionId: string
  state: TState
  prompt: AcpSession['prompt']
  cancel: AcpSession['cancel']
  close: AcpSession['close']
  setMode: AcpSession['setMode']
  setConfigOption: AcpSession['setConfigOption']
}

function noopUnsubscribe(): void {}

const identity = <S>(s: S): S => s

export function useSession(sessionId: string): UseSessionResult | undefined
export function useSession<T>(
  sessionId: string,
  selector: (state: SessionState) => T,
  isEqual?: (a: T, b: T) => boolean,
): UseSessionResult<T> | undefined
export function useSession<T = SessionState>(
  sessionId: string,
  selector: ((state: SessionState) => T) | undefined = undefined,
  isEqual: ((a: T, b: T) => boolean) | undefined = undefined,
): UseSessionResult<T> | UseSessionResult | undefined {
  const client = useAcpClient()
  const session = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => client.sessions.subscribe(onStoreChange),
      [client],
    ),
    useCallback(() => client.sessions.get(sessionId), [client, sessionId]),
  )
  const project = selector ?? (identity as (state: SessionState) => T)
  const state = useSyncExternalStoreWithSelector<
    SessionState | undefined,
    T | undefined
  >(
    useCallback(
      (onStoreChange: () => void) =>
        session ? session.subscribe(onStoreChange) : noopUnsubscribe,
      [session],
    ),
    useCallback(() => session?.getSnapshot(), [session]),
    null,
    useCallback(
      (snapshot: SessionState | undefined) =>
        snapshot === undefined ? undefined : project(snapshot),
      [project],
    ),
    isEqual as ((a: T | undefined, b: T | undefined) => boolean) | undefined,
  )
  return useMemo(() => {
    if (session === undefined || state === undefined) return undefined
    return {
      sessionId: session.sessionId,
      state,
      prompt: session.prompt,
      cancel: session.cancel,
      close: session.close,
      setMode: session.setMode,
      setConfigOption: session.setConfigOption,
    }
  }, [session, state])
}
