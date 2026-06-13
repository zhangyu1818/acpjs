export { createAcpClient } from './client.ts'
export { AcpClientError } from './errors.ts'
export { createInProcessTransport } from './in-process.ts'
export type {
  AcpAgent,
  AcpAgentSessions,
  AcpClient,
  AcpSession,
  AgentDefinition,
  AgentSnapshot,
  ChangeListener,
  ConnectionStatusSnapshot,
  CreateAcpClientOptions,
  PermissionListener,
  PermissionRequest,
  SessionConfigValue,
  SessionCreateParams,
  SessionListParams,
  SessionSnapshot,
} from './types.ts'
