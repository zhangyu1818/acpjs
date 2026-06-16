import {
  ACPJS_HOST_RPC_METHODS,
  type AgentSnapshotWire,
  type CreateSessionResult,
  type ListSessionsResponse,
  type SessionSnapshotWire,
} from '@acpjs/protocol'

import { notifyChange, type RpcCall } from './internal.ts'

import type {
  AcpAgent,
  AcpSession,
  ChangeListener,
  CreateOrLoadSessionParams,
  ResumeSessionParams,
  SessionListParams,
} from './types.ts'

export interface AgentHandle {
  agent: AcpAgent
  applySnapshot: (snapshot: AgentSnapshotWire) => void
}

function sameAgentSnapshot(
  current: AgentSnapshotWire,
  next: AgentSnapshotWire,
): boolean {
  return JSON.stringify(current) === JSON.stringify(next)
}

export function createAgentHandle(
  call: RpcCall,
  openSession: (sessionId: string) => AcpSession,
  applySessionSnapshot: (snapshot: SessionSnapshotWire) => AcpSession,
  onStatusChanged: () => void,
  snapshot: AgentSnapshotWire,
): AgentHandle {
  const agentId = snapshot.agentId
  let current = snapshot
  const listeners = new Set<ChangeListener>()
  const agent: AcpAgent = Object.freeze({
    agentId,
    getSnapshot: () => current,
    subscribe(listener: ChangeListener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sessions: Object.freeze({
      async create(params: CreateOrLoadSessionParams): Promise<AcpSession> {
        const result = (await call(ACPJS_HOST_RPC_METHODS.createSession, {
          agentId,
          ...params,
        })) as CreateSessionResult
        return applySessionSnapshot(result)
      },
      async load(
        sessionId: string,
        params: CreateOrLoadSessionParams,
      ): Promise<AcpSession> {
        await call(ACPJS_HOST_RPC_METHODS.loadSession, {
          agentId,
          sessionId,
          ...params,
        })
        return openSession(sessionId)
      },
      async list(
        params: SessionListParams = {},
      ): Promise<ListSessionsResponse> {
        return (await call(ACPJS_HOST_RPC_METHODS.listSessions, {
          agentId,
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        })) as ListSessionsResponse
      },
      async resume(
        sessionId: string,
        params: ResumeSessionParams,
      ): Promise<AcpSession> {
        await call(ACPJS_HOST_RPC_METHODS.resumeSession, {
          agentId,
          sessionId,
          ...params,
        })
        return openSession(sessionId)
      },
      async delete(sessionId: string): Promise<void> {
        await call(ACPJS_HOST_RPC_METHODS.deleteSession, { agentId, sessionId })
      },
    }),
  })
  return {
    agent,
    applySnapshot(snapshot: AgentSnapshotWire): void {
      if (sameAgentSnapshot(current, snapshot)) return
      current = snapshot
      notifyChange(listeners)
      onStatusChanged()
    },
  }
}
