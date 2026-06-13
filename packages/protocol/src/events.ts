import type {
  AuthMethod,
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

export type AcpEventExtensions = Record<string, unknown>

type Normalized<T> = Omit<T, '_meta'>

export type SessionStatus =
  | 'creating'
  | 'auth-required'
  | 'active'
  | 'prompting'
  | 'disconnected'
  | 'resuming'
  | 'closed'

export type AgentStatus =
  | 'spawning'
  | 'initializing'
  | 'ready'
  | 'exited'
  | 'restarting'

interface SessionEventBase {
  sessionId: string
  seq: number
  ts: number
  extensions?: AcpEventExtensions
}

interface HostEventBase {
  agentId: string
  seq: number
  ts: number
  extensions?: AcpEventExtensions
}

export interface SessionConfigInitPayload {
  modes?: SessionModeState
  configOptions?: SessionConfigOption[]
}

export interface PromptFinishedPayload {
  stopReason: StopReason
  usage?: Usage
  error?: { code: number; message: string; data?: unknown }
}

export interface SessionStatusChangePayload {
  status: SessionStatus
  resumed?: boolean
  authMethods?: AuthMethod[]
}

export type AgentExitReason =
  | 'spawn-failed'
  | 'initialize-failed'
  | 'crashed'
  | 'disposed'
  | 'restart-exhausted'

export interface AgentStatusChangePayload {
  status: AgentStatus
  restartCount: number
  reason?: AgentExitReason
  exit?: { code?: number; signal?: string }
}

export interface AuthRequiredPayload {
  agentId: string
  authMethods: AuthMethod[]
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

export interface SessionAnnouncePayload {
  sessionId: string
  agentId?: string
  cwd?: string
  status: SessionStatus
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

export interface AgentStatusChangeEvent extends HostEventBase {
  type: 'agent-status-change'
  payload: AgentStatusChangePayload
}

export interface InstallProgressEvent extends HostEventBase {
  type: 'install-progress'
  payload: InstallProgressPayload
}

export interface AuthRequiredEvent extends HostEventBase {
  type: 'auth-required'
  payload: AuthRequiredPayload
}

export interface DiagnosticEvent {
  agentId?: string
  seq: number
  ts: number
  type: 'diagnostic'
  payload: DiagnosticPayload
  extensions?: AcpEventExtensions
}

export interface SessionCreatedEvent {
  seq: number
  ts: number
  type: 'session-created'
  payload: SessionAnnouncePayload
  extensions?: AcpEventExtensions
}

export interface SessionClosedEvent {
  seq: number
  ts: number
  type: 'session-closed'
  payload: SessionAnnouncePayload
  extensions?: AcpEventExtensions
}

export type AcpSessionEvent =
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
  | PermissionRequestCreatedEvent
  | PermissionRequestResolvedEvent
  | TerminalOutputEvent
  | UnrecognizedUpdateEvent

export type AcpHostEvent =
  | AgentStatusChangeEvent
  | InstallProgressEvent
  | AuthRequiredEvent
  | DiagnosticEvent
  | SessionCreatedEvent
  | SessionClosedEvent

export type AcpEvent = AcpSessionEvent | AcpHostEvent
