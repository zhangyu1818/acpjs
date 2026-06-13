import {
  ACP_RPC_METHODS,
  type AgentSnapshotWire,
  type AgentStatusChangePayload,
  type AuthRequiredPayload,
  type CreateSessionResult,
  type ListSessionsResponse,
} from '@acpjs/protocol'

import { AcpClientError } from './errors.ts'
import { notifyChange, type RpcCall } from './internal.ts'

import type {
  AcpAgent,
  AcpSession,
  ChangeListener,
  SessionCreateParams,
  SessionListParams,
} from './types.ts'

export interface AgentHandle {
  agent: AcpAgent
  applyStatus: (payload: AgentStatusChangePayload) => void
  applyAuthRequired: (payload: AuthRequiredPayload) => void
}

function sameAuthMethods(
  current: AgentSnapshotWire['authMethods'],
  next: AuthRequiredPayload['authMethods'],
): boolean {
  if (current === undefined) return next.length === 0
  if (current.length !== next.length) return false
  return current.every((method, index) => method.id === next[index]?.id)
}

function sameRuntimeState(
  current: AgentSnapshotWire,
  payload: AgentStatusChangePayload,
): boolean {
  return (
    current.status === payload.status &&
    current.restartCount === payload.restartCount &&
    current.reason === payload.reason &&
    current.exit?.code === payload.exit?.code &&
    current.exit?.signal === payload.exit?.signal
  )
}

export function createAgentHandle(
  call: RpcCall,
  openSession: (sessionId: string) => AcpSession,
  onStatusChanged: () => void,
  snapshot: AgentSnapshotWire,
): AgentHandle {
  const agentId = snapshot.agentId
  let current = snapshot
  const listeners = new Set<ChangeListener>()
  const agent: AcpAgent = Object.freeze({
    agentId,
    ...(snapshot.capabilities === undefined
      ? {}
      : { capabilities: snapshot.capabilities }),
    ...(snapshot.authMethods === undefined
      ? {}
      : { authMethods: snapshot.authMethods }),
    getSnapshot: () => current,
    subscribe(listener: ChangeListener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sessions: Object.freeze({
      async create(params: SessionCreateParams): Promise<AcpSession> {
        const result = (await call(ACP_RPC_METHODS.createSession, {
          agentId,
          cwd: params.cwd,
          ...(params.mcpServers === undefined
            ? {}
            : { mcpServers: params.mcpServers }),
        })) as CreateSessionResult
        if (result.status === 'auth-required') {
          throw new AcpClientError({
            code: 'acpjs/auth-required',
            message: 'agent requires authentication',
            data: { authMethods: result.authMethods },
            retryable: true,
          })
        }
        return openSession(result.sessionId)
      },
      async load(
        sessionId: string,
        params: SessionCreateParams,
      ): Promise<AcpSession> {
        await call(ACP_RPC_METHODS.loadSession, {
          agentId,
          sessionId,
          cwd: params.cwd,
          ...(params.mcpServers === undefined
            ? {}
            : { mcpServers: params.mcpServers }),
        })
        return openSession(sessionId)
      },
      async list(
        params: SessionListParams = {},
      ): Promise<ListSessionsResponse> {
        return (await call(ACP_RPC_METHODS.listSessions, {
          agentId,
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        })) as ListSessionsResponse
      },
      async resume(sessionId: string): Promise<AcpSession> {
        await call(ACP_RPC_METHODS.resumeSession, { sessionId })
        return openSession(sessionId)
      },
      async delete(sessionId: string): Promise<void> {
        await call(ACP_RPC_METHODS.deleteSession, { sessionId })
      },
    }),
    async authenticate(methodId: string): Promise<void> {
      await call(ACP_RPC_METHODS.authenticate, { agentId, methodId })
    },
    async logout(): Promise<void> {
      await call(ACP_RPC_METHODS.logout, { agentId })
    },
  })
  return {
    agent,
    applyStatus(payload: AgentStatusChangePayload): void {
      if (sameRuntimeState(current, payload)) return
      current = {
        agentId,
        status: payload.status,
        restartCount: payload.restartCount,
        ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        ...(payload.exit === undefined ? {} : { exit: payload.exit }),
        ...(current.capabilities === undefined
          ? {}
          : { capabilities: current.capabilities }),
        ...(current.authMethods === undefined
          ? {}
          : { authMethods: current.authMethods }),
        ...(current.authRequired === undefined
          ? {}
          : { authRequired: current.authRequired }),
      }
      notifyChange(listeners)
      onStatusChanged()
    },
    applyAuthRequired(payload: AuthRequiredPayload): void {
      if (
        current.authRequired === true &&
        sameAuthMethods(current.authMethods, payload.authMethods)
      ) {
        return
      }
      current = {
        ...current,
        authRequired: true,
        authMethods: payload.authMethods,
      }
      notifyChange(listeners)
      onStatusChanged()
    },
  }
}
