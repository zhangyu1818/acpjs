import {
  ACPJS_ERROR_CODES,
  ACPJS_HOST_METHODS,
  type AcpjsEvent,
  type AgentSnapshot,
  type ErrorObject,
  type SessionSnapshot,
  type HostClientTransportHandlers,
} from '@acpjs/protocol'

import { createAgentHandle } from './agent-handle.ts'
import { createDiagnosticsLog } from './client-diagnostics.ts'
import { createHostCaller } from './client-host-call.ts'
import { createClientPermissionController } from './client-permissions.ts'
import { AcpClientError, transportClosedError } from './errors.ts'
import { notifyChange } from './internal.ts'
import { createPermissionRegistry } from './permission-registry.ts'
import { createSessionEvents } from './session-events.ts'
import { createSessionHandle } from './session-handle.ts'

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
  const storeUnsubscribers = new Set<() => void>()
  const agents = new Map<string, AcpAgent>()
  const agentListeners = new Set<ChangeListener>()
  const agentUpdaters = new Map<
    string,
    {
      applySnapshot: (snapshot: AgentSnapshot) => void
    }
  >()
  let agentsSnapshot: readonly AcpAgent[] = Object.freeze([])

  function publishAgents(): void {
    agentsSnapshot = Object.freeze([...agents.values()])
    notifyChange(agentListeners)
  }

  const sessions = new Map<string, AcpSession>()
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
  const sessionEvents = createSessionEvents({
    subscribe: transport.subscribe,
    storeUnsubscribers,
    prune: (requestId) => permissions.prune(requestId),
  })

  function ensureOpen(): void {
    if (closedError) throw new AcpClientError(closedError)
  }

  const handlers: HostClientTransportHandlers = {
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

  function onHostEvent(event: AcpjsEvent): void {
    if (event.type === 'agent-updated') {
      registerAgent(event.payload)
    } else if (event.type === 'agent-removed') {
      removeAgent(event.payload.agentId)
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

  const call = createHostCaller({
    ensureOpen,
    connected: () => connected,
    request: (request) => transport.request(request),
  })

  function openSession(sessionId: string): AcpSession {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const store = sessionEvents.attachStore(sessionId)
    const session = createSessionHandle(
      call,
      store,
      sessionEvents.onEventFor(store),
    )
    sessions.set(sessionId, session)
    publishSessions()
    return session
  }

  function closeSessionHandle(sessionId: string): void {
    if (!sessions.delete(sessionId)) return
    sessionEvents.closeSession(sessionId)
    publishSessions()
  }

  function applySessionProjection(
    snapshot: SessionSnapshot,
  ): AcpSession | undefined {
    if (snapshot.status === 'deleted' || snapshot.status === 'closed') {
      closeSessionHandle(snapshot.sessionId)
      return undefined
    }
    const existing = sessions.has(snapshot.sessionId)
    const store = sessionEvents.attachStore(snapshot.sessionId)
    const changed = store.applyProjection(snapshot)
    const session = openSession(snapshot.sessionId)
    if (existing && changed) publishSessions()
    return session
  }

  async function listAgents(): Promise<readonly AgentSnapshot[]> {
    return (await call(ACPJS_HOST_METHODS.listAgents, {})) as AgentSnapshot[]
  }

  async function listAllSessions(): Promise<readonly SessionSnapshot[]> {
    return (await call(
      ACPJS_HOST_METHODS.getAllSessions,
      {},
    )) as SessionSnapshot[]
  }

  function registerAgent(snapshot: AgentSnapshot): AcpAgent {
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
            code: ACPJS_ERROR_CODES.sessionClosed,
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

  function removeAgent(agentId: string): void {
    if (!agents.delete(agentId)) return
    agentUpdaters.delete(agentId)
    publishAgents()
  }

  return Object.freeze({
    agents: Object.freeze({
      async spawn(definition: AgentDefinition): Promise<AcpAgent> {
        const snapshot = (await call(ACPJS_HOST_METHODS.spawnAgent, {
          definition,
        })) as AgentSnapshot
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
            code: ACPJS_ERROR_CODES.agentExited,
            message: `agent ${agentId} is not known to the host`,
            retryable: false,
          })
        }
        return agents.get(agentId) ?? registerAgent(snapshot)
      },
      async dispose(agentId: string): Promise<void> {
        await call(ACPJS_HOST_METHODS.disposeAgent, { agentId })
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
            code: ACPJS_ERROR_CODES.sessionClosed,
            message: `session ${sessionId} is not known to the host`,
            retryable: false,
          })
        }
        const session = applySessionProjection(snapshot)
        if (session === undefined) {
          throw new AcpClientError({
            code: ACPJS_ERROR_CODES.sessionClosed,
            message: `session ${sessionId} is deleted`,
            retryable: false,
          })
        }
        return session
      },
      async restore(): Promise<readonly SessionSnapshot[]> {
        const restored = (await call(
          ACPJS_HOST_METHODS.restoreSessions,
          {},
        )) as SessionSnapshot[]
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
      sessionEvents.closeAll()
      for (const unsubscribe of storeUnsubscribers) unsubscribe()
      storeUnsubscribers.clear()
      permissions.clear()
      diagnostics.clear()
      await transport.close()
    },
  })
}
