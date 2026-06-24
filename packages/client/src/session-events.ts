import { createSessionStore, type SessionStore } from './store.ts'

import type { HostClientTransport } from '@acpjs/protocol'

import type { AcpSession } from './types.ts'

export interface SessionEvents {
  attachStore: (sessionId: string) => SessionStore
  onEventFor: (store: SessionStore) => AcpSession['onEvent']
  closeSession: (sessionId: string) => void
  closeAll: () => void
}

export interface SessionEventsOptions {
  subscribe: HostClientTransport['subscribe']
  storeUnsubscribers: Set<() => void>
  prune: (requestId: string) => void
}

export function createSessionEvents(
  options: SessionEventsOptions,
): SessionEvents {
  const { subscribe, storeUnsubscribers, prune } = options
  const stores = new Map<string, SessionStore>()
  const sessionUnsubscribers = new Map<string, () => void>()
  const eventUnsubscribers = new Map<string, Set<() => void>>()

  function attachStore(sessionId: string): SessionStore {
    const existing = stores.get(sessionId)
    if (existing) return existing
    const store = createSessionStore(sessionId)
    stores.set(sessionId, store)
    const unsubscribe = subscribe(
      { sessionId, fromSeq: store.lastSeq() },
      (event) => {
        if (event.type === 'permission-request-resolved') {
          prune(event.payload.requestId)
        }
        store.apply(event)
      },
    )
    storeUnsubscribers.add(unsubscribe)
    sessionUnsubscribers.set(sessionId, unsubscribe)
    return store
  }

  function onEventFor(store: SessionStore): AcpSession['onEvent'] {
    const sessionId = store.sessionId
    return (listener, opts) => {
      const open = eventUnsubscribers.get(sessionId) ?? new Set<() => void>()
      eventUnsubscribers.set(sessionId, open)
      const unsubscribeEvent = subscribe(
        { sessionId, fromSeq: opts?.fromSeq ?? store.lastSeq() },
        (event) => {
          if ('sessionId' in event && event.sessionId === sessionId) {
            listener(event)
          }
        },
      )
      const dispose = (): void => {
        if (!open.delete(dispose)) return
        unsubscribeEvent()
      }
      open.add(dispose)
      return dispose
    }
  }

  function closeSession(sessionId: string): void {
    const unsubscribe = sessionUnsubscribers.get(sessionId)
    unsubscribe?.()
    if (unsubscribe) storeUnsubscribers.delete(unsubscribe)
    sessionUnsubscribers.delete(sessionId)
    const open = eventUnsubscribers.get(sessionId)
    if (open) {
      for (const dispose of Array.from(open)) dispose()
      eventUnsubscribers.delete(sessionId)
    }
    stores.delete(sessionId)
  }

  function closeAll(): void {
    for (const open of eventUnsubscribers.values()) {
      for (const dispose of Array.from(open)) dispose()
    }
    eventUnsubscribers.clear()
  }

  return { attachStore, onEventFor, closeSession, closeAll }
}
