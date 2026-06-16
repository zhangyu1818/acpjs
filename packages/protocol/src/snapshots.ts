import type {
  McpCapabilities,
  McpServer,
  NesCapabilities,
  PositionEncodingKind,
  PromptCapabilities,
  SessionCapabilities,
} from '@agentclientprotocol/sdk'

import type { AgentExitReason, AgentStatus, SessionStatus } from './domain'

export interface AgentCapabilitiesWire {
  loadSession?: boolean
  mcpCapabilities?: McpCapabilities
  nes?: NesCapabilities | null
  positionEncoding?: PositionEncodingKind | null
  promptCapabilities?: PromptCapabilities
  sessionCapabilities?: SessionCapabilities
}

export interface AgentSnapshotWire {
  agentId: string
  status: AgentStatus
  restartCount: number
  reason?: AgentExitReason
  exit?: { code?: number; signal?: string }
  capabilities?: AgentCapabilitiesWire
}

export interface SessionSnapshotWire {
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
