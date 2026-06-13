import type { AgentCapabilities, AuthMethod } from '@agentclientprotocol/sdk'

import type { AgentExitReason, AgentStatus, SessionStatus } from './events'

export const ACP_RPC_METHODS = Object.freeze({
  spawnAgent: 'agents/spawn',
  authenticate: 'agents/authenticate',
  logout: 'agents/logout',
  createSession: 'sessions/create',
  loadSession: 'sessions/load',
  listSessions: 'sessions/list',
  resumeSession: 'sessions/resume',
  deleteSession: 'sessions/delete',
  prompt: 'sessions/prompt',
  cancel: 'sessions/cancel',
  closeSession: 'sessions/close',
  setMode: 'sessions/setMode',
  setConfigOption: 'sessions/setConfigOption',
  getAllSessions: 'sessions/getAll',
  restoreSessions: 'sessions/restore',
  listAgents: 'agents/list',
} as const)

export type AcpRpcMethod =
  (typeof ACP_RPC_METHODS)[keyof typeof ACP_RPC_METHODS]

export interface AgentDefinition {
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  meta?: Record<string, unknown>
}

export type SessionConfigValue =
  | { type: 'boolean'; value: boolean }
  | { value: string }

export type CreateSessionResult =
  | { status: 'active'; sessionId: string }
  | { status: 'auth-required'; authMethods: AuthMethod[] }

export interface SessionSnapshotWire {
  sessionId: string
  status: SessionStatus
  agentId?: string
  cwd?: string
  agentDefinitionId?: string
}

export interface AgentSnapshotWire {
  agentId: string
  status: AgentStatus
  restartCount: number
  reason?: AgentExitReason
  exit?: { code?: number; signal?: string }
  capabilities?: AgentCapabilities
  authMethods?: AuthMethod[]
  authRequired?: boolean
}
