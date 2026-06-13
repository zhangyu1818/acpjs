import type { AcpEvent } from './events'

export const ACP_ERROR_CODES = Object.freeze({
  configInvalid: 'acpjs/config-invalid',
  promptInFlight: 'acpjs/prompt-in-flight',
  alreadyAnswered: 'acpjs/already-answered',
  sessionClosed: 'acpjs/session-closed',
  agentExited: 'acpjs/agent-exited',
  capabilityUnsupported: 'acpjs/capability-unsupported',
  authRequired: 'acpjs/auth-required',
  agentError: 'acpjs/agent-error',
  transportClosed: 'acpjs/transport-closed',
} as const)

export type AcpErrorCode =
  (typeof ACP_ERROR_CODES)[keyof typeof ACP_ERROR_CODES]

const errorCodeValues: ReadonlySet<string> = new Set(
  Object.values(ACP_ERROR_CODES),
)

export function isAcpErrorCode(value: string): value is AcpErrorCode {
  return errorCodeValues.has(value)
}

export interface ErrorObject {
  code: AcpErrorCode
  message: string
  data?: unknown
  retryable: boolean
}

export interface RpcRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

export type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: ErrorObject }

export type InboundRequestKind = 'permission' | (string & {})

export interface InboundRequest {
  id: string
  kind: InboundRequestKind
  payload: unknown
}

export interface InboundResponse {
  id: string
  result: unknown
}

export type TransportConnectionStatus = 'connecting' | 'connected' | 'closed'

export interface TransportLifecycleEvent {
  status: TransportConnectionStatus
  error?: ErrorObject
}

export interface TransportSubscribeParams {
  sessionId?: string
  fromSeq: number
}

export type TransportUnsubscribe = () => void

export interface TransportHandlers {
  onInboundRequest: (request: InboundRequest) => void
  onLifecycle: (event: TransportLifecycleEvent) => void
}

export interface EnvelopeEndpoint {
  request: (request: RpcRequest) => Promise<RpcResponse>
  subscribe: (
    params: TransportSubscribeParams,
    onEvent: (event: AcpEvent) => void,
  ) => TransportUnsubscribe
  onInboundRequest: (
    handler: (request: InboundRequest) => void,
  ) => TransportUnsubscribe
  respondInbound: (response: InboundResponse) => Promise<void>
}

export interface Transport {
  connect: (handlers: TransportHandlers) => Promise<void>
  request: (request: RpcRequest) => Promise<RpcResponse>
  subscribe: (
    params: TransportSubscribeParams,
    onEvent: (event: AcpEvent) => void,
  ) => TransportUnsubscribe
  respondInbound: (response: InboundResponse) => Promise<void>
  close: () => Promise<void>
}
