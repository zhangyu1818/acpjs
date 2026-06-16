import type {
  AvailableCommand,
  ContentBlock,
  Cost,
  PermissionOption,
  Plan,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionModeState,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  Usage,
} from '@agentclientprotocol/sdk'

import type { SessionStatus } from './domain'

export type MessageKind = 'user' | 'agent' | 'thought'

export interface SessionMessage {
  kind: MessageKind
  messageId: string | null
  content: ContentBlock[]
  seq: number
}

export interface ToolCallState {
  toolCallId: string
  title: string
  kind: ToolKind | null
  status: ToolCallStatus | null
  content: ToolCallContent[]
  locations: ToolCallLocation[]
  rawInput: unknown
  rawOutput: unknown
  seq: number
}

export interface TerminalOutputState {
  output: string
  truncated: boolean
  exit?: { exitCode?: number; signal?: string }
}

export interface SessionUsageState {
  used: number
  size: number
  cost: Cost | null
}

export interface SessionConnectionState {
  status: SessionStatus
  resumed: boolean
}

export interface PendingPermissionRequest {
  requestId: string
  toolCall: ToolCallUpdate
  options: PermissionOption[]
}

export interface ResolvedPermissionRequest {
  requestId: string
  toolCall: ToolCallUpdate
  status: 'answered' | 'superseded'
  outcome?: RequestPermissionOutcome
}

export interface PromptErrorState {
  code: number
  message: string
  data?: unknown
}

export interface SessionState {
  sessionId: string
  messages: SessionMessage[]
  toolCalls: Record<string, ToolCallState>
  plan: Plan | null
  availableCommands: AvailableCommand[]
  modes: SessionModeState | null
  configOptions: SessionConfigOption[]
  info: { title: string | null; updatedAt: string | null }
  usage: SessionUsageState | null
  lastTurnUsage: Usage | null
  lastStopReason: StopReason | null
  lastPromptError: PromptErrorState | null
  connection: SessionConnectionState
  pendingPermissionRequests: PendingPermissionRequest[]
  terminals: Record<string, TerminalOutputState>
  resolvedPermissionRequests: ResolvedPermissionRequest[]
}

export function createInitialSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    messages: [],
    toolCalls: {},
    plan: null,
    availableCommands: [],
    modes: null,
    configOptions: [],
    info: { title: null, updatedAt: null },
    usage: null,
    lastTurnUsage: null,
    lastStopReason: null,
    lastPromptError: null,
    connection: { status: 'creating', resumed: false },
    pendingPermissionRequests: [],
    terminals: {},
    resolvedPermissionRequests: [],
  }
}
