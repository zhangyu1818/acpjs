import type {
  AgentCapabilities,
  AgentDefinition,
  AgentSnapshotWire,
  AuthMethod,
  ContentBlock,
  ErrorObject,
  ListSessionsResponse,
  McpServer,
  PermissionRequestCreatedPayload,
  PromptFinishedPayload,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionConfigValue,
  SessionSnapshotWire,
  SessionState,
  Transport,
  TransportConnectionStatus,
} from '@acpjs/protocol'

export type { AgentDefinition, SessionConfigValue }

export type AgentSnapshot = AgentSnapshotWire
export type SessionSnapshot = SessionSnapshotWire

export interface AcpSession {
  readonly sessionId: string
  getSnapshot: () => SessionState
  subscribe: (listener: (state: SessionState) => void) => () => void
  prompt: (blocks: ContentBlock[]) => Promise<PromptFinishedPayload>
  cancel: () => Promise<void>
  close: () => Promise<void>
  setMode: (modeId: string) => Promise<void>
  setConfigOption: (
    configId: string,
    value: SessionConfigValue,
  ) => Promise<SessionConfigOption[]>
}

export interface SessionCreateParams {
  cwd: string
  mcpServers?: McpServer[]
}

export interface SessionListParams {
  cursor?: string
  cwd?: string
}

export interface AcpAgentSessions {
  create: (params: SessionCreateParams) => Promise<AcpSession>
  load: (sessionId: string, params: SessionCreateParams) => Promise<AcpSession>
  list: (params?: SessionListParams) => Promise<ListSessionsResponse>
  resume: (sessionId: string) => Promise<AcpSession>
  delete: (sessionId: string) => Promise<void>
}

export interface AcpAgent {
  readonly agentId: string
  readonly capabilities?: AgentCapabilities
  readonly authMethods?: AuthMethod[]
  getSnapshot: () => AgentSnapshot
  subscribe: (listener: ChangeListener) => () => void
  readonly sessions: AcpAgentSessions
  authenticate: (methodId: string) => Promise<void>
  logout: () => Promise<void>
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
    list: () => Promise<readonly AgentSnapshot[]>
    attach: (agentId: string) => Promise<AcpAgent>
  }
  readonly sessions: {
    get: (sessionId: string) => AcpSession | undefined
    getSnapshot: () => readonly AcpSession[]
    subscribe: (listener: ChangeListener) => () => void
    list: () => Promise<readonly SessionSnapshot[]>
    attach: (sessionId: string) => Promise<AcpSession>
    restore: () => Promise<readonly SessionSnapshot[]>
  }
  readonly permissions: {
    getSnapshot: () => readonly PermissionRequest[]
    subscribe: (listener: PermissionListener) => () => void
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
