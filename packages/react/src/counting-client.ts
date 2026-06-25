import {
  createInitialSessionState,
  reduce,
  type AgentSnapshot,
  type SessionState,
} from '@acpjs/protocol'

import type {
  AcpAgent,
  AcpClient,
  AcpSession,
  ChangeListener,
  DiagnosticEvent,
  PermissionListener,
  PermissionRequest,
} from '@acpjs/client'

export interface SubscriptionCounts {
  agents: number
  agentState: number
  sessions: number
  sessionState: number
  permissions: number
  diagnostics: number
  status: number
}

export interface CountingClientHarness {
  client: AcpClient
  counts: () => SubscriptionCounts
  pushSessionEvent: (text: string) => void
}

export function createCountingClient(
  sessionId = 'sess-1',
): CountingClientHarness {
  const agentListeners = new Set<() => void>()
  const agentStateListeners = new Set<() => void>()
  const sessionListeners = new Set<() => void>()
  const stateListeners = new Set<(state: SessionState) => void>()
  const permissionListeners = new Set<PermissionListener>()
  const diagnosticListeners = new Set<ChangeListener>()
  let seq = 0
  let state = createInitialSessionState(sessionId)
  const emptyPermissions: readonly PermissionRequest[] = Object.freeze([])
  const emptyDiagnostics: readonly DiagnosticEvent[] = Object.freeze([])

  const session: AcpSession = {
    sessionId,
    getSnapshot: () => state,
    subscribe(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    onEvent() {
      return () => {}
    },
    async prompt() {
      return { stopReason: 'end_turn' }
    },
    async cancel() {},
    async close() {},
    async setMode() {},
    async setConfigOption() {
      return []
    },
  }

  const agentId = 'agent-1'
  const agentSnapshot: AgentSnapshot = Object.freeze({
    agentId,
    status: 'ready',
    restartCount: 0,
  })
  const agent: AcpAgent = {
    agentId,
    getSnapshot: () => agentSnapshot,
    subscribe(listener) {
      agentStateListeners.add(listener)
      return () => agentStateListeners.delete(listener)
    },
    async authenticate() {
      throw new Error('authenticate is not supported by the counting client')
    },
    async logout() {
      throw new Error('logout is not supported by the counting client')
    },
    sessions: {
      async create() {
        throw new Error('create is not supported by the counting client')
      },
      async load() {
        throw new Error('load is not supported by the counting client')
      },
      async list() {
        throw new Error('list is not supported by the counting client')
      },
      async resume() {
        throw new Error('resume is not supported by the counting client')
      },
      async delete() {
        throw new Error('delete is not supported by the counting client')
      },
    },
  }

  const agentsSnapshot = Object.freeze([agent])
  const sessionsSnapshot = Object.freeze([session])
  const statusSnapshot = Object.freeze({ status: 'connected' as const })
  const statusListeners = new Set<() => void>()

  const client: AcpClient = {
    agents: {
      async spawn() {
        throw new Error('spawn is not supported by the counting client')
      },
      get: (id) => (id === agentId ? agent : undefined),
      getSnapshot: () => agentsSnapshot,
      subscribe(listener) {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      },
      async list() {
        return []
      },
      async attach() {
        throw new Error('attach is not supported by the counting client')
      },
      async dispose() {},
    },
    sessions: {
      get: (id) => (id === sessionId ? session : undefined),
      getSnapshot: () => sessionsSnapshot,
      subscribe(listener) {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
      async list() {
        return []
      },
      async attach(id) {
        if (id === sessionId) return session
        throw new Error('attach is not supported by the counting client')
      },
      async restore() {
        return []
      },
    },
    permissions: {
      getSnapshot: () => emptyPermissions,
      subscribe(listener) {
        permissionListeners.add(listener)
        return () => permissionListeners.delete(listener)
      },
    },
    diagnostics: {
      getSnapshot: () => emptyDiagnostics,
      subscribe(listener) {
        diagnosticListeners.add(listener)
        return () => diagnosticListeners.delete(listener)
      },
    },
    status: {
      getSnapshot: () => statusSnapshot,
      subscribe(listener) {
        statusListeners.add(listener)
        return () => statusListeners.delete(listener)
      },
    },
    async dispose() {},
  }

  return {
    client,
    counts: () => ({
      agents: agentListeners.size,
      agentState: agentStateListeners.size,
      sessions: sessionListeners.size,
      sessionState: stateListeners.size,
      permissions: permissionListeners.size,
      diagnostics: diagnosticListeners.size,
      status: statusListeners.size,
    }),
    pushSessionEvent(text) {
      seq += 1
      state = reduce(state, {
        sessionId,
        seq,
        ts: 0,
        type: 'agent-message-chunk',
        payload: { content: { type: 'text', text } },
      })
      for (const listener of stateListeners) listener(state)
    },
  }
}
