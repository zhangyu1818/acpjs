import {
  createAcpClient,
  type AcpClient,
  type CreateOrLoadSessionParams,
} from '@acpjs/client'

import type {
  AcpjsHostEvent,
  AcpjsHostMethod,
  AcpjsSessionEvent,
  InboundRequest,
  InboundResponse,
  HostRequest,
  HostClientTransport,
  HostClientTransportHandlers,
} from '@acpjs/protocol'

type MethodHandler = (params: Record<string, unknown>) => unknown

type HostEventInput<T = AcpjsHostEvent> = T extends AcpjsHostEvent
  ? Omit<T, 'seq' | 'ts'>
  : never

export interface TestHarness {
  client: AcpClient
  requests: HostRequest[]
  inboundResponses: InboundResponse[]
  handle: (method: AcpjsHostMethod, handler: MethodHandler) => void
  emit: (
    sessionId: string,
    type: AcpjsSessionEvent['type'],
    payload: unknown,
  ) => void
  emitHost: (event: HostEventInput) => void
  close: () => void
  pushPermission: (payload: {
    requestId: string
    sessionId: string
    toolCall: Record<string, unknown>
    options: Record<string, unknown>[]
  }) => void
}

export function sessionParams(cwd = '/tmp'): CreateOrLoadSessionParams {
  return {
    cwd,
    mcpServers: [],
    additionalDirectories: [],
  }
}

export function createTestHarness(): TestHarness {
  const logs = new Map<string, AcpjsSessionEvent[]>()
  const liveSubscribers = new Map<
    string,
    Set<(event: AcpjsSessionEvent) => void>
  >()
  const hostLog: AcpjsHostEvent[] = []
  const hostSubscribers = new Set<(event: AcpjsHostEvent) => void>()
  const handlers = new Map<AcpjsHostMethod, MethodHandler>()
  const requests: HostRequest[] = []
  const inboundResponses: InboundResponse[] = []
  let transportHandlers: HostClientTransportHandlers | undefined

  handlers.set('agents/spawn', () => ({
    agentId: 'agent-1',
    status: 'ready',
    restartCount: 0,
  }))
  handlers.set('sessions/create', () => ({
    status: 'active',
    sessionId: 'sess-1',
  }))

  const transport: HostClientTransport = {
    async connect(connectHandlers) {
      transportHandlers = connectHandlers
      connectHandlers.onLifecycle({ status: 'connecting' })
      await Promise.resolve()
      connectHandlers.onLifecycle({ status: 'connected' })
    },
    async request(request) {
      requests.push(request)
      const handler = handlers.get(request.method)
      if (!handler) {
        return {
          id: request.id,
          ok: false,
          error: {
            code: 'acpjs/config-invalid',
            message: `unknown method ${request.method}`,
            retryable: false,
          },
        }
      }
      return {
        id: request.id,
        ok: true,
        result: (await handler(request.params)) ?? null,
      }
    },
    subscribe(params, onEvent) {
      const sessionId = params.sessionId
      if (sessionId === undefined) {
        for (const event of hostLog) {
          if (event.seq > params.fromSeq) onEvent(event)
        }
        const deliverHost = (event: AcpjsHostEvent): void => onEvent(event)
        hostSubscribers.add(deliverHost)
        return () => hostSubscribers.delete(deliverHost)
      }
      for (const event of logs.get(sessionId) ?? []) {
        if (event.seq > params.fromSeq) onEvent(event)
      }
      const live = liveSubscribers.get(sessionId) ?? new Set()
      liveSubscribers.set(sessionId, live)
      const deliver = (event: AcpjsSessionEvent): void => onEvent(event)
      live.add(deliver)
      return () => live.delete(deliver)
    },
    async respondInbound(response) {
      inboundResponses.push(response)
    },
    async close() {},
  }

  return {
    client: createAcpClient({ transport }),
    requests,
    inboundResponses,
    handle: (method, handler) => handlers.set(method, handler),
    emit(sessionId, type, payload) {
      const log = logs.get(sessionId) ?? []
      logs.set(sessionId, log)
      const event = {
        sessionId,
        seq: log.length + 1,
        ts: 0,
        type,
        payload,
      } as AcpjsSessionEvent
      log.push(event)
      for (const deliver of liveSubscribers.get(sessionId) ?? []) {
        deliver(event)
      }
    },
    emitHost(event) {
      const hostEvent = {
        ...event,
        seq: hostLog.length + 1,
        ts: 0,
      } as AcpjsHostEvent
      hostLog.push(hostEvent)
      for (const deliver of hostSubscribers) deliver(hostEvent)
    },
    close() {
      transportHandlers?.onLifecycle({ status: 'closed' })
    },
    pushPermission(payload) {
      const request: InboundRequest = {
        id: payload.requestId,
        kind: 'permission',
        payload,
      }
      transportHandlers?.onInboundRequest(request)
      const hostEvent = {
        type: 'permission-updated',
        payload: { ...payload, status: 'pending' },
        seq: hostLog.length + 1,
        ts: 0,
      } as AcpjsHostEvent
      hostLog.push(hostEvent)
      for (const deliver of hostSubscribers) deliver(hostEvent)
    },
  }
}
