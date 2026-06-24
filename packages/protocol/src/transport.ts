import type { AcpjsEvent } from './events'
import type { AcpjsHostMethod } from './host-methods'

export const ACPJS_ERROR_CODES = Object.freeze({
  configInvalid: 'acpjs/config-invalid',
  promptInFlight: 'acpjs/prompt-in-flight',
  alreadyAnswered: 'acpjs/already-answered',
  sessionClosed: 'acpjs/session-closed',
  agentExited: 'acpjs/agent-exited',
  capabilityUnsupported: 'acpjs/capability-unsupported',
  agentError: 'acpjs/agent-error',
  transportClosed: 'acpjs/transport-closed',
} as const)

export type AcpjsErrorCode =
  (typeof ACPJS_ERROR_CODES)[keyof typeof ACPJS_ERROR_CODES]

const errorCodeValues: ReadonlySet<string> = new Set(
  Object.values(ACPJS_ERROR_CODES),
)

export function isAcpjsErrorCode(value: string): value is AcpjsErrorCode {
  return errorCodeValues.has(value)
}

export interface ErrorObject {
  code: AcpjsErrorCode
  message: string
  data?: unknown
  retryable: boolean
}

export interface HostRequest {
  id: string
  method: AcpjsHostMethod
  params: Record<string, unknown>
}

export type HostResponse =
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

export type HostClientTransportConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'closed'

export interface HostClientTransportLifecycleEvent {
  status: HostClientTransportConnectionStatus
  error?: ErrorObject
}

export interface HostClientTransportSubscribeParams {
  sessionId?: string
  fromSeq: number
}

export type HostClientTransportUnsubscribe = () => void

export interface HostClientTransportHandlers {
  onInboundRequest: (request: InboundRequest) => void
  onLifecycle: (event: HostClientTransportLifecycleEvent) => void
  onSubscriptionError?: (
    params: HostClientTransportSubscribeParams,
    error: ErrorObject,
  ) => void
}

export interface EnvelopeEndpoint {
  request: (request: HostRequest) => Promise<HostResponse>
  subscribe: (
    params: HostClientTransportSubscribeParams,
    onEvent: (event: AcpjsEvent) => void,
  ) => HostClientTransportUnsubscribe
  onInboundRequest: (
    handler: (request: InboundRequest) => void,
  ) => HostClientTransportUnsubscribe
  respondInbound: (response: InboundResponse) => Promise<void>
}

export interface HostClientTransport {
  connect: (handlers: HostClientTransportHandlers) => Promise<void>
  request: (request: HostRequest) => Promise<HostResponse>
  subscribe: (
    params: HostClientTransportSubscribeParams,
    onEvent: (event: AcpjsEvent) => void,
  ) => HostClientTransportUnsubscribe
  respondInbound: (response: InboundResponse) => Promise<void>
  close: () => Promise<void>
}
