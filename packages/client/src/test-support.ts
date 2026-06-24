import type {
  AcpjsHostEvent,
  AcpjsHostMethod,
  AcpjsSessionEvent,
  CreateOrLoadSessionParams,
  ErrorObject,
  InboundRequest,
  InboundResponse,
  ResumeSessionParams,
  HostRequest,
  HostClientTransport,
  HostClientTransportHandlers,
  HostClientTransportLifecycleEvent,
  HostClientTransportSubscribeParams,
} from '@acpjs/protocol'

type MethodHandler = (params: Record<string, unknown>) => unknown

type HostEventInput<T = AcpjsHostEvent> = T extends AcpjsHostEvent
  ? Omit<T, 'seq' | 'ts'>
  : never

export function sessionParams(
  cwd = '/tmp',
  overrides: Partial<CreateOrLoadSessionParams> = {},
): CreateOrLoadSessionParams {
  return {
    cwd,
    mcpServers: [],
    additionalDirectories: [],
    ...overrides,
  }
}

export function resumeParams(
  cwd = '/tmp',
  overrides: Partial<ResumeSessionParams> = {},
): ResumeSessionParams {
  return {
    cwd,
    additionalDirectories: [],
    ...overrides,
  }
}

export interface FakeConnection {
  transport: HostClientTransport
  lifecycle: HostClientTransportLifecycleEvent[]
}

export interface FakeHub {
  requests: HostRequest[]
  subscriptions: HostClientTransportSubscribeParams[]
  inboundResponses: InboundResponse[]
  handle: (method: AcpjsHostMethod, handler: MethodHandler) => void
  emit: (
    sessionId: string,
    type: AcpjsSessionEvent['type'],
    payload: unknown,
  ) => void
  emitRaw: (event: AcpjsSessionEvent) => void
  emitHost: (event: HostEventInput) => void
  failSubscription: (
    params: HostClientTransportSubscribeParams,
    error: ErrorObject,
  ) => void
  pushInbound: (request: InboundRequest) => void
  pushPermission: (payload: {
    requestId: string
    sessionId: string
    toolCall: Record<string, unknown>
    options: Record<string, unknown>[]
  }) => void
  onRespondInbound: (handler: (response: InboundResponse) => void) => void
  connection: (options?: { failConnect?: ErrorObject }) => FakeConnection
}

export function errorObject(
  code: ErrorObject['code'],
  message: string = code,
  retryable = false,
): ErrorObject {
  return { code, message, retryable }
}

export class ScriptedError extends Error {
  error: ErrorObject
  code: ErrorObject['code']
  data: unknown
  retryable: boolean

  constructor(error: ErrorObject) {
    super(error.message)
    this.error = error
    this.code = error.code
    this.data = error.data
    this.retryable = error.retryable
  }
}

function noop(): void {}

export function createFakeHub(): FakeHub {
  const logs = new Map<string, AcpjsSessionEvent[]>()
  const liveSubscribers = new Map<
    string,
    Set<(event: AcpjsSessionEvent) => void>
  >()
  const hostLog: AcpjsHostEvent[] = []
  const hostSubscribers = new Set<(event: AcpjsHostEvent) => void>()
  const handlers = new Map<AcpjsHostMethod, MethodHandler>()
  const connections = new Set<HostClientTransportHandlers>()
  const requests: HostRequest[] = []
  const subscriptions: HostClientTransportSubscribeParams[] = []
  const inboundResponses: InboundResponse[] = []
  let respondInboundHandler: (response: InboundResponse) => void = noop

  function emit(
    sessionId: string,
    type: AcpjsSessionEvent['type'],
    payload: unknown,
  ): void {
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
    for (const deliver of liveSubscribers.get(sessionId) ?? []) deliver(event)
  }

  function connection(
    options: { failConnect?: ErrorObject } = {},
  ): FakeConnection {
    const lifecycle: HostClientTransportLifecycleEvent[] = []
    let status: HostClientTransportLifecycleEvent['status'] = 'connecting'
    let connectedHandlers: HostClientTransportHandlers | undefined
    const transport: HostClientTransport = {
      async connect(transportHandlers) {
        connectedHandlers = transportHandlers
        const report = (event: HostClientTransportLifecycleEvent) => {
          lifecycle.push(event)
          transportHandlers.onLifecycle(event)
        }
        report({ status: 'connecting' })
        if (options.failConnect) {
          status = 'closed'
          report({ status: 'closed', error: options.failConnect })
          throw new ScriptedError(options.failConnect)
        }
        status = 'connected'
        connections.add(transportHandlers)
        report({ status: 'connected' })
      },
      async request(request) {
        requests.push(request)
        const handler = handlers.get(request.method)
        if (!handler) {
          return {
            id: request.id,
            ok: false,
            error: errorObject(
              'acpjs/config-invalid',
              `unknown method ${request.method}`,
            ),
          }
        }
        try {
          const result = (await handler(request.params)) ?? null
          return { id: request.id, ok: true, result }
        } catch (error) {
          if (error instanceof ScriptedError) {
            return { id: request.id, ok: false, error: error.error }
          }
          throw error
        }
      },
      subscribe(params, onEvent) {
        subscriptions.push(params)
        const sessionId = params.sessionId
        if (sessionId === undefined) {
          for (const event of hostLog) {
            if (event.seq > params.fromSeq) onEvent(event)
          }
          const deliverHost = (event: AcpjsHostEvent) => onEvent(event)
          hostSubscribers.add(deliverHost)
          return () => hostSubscribers.delete(deliverHost)
        }
        for (const event of logs.get(sessionId) ?? []) {
          if (event.seq > params.fromSeq) onEvent(event)
        }
        const live = liveSubscribers.get(sessionId) ?? new Set()
        liveSubscribers.set(sessionId, live)
        const deliver = (event: AcpjsSessionEvent) => onEvent(event)
        live.add(deliver)
        return () => live.delete(deliver)
      },
      async respondInbound(response) {
        inboundResponses.push(response)
        respondInboundHandler(response)
      },
      async close() {
        if (status === 'closed') return
        status = 'closed'
        if (connectedHandlers) {
          connections.delete(connectedHandlers)
          const event: HostClientTransportLifecycleEvent = { status: 'closed' }
          lifecycle.push(event)
          connectedHandlers.onLifecycle(event)
        }
      },
    }
    return { transport, lifecycle }
  }

  return {
    requests,
    subscriptions,
    inboundResponses,
    handle: (method, handler) => handlers.set(method, handler),
    emit,
    emitRaw(event) {
      for (const deliver of liveSubscribers.get(event.sessionId) ?? []) {
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
    failSubscription(params, error) {
      for (const target of connections) {
        target.onSubscriptionError?.(params, error)
      }
    },
    pushInbound(request) {
      for (const target of connections) target.onInboundRequest(request)
    },
    pushPermission(payload) {
      const request: InboundRequest = {
        id: payload.requestId,
        kind: 'permission',
        payload,
      }
      for (const target of connections) target.onInboundRequest(request)
      const hostEvent = {
        type: 'permission-updated',
        payload: { ...payload, status: 'pending' },
      } as HostEventInput
      const event = {
        ...hostEvent,
        seq: hostLog.length + 1,
        ts: 0,
      } as AcpjsHostEvent
      hostLog.push(event)
      for (const deliver of hostSubscribers) deliver(event)
    },
    onRespondInbound(handler) {
      respondInboundHandler = handler
    },
    connection,
  }
}

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}
