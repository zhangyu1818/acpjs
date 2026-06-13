import {
  ACP_ERROR_CODES,
  ACP_RPC_METHODS,
  type AcpEvent,
  type AgentSnapshotWire,
  type AgentStatusChangePayload,
  type AuthRequiredPayload,
  type ErrorObject,
  type PermissionRequestCreatedPayload,
  type RequestPermissionOutcome,
  type SessionSnapshotWire,
  type TransportHandlers,
} from '@acpjs/protocol'

import { createAgentHandle } from './agent-handle.ts'
import {
  AcpClientError,
  toClientError,
  transportClosedError,
} from './errors.ts'
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
  PermissionRequest,
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
      applyStatus: (payload: AgentStatusChangePayload) => void
      applyAuthRequired: (payload: AuthRequiredPayload) => void
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

  const permissions = createPermissionRegistry()

  let statusSnapshot: ConnectionStatusSnapshot = Object.freeze({
    status: 'connecting' as const,
  })
  const statusListeners = new Set<ChangeListener>()

  function ensureOpen(): void {
    if (closedError) throw new AcpClientError(closedError)
  }

  const handlers: TransportHandlers = {
    onInboundRequest(request) {
      if (request.kind !== 'permission') return
      const payload = request.payload as PermissionRequestCreatedPayload & {
        sessionId: string
      }
      const permission: PermissionRequest = Object.freeze({
        requestId: payload.requestId,
        sessionId: payload.sessionId,
        toolCall: payload.toolCall,
        options: payload.options,
        respond: (outcome: RequestPermissionOutcome) =>
          respondPermission(request.id, payload.requestId, outcome),
      })
      permissions.add(permission)
    },
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
  }

  function onHostEvent(event: AcpEvent): void {
    if (event.type === 'agent-status-change') {
      agentUpdaters.get(event.agentId)?.applyStatus(event.payload)
    } else if (event.type === 'auth-required') {
      agentUpdaters.get(event.agentId)?.applyAuthRequired(event.payload)
    } else if (
      event.type === 'session-created' ||
      event.type === 'session-closed'
    ) {
      notifyChange(sessionListeners)
    }
  }

  const connected = transport.connect(handlers)
  connected
    .then(() => {
      if (closedError) return
      storeUnsubscribers.add(transport.subscribe({ fromSeq: 0 }, onHostEvent))
    })
    .catch(() => {})

  async function respondPermission(
    inboundId: string,
    requestId: string,
    outcome: RequestPermissionOutcome,
  ): Promise<void> {
    ensureOpen()
    try {
      await connected
      await transport.respondInbound({ id: inboundId, result: outcome })
    } catch (error) {
      const clientError = toClientError(error)
      if (clientError.code === ACP_ERROR_CODES.alreadyAnswered) {
        permissions.prune(requestId)
      }
      throw clientError
    }
    permissions.prune(requestId)
  }

  let rpcCounter = 0
  async function call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    ensureOpen()
    try {
      await connected
    } catch (error) {
      throw toClientError(error)
    }
    ensureOpen()
    rpcCounter += 1
    let response
    try {
      response = await transport.request({
        id: `rpc-${rpcCounter}`,
        method,
        params,
      })
    } catch (error) {
      throw toClientError(error)
    }
    if (!response.ok) throw new AcpClientError(response.error)
    return response.result
  }

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

  async function listAgents(): Promise<readonly AgentSnapshotWire[]> {
    return (await call(ACP_RPC_METHODS.listAgents, {})) as AgentSnapshotWire[]
  }

  async function listAllSessions(): Promise<readonly SessionSnapshotWire[]> {
    return (await call(
      ACP_RPC_METHODS.getAllSessions,
      {},
    )) as SessionSnapshotWire[]
  }

  function registerAgent(snapshot: AgentSnapshotWire): AcpAgent {
    const { agent, applyStatus, applyAuthRequired } = createAgentHandle(
      call,
      openSession,
      publishAgents,
      snapshot,
    )
    agentUpdaters.set(agent.agentId, { applyStatus, applyAuthRequired })
    agents.set(agent.agentId, agent)
    publishAgents()
    return agent
  }

  return Object.freeze({
    agents: Object.freeze({
      async spawn(definition: AgentDefinition): Promise<AcpAgent> {
        const snapshot = (await call(ACP_RPC_METHODS.spawnAgent, {
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
        const known = snapshots.some(
          (candidate) => candidate.sessionId === sessionId,
        )
        if (!known) {
          throw new AcpClientError({
            code: ACP_ERROR_CODES.sessionClosed,
            message: `session ${sessionId} is not known to the host`,
            retryable: false,
          })
        }
        return openSession(sessionId)
      },
      async restore(): Promise<readonly SessionSnapshotWire[]> {
        return (await call(
          ACP_RPC_METHODS.restoreSessions,
          {},
        )) as SessionSnapshotWire[]
      },
    }),
    permissions: Object.freeze({
      getSnapshot: permissions.getSnapshot,
      subscribe: permissions.subscribe,
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
      await transport.close()
    },
  })
}
