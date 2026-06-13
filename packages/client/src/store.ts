import {
  createInitialSessionState,
  reduce,
  type AcpEvent,
  type SessionState,
} from '@acpjs/protocol'

export type StateListener = (state: SessionState) => void

export interface SessionStore {
  readonly sessionId: string
  getSnapshot: () => SessionState
  subscribe: (listener: StateListener) => () => void
  apply: (event: AcpEvent) => void
  lastSeq: () => number
}

export function createSessionStore(sessionId: string): SessionStore {
  let state = createInitialSessionState(sessionId)
  let lastSeq = 0
  const listeners = new Set<StateListener>()
  return {
    sessionId,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    apply(event) {
      if (!('sessionId' in event) || event.sessionId !== sessionId) return
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
      const next = reduce(state, event)
      if (next === state) return
      state = next
      for (const listener of listeners) {
        try {
          listener(state)
        } catch {}
      }
    },
    lastSeq: () => lastSeq,
  }
}
