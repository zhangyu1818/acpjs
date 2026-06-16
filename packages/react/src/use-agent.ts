import { useCallback, useSyncExternalStore } from 'react'

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'

import { useAcpClient } from './context.ts'

import type { AcpAgent } from '@acpjs/client'
import type { AgentSnapshotWire } from '@acpjs/protocol'

function noopUnsubscribe(): void {}

const identity = <S>(s: S): S => s

export function useAgent(agentId: string): AcpAgent | undefined
export function useAgent<T>(
  agentId: string,
  selector: (snapshot: AgentSnapshotWire | undefined) => T,
  isEqual?: (a: T, b: T) => boolean,
): T
export function useAgent<T = AcpAgent | undefined>(
  agentId: string,
  selector:
    | ((snapshot: AgentSnapshotWire | undefined) => T)
    | undefined = undefined,
  isEqual: ((a: T, b: T) => boolean) | undefined = undefined,
): T | AcpAgent | undefined {
  const client = useAcpClient()
  const agent = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => client.agents.subscribe(onStoreChange),
      [client],
    ),
    useCallback(() => client.agents.get(agentId), [client, agentId]),
  )
  const selected = useSyncExternalStoreWithSelector<
    AgentSnapshotWire | undefined,
    T
  >(
    useCallback(
      (onStoreChange: () => void) =>
        agent ? agent.subscribe(onStoreChange) : noopUnsubscribe,
      [agent],
    ),
    useCallback(() => agent?.getSnapshot(), [agent]),
    null,
    (selector ?? identity) as (snapshot: AgentSnapshotWire | undefined) => T,
    isEqual,
  )
  return selector ? selected : agent
}
