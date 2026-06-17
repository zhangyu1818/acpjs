export { createAcpClient } from './client.ts'
export { AcpClientError } from './errors.ts'
export { createInProcessTransport } from './in-process.ts'
export type {
  AcpAgent,
  AcpAgentSessions,
  AcpClient,
  AcpSession,
  AgentDefinition,
  ChangeListener,
  ConnectionStatusSnapshot,
  CreateOrLoadSessionParams,
  CreateAcpClientOptions,
  PermissionListener,
  PermissionRequest,
  ResumeSessionParams,
  SessionConfigValue,
  SessionEventOptions,
  SessionListParams,
} from './types.ts'
export { createInitialSessionState, reduce } from '@acpjs/protocol'
export type {
  AcpSessionEvent,
  AgentSnapshotWire,
  DiagnosticEvent,
  SessionSnapshotWire,
  SessionState,
} from '@acpjs/protocol'
