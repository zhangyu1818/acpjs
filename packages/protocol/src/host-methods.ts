import type { McpServer } from '@agentclientprotocol/sdk'

import type { SessionStatus } from './domain'
import type { AgentSnapshot, SessionSnapshot } from './snapshots'

export const ACPJS_HOST_METHODS = Object.freeze({
  spawnAgent: 'agents/spawn',
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
  disposeAgent: 'agents/dispose',
  authenticate: 'agents/authenticate',
  logout: 'agents/logout',
} as const)

export type AcpjsHostMethod =
  (typeof ACPJS_HOST_METHODS)[keyof typeof ACPJS_HOST_METHODS]

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

export interface CreateSessionResult {
  sessionId: string
  status: SessionStatus
  agentId?: string
  cwd: string
  mcpServers?: McpServer[]
  additionalDirectories: string[]
  agentDefinitionId?: string
  title?: string | null
  updatedAt?: string | null
}

export interface CreateOrLoadSessionParams {
  cwd: string
  mcpServers: McpServer[]
  additionalDirectories: string[]
}

export interface ResumeSessionParams {
  cwd: string
  mcpServers?: McpServer[]
  additionalDirectories: string[]
}

export type { AgentSnapshot, SessionSnapshot }
