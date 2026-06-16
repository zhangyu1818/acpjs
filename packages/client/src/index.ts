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
  SessionListParams,
} from './types.ts'
export type {
  AgentSnapshotWire,
  DiagnosticEvent,
  SessionSnapshotWire,
} from '@acpjs/protocol'
