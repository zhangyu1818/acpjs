import {
  ACP_ERROR_CODES,
  ACPJS_HOST_RPC_METHODS,
  type AcpEvent,
  type AgentSnapshotWire,
  type ErrorObject,
  type SessionSnapshotWire,
  type TransportHandlers,
} from '@acpjs/protocol'

import { createAgentHandle } from './agent-handle.ts'
import { createDiagnosticsLog } from './client-diagnostics.ts'
import { createClientPermissionController } from './client-permissions.ts'
import { createRpcCaller } from './client-rpc.ts'
import { AcpClientError, transportClosedError } from './errors.ts'
import { notifyChange } from './internal.ts'
import { createPermissionRegistry } from './permission-registry.ts'
import { createSessionHandle } from './session-handle.ts'
import { createSessionStore, type SessionStore } from './store.ts'

import type {
  AcpAgent,
  AcpClient,
  AcpSession,
  AgentDefinition,
  ChangeListener,
  ConnectionStatusSnapshot,
  CreateAcpClientOptions,
} from './types.ts'

export function createAcpClient(options: CreateAcpClientOptions): AcpClient {
  const transport = options.transport
  let closedError: ErrorObject | undefined
  const stores = new Map<string, SessionStore>()
  const storeUnsubscribers = new Set<() => void>()
  const agents = new Map<string, AcpAgent>()
  const agentListeners = new Set<ChangeListener>()
  const agentUpdaters = new Map<
    string,
    {
      applySnapshot: (snapshot: AgentSnapshotWire) => void
    }
  >()
  let agentsSnapshot: readonly AcpAgent[] = Object.freeze([])

  function publishAgents(): void {
    agentsSnapshot = Object.freeze([...agents.values()])
    notifyChange(agentListeners)
  }

  const sessions = new Map<string, AcpSession>()
  const sessionUnsubscribers = new Map<string, () => void>()
  const sessionListeners = new Set<ChangeListener>()
  let sessionsSnapshot: readonly AcpSession[] = Object.freeze([])

  function publishSessions(): void {
    sessionsSnapshot = Object.freeze([...sessions.values()])
    notifyChange(sessionListeners)
  }

  let statusSnapshot: ConnectionStatusSnapshot = Object.freeze({
    status: 'connecting' as const,
  })
  const statusListeners = new Set<ChangeListener>()
  const permissions = createPermissionRegistry()
  const diagnostics = createDiagnosticsLog()

  function ensureOpen(): void {
    if (closedError) throw new AcpClientError(closedError)
  }

  const handlers: TransportHandlers = {
    onInboundRequest() {},
    onLifecycle(event) {
      if (event.status === 'closed') {
        closedError = event.error ?? transportClosedError()
        permissions.reset()
      }
      if (
        statusSnapshot.status === event.status &&
        statusSnapshot.error === event.error
      ) {
        return
      }
      statusSnapshot = Object.freeze({
        status: event.status,
        ...(event.error === undefined ? {} : { error: event.error }),
      })
      notifyChange(statusListeners)
    },
    onSubscriptionError(params) {
      if (params.sessionId !== undefined) closeSessionHandle(params.sessionId)
    },
  }

  const connected = transport.connect(handlers)
  const permissionController = createClientPermissionController({
    ensureOpen,
    connected,
    respondInbound: (response) => transport.respondInbound(response),
    registry: permissions,
  })

  function onHostEvent(event: AcpEvent): void {
    if (event.type === 'agent-updated') {
      registerAgent(event.payload)
    } else if (event.type === 'session-updated') {
      applySessionProjection(event.payload)
    } else if (event.type === 'permission-updated') {
      permissionController.applyProjection(event.payload)
    } else if (event.type === 'diagnostic') {
      diagnostics.push(event)
    }
  }

  connected
    .then(() => {
      if (closedError) return
      storeUnsubscribers.add(transport.subscribe({ fromSeq: 0 }, onHostEvent))
    })
    .catch(() => {})

  const call = createRpcCaller({
    ensureOpen,
    connected: () => connected,
    request: (request) => transport.request(request),
  })

  function attachStore(sessionId: string): SessionStore {
    const existing = stores.get(sessionId)
    if (existing) return existing
    const store = createSessionStore(sessionId)
    stores.set(sessionId, store)
    const unsubscribe = transport.subscribe(
      { sessionId, fromSeq: store.lastSeq() },
      (event) => {
        if (event.type === 'permission-request-resolved') {
          permissions.prune(event.payload.requestId)
        }
        store.apply(event)
      },
    )
    storeUnsubscribers.add(unsubscribe)
    sessionUnsubscribers.set(sessionId, unsubscribe)
    return store
  }

  function openSession(sessionId: string): AcpSession {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const session = createSessionHandle(call, attachStore(sessionId))
    sessions.set(sessionId, session)
    publishSessions()
    return session
  }

  function closeSessionHandle(sessionId: string): void {
    if (!sessions.delete(sessionId)) return
    const unsubscribe = sessionUnsubscribers.get(sessionId)
    unsubscribe?.()
    if (unsubscribe) storeUnsubscribers.delete(unsubscribe)
    sessionUnsubscribers.delete(sessionId)
    stores.delete(sessionId)
    publishSessions()
  }

  function applySessionProjection(
    snapshot: SessionSnapshotWire,
  ): AcpSession | undefined {
    if (snapshot.status === 'deleted') {
      closeSessionHandle(snapshot.sessionId)
      return undefined
    }
    const existing = sessions.has(snapshot.sessionId)
    const store = attachStore(snapshot.sessionId)
    const changed = store.applyProjection(snapshot)
    const session = openSession(snapshot.sessionId)
    if (existing && changed) publishSessions()
    return session
  }

  async function listAgents(): Promise<readonly AgentSnapshotWire[]> {
    return (await call(
      ACPJS_HOST_RPC_METHODS.listAgents,
      {},
    )) as AgentSnapshotWire[]
  }

  async function listAllSessions(): Promise<readonly SessionSnapshotWire[]> {
    return (await call(
      ACPJS_HOST_RPC_METHODS.getAllSessions,
      {},
    )) as SessionSnapshotWire[]
  }

  function registerAgent(snapshot: AgentSnapshotWire): AcpAgent {
    const existing = agents.get(snapshot.agentId)
    if (existing) {
      agentUpdaters.get(snapshot.agentId)?.applySnapshot(snapshot)
      return existing
    }
    const { agent, applySnapshot } = createAgentHandle(
      call,
      openSession,
      (snapshot) => {
        const session = applySessionProjection(snapshot)
        if (session === undefined) {
          throw new AcpClientError({
            code: ACP_ERROR_CODES.sessionClosed,
            message: `session ${snapshot.sessionId} is deleted`,
            retryable: false,
          })
        }
        return session
      },
      publishAgents,
      snapshot,
    )
    agentUpdaters.set(agent.agentId, { applySnapshot })
    agents.set(agent.agentId, agent)
    publishAgents()
    return agent
  }

  return Object.freeze({
    agents: Object.freeze({
      async spawn(definition: AgentDefinition): Promise<AcpAgent> {
        const snapshot = (await call(ACPJS_HOST_RPC_METHODS.spawnAgent, {
          definition,
        })) as AgentSnapshotWire
        return registerAgent(snapshot)
      },
      get: (agentId: string) => agents.get(agentId),
      getSnapshot: () => agentsSnapshot,
      subscribe(listener: ChangeListener): () => void {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      },
      list: listAgents,
      async attach(agentId: string): Promise<AcpAgent> {
        const snapshots = await listAgents()
        const snapshot = snapshots.find(
          (candidate) => candidate.agentId === agentId,
        )
        if (!snapshot) {
          throw new AcpClientError({
            code: ACP_ERROR_CODES.agentExited,
            message: `agent ${agentId} is not known to the host`,
            retryable: false,
          })
        }
        return agents.get(agentId) ?? registerAgent(snapshot)
      },
    }),
    sessions: Object.freeze({
      get: (sessionId: string) => sessions.get(sessionId),
      getSnapshot: () => sessionsSnapshot,
      subscribe(listener: ChangeListener): () => void {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
      list: listAllSessions,
      async attach(sessionId: string): Promise<AcpSession> {
        const snapshots = await listAllSessions()
        const snapshot = snapshots.find(
          (candidate) => candidate.sessionId === sessionId,
        )
        if (!snapshot) {
          throw new AcpClientError({
            code: ACP_ERROR_CODES.sessionClosed,
            message: `session ${sessionId} is not known to the host`,
            retryable: false,
          })
        }
        const session = applySessionProjection(snapshot)
        if (session === undefined) {
          throw new AcpClientError({
            code: ACP_ERROR_CODES.sessionClosed,
            message: `session ${sessionId} is deleted`,
            retryable: false,
          })
        }
        return session
      },
      async restore(): Promise<readonly SessionSnapshotWire[]> {
        const restored = (await call(
          ACPJS_HOST_RPC_METHODS.restoreSessions,
          {},
        )) as SessionSnapshotWire[]
        for (const snapshot of restored) applySessionProjection(snapshot)
        return restored
      },
    }),
    permissions: Object.freeze({
      getSnapshot: permissions.getSnapshot,
      subscribe: permissions.subscribe,
    }),
    diagnostics: Object.freeze({
      getSnapshot: diagnostics.getSnapshot,
      subscribe: diagnostics.subscribe,
    }),
    status: Object.freeze({
      getSnapshot: () => statusSnapshot,
      subscribe(listener: ChangeListener): () => void {
        statusListeners.add(listener)
        return () => statusListeners.delete(listener)
      },
    }),
    async dispose(): Promise<void> {
      if (closedError) return
      closedError = transportClosedError()
      for (const unsubscribe of storeUnsubscribers) unsubscribe()
      storeUnsubscribers.clear()
      permissions.clear()
      diagnostics.clear()
      await transport.close()
    },
  })
}
