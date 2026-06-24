import type {
  AgentCapabilities,
  AuthMethod,
  EnvVariable,
  McpServer,
  PermissionOption,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
  Usage,
} from '@agentclientprotocol/sdk'

export interface FixtureScenario {
  initialize?: {
    protocolVersion?: number
    agentCapabilities?: AgentCapabilities
    authMethods?: AuthMethod[]
  }
  session?: {
    sessionId?: string
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    authRequired?: boolean
    error?: { code: number; message: string; data?: unknown }
  }
  turns?: FixtureTurn[]
  loadSession?: {
    steps?: FixtureStep[]
    replay?: SessionUpdate[]
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    expectMcpServers?: McpServer[]
    error?: { code: number; message: string; data?: unknown }
    failures?: number
  }
  listSessions?: {
    sessions: SessionInfo[]
    nextCursor?: string
  }
  resumeSession?: {
    steps?: FixtureStep[]
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    expectMcpServers?: McpServer[]
    error?: { code: number; message: string; data?: unknown }
    failures?: number
  }
  closeSession?: {
    error?: { code: number; message: string; data?: unknown }
  }
  deleteSession?: {
    error?: { code: number; message: string; data?: unknown }
  }
  setConfigOption?: {
    configOptions: SessionConfigOption[]
  }
}

export interface FixtureTurn {
  steps?: FixtureStep[]
  stopReason?: StopReason
  usage?: Usage
}

export interface FixturePermissionStep {
  kind: 'permission'
  toolCall: ToolCallUpdate
  options: PermissionOption[]
  onSelected?: Record<string, FixtureStep[]>
  onCancelled?: FixtureStep[]
}

export type FixtureStep =
  | { kind: 'update'; update: SessionUpdate }
  | FixturePermissionStep
  | { kind: 'readTextFile'; path: string; line?: number; limit?: number }
  | { kind: 'writeTextFile'; path: string; content: string }
  | {
      kind: 'terminal'
      command: string
      args?: string[]
      env?: EnvVariable[]
      cwd?: string
      outputByteLimit?: number
      actions?: ('output' | 'waitForExit' | 'kill' | 'release')[]
    }
  | { kind: 'sleep'; ms: number }
  | { kind: 'disconnect' }
  | { kind: 'error'; code: number; message: string; data?: unknown }
  | { kind: 'exit'; code: number }
