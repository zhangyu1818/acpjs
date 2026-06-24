import type {
  AvailableCommandsUpdate,
  ConfigOptionUpdate,
  ContentChunk,
  CurrentModeUpdate,
  PermissionOption,
  Plan,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionInfoUpdate,
  SessionModeState,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  Usage,
  UsageUpdate,
} from '@agentclientprotocol/sdk'

import type { SessionStatus } from './domain'
import type { AgentSnapshot, SessionSnapshot } from './snapshots'

export type AcpjsEventExtensions = Record<string, unknown>

type Normalized<T> = Omit<T, '_meta'>

interface SessionEventBase {
  sessionId: string
  seq: number
  ts: number
  extensions?: AcpjsEventExtensions
}

interface HostEventBase {
  agentId: string
  seq: number
  ts: number
  extensions?: AcpjsEventExtensions
}

export interface SessionConfigInitPayload {
  modes?: SessionModeState
  configOptions?: SessionConfigOption[]
}

export interface PromptFinishedPayload {
  stopReason: StopReason
  usage?: Usage
}

export interface SessionStatusChangePayload {
  status: SessionStatus
  resumed?: boolean
}

export interface SessionResetPayload {
  reason: 'load'
}

export interface PermissionRequestCreatedPayload {
  requestId: string
  toolCall: ToolCallUpdate
  options: PermissionOption[]
}

export interface PermissionRequestResolvedPayload {
  requestId: string
  status: 'answered' | 'superseded'
  outcome?: RequestPermissionOutcome
}

export interface HostPermissionSnapshot {
  requestId: string
  sessionId: string
  agentId?: string
  status: 'pending' | 'answered' | 'superseded'
  toolCall: ToolCallUpdate
  options: PermissionOption[]
  outcome?: RequestPermissionOutcome
}

export interface TerminalOutputPayload {
  terminalId: string
  delta?: string
  truncated?: boolean
  exit?: { exitCode?: number; signal?: string }
}

export type InstallStage =
  | 'resolving'
  | 'cache-hit'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installed'
  | 'failed'

export interface InstallProgressPayload {
  stage: InstallStage
  version?: string
  platform?: string
  downloadedBytes?: number
  totalBytes?: number
  reason?: string
}

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export interface DiagnosticPayload {
  level: DiagnosticLevel
  code: string
  message: string
  sessionId?: string
  data?: unknown
}

export type UnrecognizedUpdatePayload = { sessionUpdate: string } & Record<
  string,
  unknown
>

export interface UserMessageChunkEvent extends SessionEventBase {
  type: 'user-message-chunk'
  payload: Normalized<ContentChunk>
}

export interface AgentMessageChunkEvent extends SessionEventBase {
  type: 'agent-message-chunk'
  payload: Normalized<ContentChunk>
}

export interface AgentThoughtChunkEvent extends SessionEventBase {
  type: 'agent-thought-chunk'
  payload: Normalized<ContentChunk>
}

export interface ToolCallEvent extends SessionEventBase {
  type: 'tool-call'
  payload: Normalized<ToolCall>
}

export interface ToolCallUpdateEvent extends SessionEventBase {
  type: 'tool-call-update'
  payload: Normalized<ToolCallUpdate>
}

export interface PlanEvent extends SessionEventBase {
  type: 'plan'
  payload: Normalized<Plan>
}

export interface AvailableCommandsUpdateEvent extends SessionEventBase {
  type: 'available-commands-update'
  payload: Normalized<AvailableCommandsUpdate>
}

export interface CurrentModeUpdateEvent extends SessionEventBase {
  type: 'current-mode-update'
  payload: Normalized<CurrentModeUpdate>
}

export interface SessionConfigInitEvent extends SessionEventBase {
  type: 'session-config-init'
  payload: SessionConfigInitPayload
}

export interface ConfigOptionsUpdateEvent extends SessionEventBase {
  type: 'config-options-update'
  payload: Normalized<ConfigOptionUpdate>
}

export interface SessionInfoUpdateEvent extends SessionEventBase {
  type: 'session-info-update'
  payload: Normalized<SessionInfoUpdate>
}

export interface UsageUpdateEvent extends SessionEventBase {
  type: 'usage-update'
  payload: Normalized<UsageUpdate>
}

export interface PromptFinishedEvent extends SessionEventBase {
  type: 'prompt-finished'
  payload: PromptFinishedPayload
}

export interface SessionStatusChangeEvent extends SessionEventBase {
  type: 'session-status-change'
  payload: SessionStatusChangePayload
}

export interface SessionResetEvent extends SessionEventBase {
  type: 'session-reset'
  payload: SessionResetPayload
}

export interface PermissionRequestCreatedEvent extends SessionEventBase {
  type: 'permission-request-created'
  payload: PermissionRequestCreatedPayload
}

export interface PermissionRequestResolvedEvent extends SessionEventBase {
  type: 'permission-request-resolved'
  payload: PermissionRequestResolvedPayload
}

export interface TerminalOutputEvent extends SessionEventBase {
  type: 'terminal-output'
  payload: TerminalOutputPayload
}

export interface UnrecognizedUpdateEvent extends SessionEventBase {
  type: 'unrecognized-update'
  payload: UnrecognizedUpdatePayload
}

export interface AgentUpdatedEvent extends HostEventBase {
  type: 'agent-updated'
  payload: AgentSnapshot
}

export interface AgentRemovedEvent extends HostEventBase {
  type: 'agent-removed'
  payload: { agentId: string }
}

export interface InstallProgressEvent extends HostEventBase {
  type: 'install-progress'
  payload: InstallProgressPayload
}

export interface DiagnosticEvent {
  agentId?: string
  seq: number
  ts: number
  type: 'diagnostic'
  payload: DiagnosticPayload
  extensions?: AcpjsEventExtensions
}

export interface SessionUpdatedEvent {
  seq: number
  ts: number
  type: 'session-updated'
  payload: SessionSnapshot
  extensions?: AcpjsEventExtensions
}

export interface PermissionUpdatedEvent {
  seq: number
  ts: number
  type: 'permission-updated'
  payload: HostPermissionSnapshot
  extensions?: AcpjsEventExtensions
}

export type AcpjsSessionEvent =
  | UserMessageChunkEvent
  | AgentMessageChunkEvent
  | AgentThoughtChunkEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | PlanEvent
  | AvailableCommandsUpdateEvent
  | CurrentModeUpdateEvent
  | SessionConfigInitEvent
  | ConfigOptionsUpdateEvent
  | SessionInfoUpdateEvent
  | UsageUpdateEvent
  | PromptFinishedEvent
  | SessionStatusChangeEvent
  | SessionResetEvent
  | PermissionRequestCreatedEvent
  | PermissionRequestResolvedEvent
  | TerminalOutputEvent
  | UnrecognizedUpdateEvent

export type AcpjsHostProjectionEvent =
  | AgentUpdatedEvent
  | AgentRemovedEvent
  | SessionUpdatedEvent
  | PermissionUpdatedEvent

export type AcpjsHostTelemetryEvent = InstallProgressEvent | DiagnosticEvent

export type AcpjsHostEvent = AcpjsHostProjectionEvent | AcpjsHostTelemetryEvent

export type AcpjsEvent = AcpjsSessionEvent | AcpjsHostEvent
