import {
  createInitialSessionState,
  reduce,
  type AcpjsEvent,
  type SessionState,
  type SessionSnapshot,
} from '@acpjs/protocol'

export type StateListener = (state: SessionState) => void

export interface SessionStore {
  readonly sessionId: string
  getSnapshot: () => SessionState
  subscribe: (listener: StateListener) => () => void
  apply: (event: AcpjsEvent) => void
  applyProjection: (snapshot: SessionSnapshot) => boolean
  lastSeq: () => number
}

export function createSessionStore(sessionId: string): SessionStore {
  let state = createInitialSessionState(sessionId)
  let lastSeq = 0
  const listeners = new Set<StateListener>()
  function publish(next: SessionState): void {
    if (next === state) return
    state = next
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {}
    }
  }
  return {
    sessionId,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    apply(event) {
      if (!('sessionId' in event) || event.sessionId !== sessionId) return
      if (event.type === 'session-reset') {
        lastSeq = event.seq
        publish(reduce(state, event))
        return
      }
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
      const next = reduce(state, event)
      publish(next)
    },
    applyProjection(snapshot) {
      if (snapshot.sessionId !== sessionId) return false
      const title =
        snapshot.title === undefined ? state.info.title : snapshot.title
      const updatedAt =
        snapshot.updatedAt === undefined
          ? state.info.updatedAt
          : snapshot.updatedAt
      if (
        state.connection.status === snapshot.status &&
        state.info.title === title &&
        state.info.updatedAt === updatedAt
      ) {
        return false
      }
      const next = {
        ...state,
        connection: {
          ...state.connection,
          status: snapshot.status,
        },
        info: {
          title,
          updatedAt,
        },
      }
      publish(next)
      return true
    },
    lastSeq: () => lastSeq,
  }
}
