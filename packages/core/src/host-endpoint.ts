import {
  ACPJS_ERROR_CODES,
  ACPJS_HOST_METHODS,
  type AgentDefinition,
  type EnvelopeEndpoint,
  type ErrorObject,
  type InboundRequest,
  type HostRequest,
  type HostResponse,
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
      ACPJS_ERROR_CODES.configInvalid,
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
      code: ACPJS_ERROR_CODES.agentError,
      message: info.message,
      data: info,
      retryable: false,
    }
  }
  return {
    code: ACPJS_ERROR_CODES.agentError,
    message: error instanceof Error ? error.message : 'unknown error',
    retryable: false,
  }
}

export function createHostEndpoint(host: AcpHost): EnvelopeEndpoint {
  const inboundHandlers = new Set<InboundHandler>()
  const outstanding = new Map<string, OutstandingPermission>()
  let unsubscribePermissions: (() => void) | undefined

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

  function watchPermissions(): void {
    if (unsubscribePermissions) return
    unsubscribePermissions = host.subscribe(undefined, 0, (event) => {
      if (event.type !== 'permission-updated') return
      if (event.payload.status === 'pending') {
        const entry: OutstandingPermission = {
          request: {
            id: event.payload.requestId,
            kind: 'permission',
            payload: event.payload,
          },
          notified: new Set(),
        }
        outstanding.set(event.payload.requestId, entry)
        queueMicrotask(() => {
          if (outstanding.get(event.payload.requestId) === entry) {
            notify(entry)
          }
        })
      } else {
        outstanding.delete(event.payload.requestId)
      }
    })
  }

  async function dispatch(request: HostRequest): Promise<unknown> {
    const params = request.params as {
      definition?: AgentDefinition
      agentId?: string
      sessionId?: string
      cwd?: string
      mcpServers?: McpServer[]
      additionalDirectories?: string[]
      cursor?: string
      prompt?: ContentBlock[]
      modeId?: string
      configId?: string
      value?: SessionConfigValue
    }
    const {
      definition,
      agentId,
      sessionId,
      cwd,
      mcpServers,
      additionalDirectories,
      cursor,
      prompt,
      modeId,
      configId,
      value,
    } = params
    switch (request.method) {
      case ACPJS_HOST_METHODS.spawnAgent: {
        return host.spawnAgent(requireParam(definition, 'definition'))
      }
      case ACPJS_HOST_METHODS.createSession: {
        const result = await host.createSession(
          requireParam(agentId, 'agentId'),
          {
            cwd: requireParam(cwd, 'cwd'),
            mcpServers: requireParam(mcpServers, 'mcpServers'),
            additionalDirectories: requireParam(
              additionalDirectories,
              'additionalDirectories',
            ),
          },
        )
        return result
      }
      case ACPJS_HOST_METHODS.loadSession: {
        const id = requireParam(sessionId, 'sessionId')
        await host.loadSession(requireParam(agentId, 'agentId'), id, {
          cwd: requireParam(cwd, 'cwd'),
          mcpServers: requireParam(mcpServers, 'mcpServers'),
          additionalDirectories: requireParam(
            additionalDirectories,
            'additionalDirectories',
          ),
        })
        return null
      }
      case ACPJS_HOST_METHODS.listSessions: {
        return host.listSessions(requireParam(agentId, 'agentId'), {
          ...(cursor === undefined ? {} : { cursor }),
          ...(cwd === undefined ? {} : { cwd }),
        })
      }
      case ACPJS_HOST_METHODS.resumeSession: {
        const id = requireParam(sessionId, 'sessionId')
        await host.resumeSession(requireParam(agentId, 'agentId'), id, {
          cwd: requireParam(cwd, 'cwd'),
          ...(mcpServers === undefined ? {} : { mcpServers }),
          additionalDirectories: requireParam(
            additionalDirectories,
            'additionalDirectories',
          ),
        })
        return null
      }
      case ACPJS_HOST_METHODS.deleteSession: {
        await host.deleteSession(
          requireParam(agentId, 'agentId'),
          requireParam(sessionId, 'sessionId'),
        )
        return null
      }
      case ACPJS_HOST_METHODS.prompt: {
        return host.prompt(
          requireParam(sessionId, 'sessionId'),
          requireParam(prompt, 'prompt'),
        )
      }
      case ACPJS_HOST_METHODS.cancel: {
        await host.cancel(requireParam(sessionId, 'sessionId'))
        return null
      }
      case ACPJS_HOST_METHODS.closeSession: {
        await host.closeSession(requireParam(sessionId, 'sessionId'))
        return null
      }
      case ACPJS_HOST_METHODS.setMode: {
        await host.setMode(
          requireParam(sessionId, 'sessionId'),
          requireParam(modeId, 'modeId'),
        )
        return null
      }
      case ACPJS_HOST_METHODS.setConfigOption: {
        return host.setConfigOption(
          requireParam(sessionId, 'sessionId'),
          requireParam(configId, 'configId'),
          requireParam(value, 'value'),
        )
      }
      case ACPJS_HOST_METHODS.getAllSessions: {
        return host.getSessions()
      }
      case ACPJS_HOST_METHODS.restoreSessions: {
        return host.restoreSessions()
      }
      case ACPJS_HOST_METHODS.listAgents: {
        return host.getAgents()
      }
      case ACPJS_HOST_METHODS.disposeAgent: {
        await host.disposeAgent(requireParam(agentId, 'agentId'))
        return null
      }
      default: {
        throw new AcpError(
          ACPJS_ERROR_CODES.configInvalid,
          `unknown method ${request.method}`,
        )
      }
    }
  }

  return {
    async request(request: HostRequest): Promise<HostResponse> {
      try {
        const result = await dispatch(request)
        return { id: request.id, ok: true, result }
      } catch (error) {
        return { id: request.id, ok: false, error: toErrorObject(error) }
      }
    },
    subscribe(params, onEvent) {
      if (params.sessionId !== undefined) {
        return host.subscribe(params.sessionId, params.fromSeq, onEvent)
      }
      return host.subscribe(undefined, params.fromSeq, onEvent)
    },
    onInboundRequest(handler) {
      watchPermissions()
      inboundHandlers.add(handler)
      for (const entry of outstanding.values()) notify(entry)
      return () => {
        inboundHandlers.delete(handler)
        for (const entry of outstanding.values()) {
          entry.notified.delete(handler)
        }
        if (inboundHandlers.size === 0) {
          unsubscribePermissions?.()
          unsubscribePermissions = undefined
          outstanding.clear()
        }
      }
    },
    async respondInbound(response) {
      host.respondPermission(
        response.id,
        response.result as RequestPermissionOutcome,
      )
    },
  }
}
