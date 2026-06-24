import {
  ACP_ERROR_CODES,
  type AcpEvent,
  type AcpEventExtensions,
  type AcpSessionEvent,
  type AgentExitReason,
  type AgentStatus,
  type SessionStatus,
} from '@acpjs/protocol'

import { AcpError } from './errors.ts'

import type { ChildProcess } from 'node:child_process'

import type {
  AgentCapabilities,
  AuthMethod,
  ClientSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'

import type { ResolvedAgentDefinition } from './options.ts'

export type EventSubscriber = (event: AcpEvent) => void

export interface BufferedSessionEvent {
  type: AcpSessionEvent['type']
  payload: unknown
  extensions?: AcpEventExtensions
}

export interface ClientPromptEcho {
  remaining: ContentBlock[]
}

export interface AgentHandle {
  agentId: string
  definition: ResolvedAgentDefinition
  status: AgentStatus
  reason?: AgentExitReason
  exit: { code?: number; signal?: string } | undefined
  capabilities: AgentCapabilities | undefined
  authMethods: AuthMethod[] | undefined
  restartCount: number
  proc: ChildProcess | undefined
  conn: ClientSideConnection | undefined
  pendingRejects: Set<() => void>
  restartTimer: ReturnType<typeof setTimeout> | undefined
  disposed: boolean
}

export interface SessionHandle {
  sessionId: string
  agentId?: string
  agentDefinitionId?: string
  status: SessionStatus
  cwd: string
  mcpServers?: McpServer[]
  additionalDirectories: string[]
  lifecycleOperation?: 'load' | 'resume' | 'close' | 'delete'
  lifecycleOperationId?: number
  loadReplay?: BufferedSessionEvent[]
  title?: string | null
  updatedAt?: string | null
  log: AcpSessionEvent[]
  nextSeq: number
  hasModes: boolean
  hasConfigOptions: boolean
  clientPromptEchoes?: ClientPromptEcho[]
  promptCancellationRequested?: boolean
  subscribers: Set<EventSubscriber>
}

export interface PendingPermission {
  requestId: string
  sessionId: string
  agentId?: string
  toolCall: ToolCallUpdate
  options: PermissionOption[]
  settle: (
    status: 'answered' | 'superseded',
    outcome?: RequestPermissionOutcome,
  ) => void
}

export interface ProtocolErrorInfo {
  code: number
  message: string
  data?: unknown
}

export function protocolErrorInfo(
  error: unknown,
): ProtocolErrorInfo | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as {
    code?: unknown
    message?: unknown
    data?: unknown
  }
  if (typeof candidate.code !== 'number') return undefined
  return {
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : '',
    ...(candidate.data === undefined ? {} : { data: candidate.data }),
  }
}

export function isStructuredCloneable(value: unknown): boolean {
  try {
    structuredClone(value)
    return true
  } catch {
    return false
  }
}

export function capabilityEnabled(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false
}

export function requireReadyAgent(
  agents: Map<string, AgentHandle>,
  agentId: string | undefined,
): { handle: AgentHandle; conn: ClientSideConnection } {
  const handle = agentId === undefined ? undefined : agents.get(agentId)
  if (handle?.status !== 'ready' || !handle.conn) {
    throw new AcpError(
      ACP_ERROR_CODES.agentExited,
      `agent ${agentId ?? '(none)'} is not ready`,
    )
  }
  return { handle, conn: handle.conn }
}

export async function trackAgentPromise<T>(
  handle: AgentHandle,
  promise: Promise<T>,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const rejectExited = () => {
      rejectPromise(
        new AcpError(
          ACP_ERROR_CODES.agentExited,
          `agent ${handle.agentId} exited`,
        ),
      )
    }
    handle.pendingRejects.add(rejectExited)
    promise.then(
      (value) => {
        handle.pendingRejects.delete(rejectExited)
        resolvePromise(value)
      },
      (error: unknown) => {
        handle.pendingRejects.delete(rejectExited)
        if (
          !(error instanceof AcpError) &&
          protocolErrorInfo(error) === undefined &&
          (handle.proc === undefined ||
            handle.conn === undefined ||
            handle.conn.signal.aborted)
        ) {
          rejectExited()
        } else {
          rejectPromise(error)
        }
      },
    )
  })
}
