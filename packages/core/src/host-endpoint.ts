import {
  ACP_ERROR_CODES,
  ACP_RPC_METHODS,
  type AgentDefinition,
  type EnvelopeEndpoint,
  type ErrorObject,
  type InboundRequest,
  type RpcRequest,
  type RpcResponse,
  type SessionConfigValue,
} from '@acpjs/protocol'

import { AcpError } from './errors.ts'
import { hostBus } from './event-bus.ts'
import { protocolErrorInfo } from './internal.ts'

import type {
  ContentBlock,
  McpServer,
  RequestPermissionOutcome,
} from '@agentclientprotocol/sdk'

import type { AcpHost } from './host.ts'

type InboundHandler = (request: InboundRequest) => void

function requireParam<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new AcpError(
      ACP_ERROR_CODES.configInvalid,
      `missing required param ${name}`,
    )
  }
  return value
}

interface OutstandingPermission {
  request: InboundRequest
  notified: Set<InboundHandler>
}

function toErrorObject(error: unknown): ErrorObject {
  if (error instanceof AcpError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
      retryable: error.retryable,
    }
  }
  const info = protocolErrorInfo(error)
  if (info) {
    return {
      code: ACP_ERROR_CODES.agentError,
      message: info.message,
      data: info,
      retryable: false,
    }
  }
  return {
    code: ACP_ERROR_CODES.agentError,
    message: error instanceof Error ? error.message : 'unknown error',
    retryable: false,
  }
}

export function createHostEndpoint(host: AcpHost): EnvelopeEndpoint {
  const inboundHandlers = new Set<InboundHandler>()
  const outstanding = new Map<string, OutstandingPermission>()
  const watched = new Set<string>()

  function notify(entry: OutstandingPermission): void {
    for (const handler of inboundHandlers) {
      if (entry.notified.has(handler)) continue
      entry.notified.add(handler)
      try {
        handler(entry.request)
      } catch (error) {
        hostBus(host)?.diagnostic('error', 'subscriber/error', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  function watchSession(sessionId: string): void {
    if (watched.has(sessionId)) return
    watched.add(sessionId)
    host.subscribe(sessionId, 0, (event) => {
      if (event.type === 'permission-request-created') {
        const requestId = event.payload.requestId
        const entry: OutstandingPermission = {
          request: {
            id: requestId,
            kind: 'permission',
            payload: { ...event.payload, sessionId },
          },
          notified: new Set(),
        }
        outstanding.set(requestId, entry)
        queueMicrotask(() => {
          if (outstanding.get(requestId) === entry) notify(entry)
        })
      } else if (event.type === 'permission-request-resolved') {
        outstanding.delete(event.payload.requestId)
      }
    })
  }

  async function dispatch(request: RpcRequest): Promise<unknown> {
    const params = request.params as {
      definition?: AgentDefinition
      agentId?: string
      methodId?: string
      sessionId?: string
      cwd?: string
      mcpServers?: McpServer[]
      cursor?: string
      prompt?: ContentBlock[]
      modeId?: string
      configId?: string
      value?: SessionConfigValue
    }
    const {
      definition,
      agentId,
      methodId,
      sessionId,
      cwd,
      mcpServers,
      cursor,
      prompt,
      modeId,
      configId,
      value,
    } = params
    switch (request.method) {
      case ACP_RPC_METHODS.spawnAgent: {
        return host.spawnAgent(requireParam(definition, 'definition'))
      }
      case ACP_RPC_METHODS.authenticate: {
        await host.authenticate(
          requireParam(agentId, 'agentId'),
          requireParam(methodId, 'methodId'),
        )
        return null
      }
      case ACP_RPC_METHODS.logout: {
        await host.logout(requireParam(agentId, 'agentId'))
        return null
      }
      case ACP_RPC_METHODS.createSession: {
        const result = await host.createSession(
          requireParam(agentId, 'agentId'),
          {
            cwd: requireParam(cwd, 'cwd'),
            ...(mcpServers === undefined ? {} : { mcpServers }),
          },
        )
        if (result.status === 'active') watchSession(result.sessionId)
        return result
      }
      case ACP_RPC_METHODS.loadSession: {
        const id = requireParam(sessionId, 'sessionId')
        await host.loadSession(requireParam(agentId, 'agentId'), id, {
          ...(cwd === undefined ? {} : { cwd }),
          ...(mcpServers === undefined ? {} : { mcpServers }),
        })
        watchSession(id)
        return null
      }
      case ACP_RPC_METHODS.listSessions: {
        return host.listSessions(requireParam(agentId, 'agentId'), {
          ...(cursor === undefined ? {} : { cursor }),
          ...(cwd === undefined ? {} : { cwd }),
        })
      }
      case ACP_RPC_METHODS.resumeSession: {
        const id = requireParam(sessionId, 'sessionId')
        await host.resumeSession(id)
        watchSession(id)
        return null
      }
      case ACP_RPC_METHODS.deleteSession: {
        await host.deleteSession(requireParam(sessionId, 'sessionId'))
        return null
      }
      case ACP_RPC_METHODS.prompt: {
        return host.prompt(
          requireParam(sessionId, 'sessionId'),
          requireParam(prompt, 'prompt'),
        )
      }
      case ACP_RPC_METHODS.cancel: {
        await host.cancel(requireParam(sessionId, 'sessionId'))
        return null
      }
      case ACP_RPC_METHODS.closeSession: {
        await host.closeSession(requireParam(sessionId, 'sessionId'))
        return null
      }
      case ACP_RPC_METHODS.setMode: {
        await host.setMode(
          requireParam(sessionId, 'sessionId'),
          requireParam(modeId, 'modeId'),
        )
        return null
      }
      case ACP_RPC_METHODS.setConfigOption: {
        return host.setConfigOption(
          requireParam(sessionId, 'sessionId'),
          requireParam(configId, 'configId'),
          requireParam(value, 'value'),
        )
      }
      case ACP_RPC_METHODS.getAllSessions: {
        return host.getSessions()
      }
      case ACP_RPC_METHODS.restoreSessions: {
        return host.restoreSessions()
      }
      case ACP_RPC_METHODS.listAgents: {
        return host.getAgents()
      }
      default: {
        throw new AcpError(
          ACP_ERROR_CODES.configInvalid,
          `unknown method ${request.method}`,
        )
      }
    }
  }

  return {
    async request(request: RpcRequest): Promise<RpcResponse> {
      try {
        const result = await dispatch(request)
        return { id: request.id, ok: true, result }
      } catch (error) {
        return { id: request.id, ok: false, error: toErrorObject(error) }
      }
    },
    subscribe(params, onEvent) {
      return host.subscribe(params.sessionId, params.fromSeq, onEvent)
    },
    onInboundRequest(handler) {
      inboundHandlers.add(handler)
      for (const entry of outstanding.values()) notify(entry)
      return () => inboundHandlers.delete(handler)
    },
    async respondInbound(response) {
      host.respondPermission(
        response.id,
        response.result as RequestPermissionOutcome,
      )
    },
  }
}
