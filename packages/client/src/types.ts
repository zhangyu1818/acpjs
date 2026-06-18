import type {
  AcpSessionEvent,
  AgentDefinition,
  AgentSnapshotWire,
  ContentBlock,
  CreateOrLoadSessionParams,
  DiagnosticEvent,
  ErrorObject,
  ListSessionsResponse,
  PermissionRequestCreatedPayload,
  PromptFinishedPayload,
  RequestPermissionOutcome,
  ResumeSessionParams,
  SessionConfigOption,
  SessionConfigValue,
  SessionSnapshotWire,
  SessionState,
  Transport,
  TransportConnectionStatus,
} from '@acpjs/protocol'

export type { AgentDefinition, SessionConfigValue }
export type { CreateOrLoadSessionParams, ResumeSessionParams }

export interface SessionEventOptions {
  readonly fromSeq?: number
}

export interface AcpSession {
  readonly sessionId: string
  getSnapshot: () => SessionState
  subscribe: (listener: (state: SessionState) => void) => () => void
  onEvent: (
    listener: (event: AcpSessionEvent) => void,
    options?: SessionEventOptions,
  ) => () => void
  prompt: (blocks: ContentBlock[]) => Promise<PromptFinishedPayload>
  cancel: () => Promise<void>
  close: () => Promise<void>
  setMode: (modeId: string) => Promise<void>
  setConfigOption: (
    configId: string,
    value: SessionConfigValue,
  ) => Promise<SessionConfigOption[]>
}

export interface SessionListParams {
  cursor?: string
  cwd?: string
}

export interface AcpAgentSessions {
  create: (params: CreateOrLoadSessionParams) => Promise<AcpSession>
  load: (
    sessionId: string,
    params: CreateOrLoadSessionParams,
  ) => Promise<AcpSession>
  list: (params?: SessionListParams) => Promise<ListSessionsResponse>
  resume: (
    sessionId: string,
    params: ResumeSessionParams,
  ) => Promise<AcpSession>
  delete: (sessionId: string) => Promise<void>
}

export interface AcpAgent {
  readonly agentId: string
  getSnapshot: () => AgentSnapshotWire
  subscribe: (listener: ChangeListener) => () => void
  readonly sessions: AcpAgentSessions
}

export interface PermissionRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly toolCall: PermissionRequestCreatedPayload['toolCall']
  readonly options: PermissionRequestCreatedPayload['options']
  respond: (outcome: RequestPermissionOutcome) => Promise<void>
}

export type PermissionListener = (
  requests: readonly PermissionRequest[],
) => void

export type ChangeListener = () => void

export interface ConnectionStatusSnapshot {
  status: TransportConnectionStatus
  error?: ErrorObject
}

export interface AcpClient {
  readonly agents: {
    spawn: (definition: AgentDefinition) => Promise<AcpAgent>
    get: (agentId: string) => AcpAgent | undefined
    getSnapshot: () => readonly AcpAgent[]
    subscribe: (listener: ChangeListener) => () => void
    list: () => Promise<readonly AgentSnapshotWire[]>
    attach: (agentId: string) => Promise<AcpAgent>
    dispose: (agentId: string) => Promise<void>
  }
  readonly sessions: {
    get: (sessionId: string) => AcpSession | undefined
    getSnapshot: () => readonly AcpSession[]
    subscribe: (listener: ChangeListener) => () => void
    list: () => Promise<readonly SessionSnapshotWire[]>
    attach: (sessionId: string) => Promise<AcpSession>
    restore: () => Promise<readonly SessionSnapshotWire[]>
  }
  readonly permissions: {
    getSnapshot: () => readonly PermissionRequest[]
    subscribe: (listener: PermissionListener) => () => void
  }
  readonly diagnostics: {
    getSnapshot: () => readonly DiagnosticEvent[]
    subscribe: (listener: ChangeListener) => () => void
  }
  readonly status: {
    getSnapshot: () => ConnectionStatusSnapshot
    subscribe: (listener: ChangeListener) => () => void
  }
  dispose: () => Promise<void>
}

export interface CreateAcpClientOptions {
  transport: Transport
}
