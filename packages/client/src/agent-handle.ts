import {
  ACPJS_HOST_METHODS,
  type AgentSnapshot,
  type CreateSessionResult,
  type ListSessionsResponse,
  type SessionSnapshot,
} from '@acpjs/protocol'

import { notifyChange, type HostCall } from './internal.ts'

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
  applySnapshot: (snapshot: AgentSnapshot) => void
}

function sameAgentSnapshot(
  current: AgentSnapshot,
  next: AgentSnapshot,
): boolean {
  return JSON.stringify(current) === JSON.stringify(next)
}

export function createAgentHandle(
  call: HostCall,
  openSession: (sessionId: string) => AcpSession,
  applySessionSnapshot: (snapshot: SessionSnapshot) => AcpSession,
  onStatusChanged: () => void,
  snapshot: AgentSnapshot,
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
    async authenticate(methodId: string): Promise<void> {
      await call(ACPJS_HOST_METHODS.authenticate, { agentId, methodId })
    },
    async logout(): Promise<void> {
      await call(ACPJS_HOST_METHODS.logout, { agentId })
    },
    sessions: Object.freeze({
      async create(params: CreateOrLoadSessionParams): Promise<AcpSession> {
        const result = (await call(ACPJS_HOST_METHODS.createSession, {
          agentId,
          ...params,
        })) as CreateSessionResult
        return applySessionSnapshot(result)
      },
      async load(
        sessionId: string,
        params: CreateOrLoadSessionParams,
      ): Promise<AcpSession> {
        await call(ACPJS_HOST_METHODS.loadSession, {
          agentId,
          sessionId,
          ...params,
        })
        return openSession(sessionId)
      },
      async list(
        params: SessionListParams = {},
      ): Promise<ListSessionsResponse> {
        return (await call(ACPJS_HOST_METHODS.listSessions, {
          agentId,
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        })) as ListSessionsResponse
      },
      async resume(
        sessionId: string,
        params: ResumeSessionParams,
      ): Promise<AcpSession> {
        await call(ACPJS_HOST_METHODS.resumeSession, {
          agentId,
          sessionId,
          ...params,
        })
        return openSession(sessionId)
      },
      async delete(sessionId: string): Promise<void> {
        await call(ACPJS_HOST_METHODS.deleteSession, { agentId, sessionId })
      },
    }),
  })
  return {
    agent,
    applySnapshot(snapshot: AgentSnapshot): void {
      if (sameAgentSnapshot(current, snapshot)) return
      current = snapshot
      notifyChange(listeners)
      onStatusChanged()
    },
  }
}
