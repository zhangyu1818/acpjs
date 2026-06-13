import type {
  AcpHostEvent,
  AcpSessionEvent,
  ErrorObject,
  InboundRequest,
  InboundResponse,
  RpcRequest,
  Transport,
  TransportHandlers,
  TransportLifecycleEvent,
  TransportSubscribeParams,
} from '@acpjs/protocol'

type MethodHandler = (params: Record<string, unknown>) => unknown

type HostEventInput<T = AcpHostEvent> = T extends AcpHostEvent
  ? Omit<T, 'seq' | 'ts'>
  : never

export interface FakeConnection {
  transport: Transport
  lifecycle: TransportLifecycleEvent[]
}

export interface FakeHub {
  requests: RpcRequest[]
  subscriptions: TransportSubscribeParams[]
  inboundResponses: InboundResponse[]
  handle: (method: string, handler: MethodHandler) => void
  emit: (
    sessionId: string,
    type: AcpSessionEvent['type'],
    payload: unknown,
  ) => void
  emitRaw: (event: AcpSessionEvent) => void
  emitHost: (event: HostEventInput) => void
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
  const logs = new Map<string, AcpSessionEvent[]>()
  const liveSubscribers = new Map<
    string,
    Set<(event: AcpSessionEvent) => void>
  >()
  const hostLog: AcpHostEvent[] = []
  const hostSubscribers = new Set<(event: AcpHostEvent) => void>()
  const handlers = new Map<string, MethodHandler>()
  const connections = new Set<TransportHandlers>()
  const requests: RpcRequest[] = []
  const subscriptions: TransportSubscribeParams[] = []
  const inboundResponses: InboundResponse[] = []
  let respondInboundHandler: (response: InboundResponse) => void = noop

  function emit(
    sessionId: string,
    type: AcpSessionEvent['type'],
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
    } as AcpSessionEvent
    log.push(event)
    for (const deliver of liveSubscribers.get(sessionId) ?? []) deliver(event)
  }

  function connection(
    options: { failConnect?: ErrorObject } = {},
  ): FakeConnection {
    const lifecycle: TransportLifecycleEvent[] = []
    let status: TransportLifecycleEvent['status'] = 'connecting'
    let connectedHandlers: TransportHandlers | undefined
    const transport: Transport = {
      async connect(transportHandlers) {
        connectedHandlers = transportHandlers
        const report = (event: TransportLifecycleEvent) => {
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
          const deliverHost = (event: AcpHostEvent) => onEvent(event)
          hostSubscribers.add(deliverHost)
          return () => hostSubscribers.delete(deliverHost)
        }
        for (const event of logs.get(sessionId) ?? []) {
          if (event.seq > params.fromSeq) onEvent(event)
        }
        const live = liveSubscribers.get(sessionId) ?? new Set()
        liveSubscribers.set(sessionId, live)
        const deliver = (event: AcpSessionEvent) => onEvent(event)
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
          const event: TransportLifecycleEvent = { status: 'closed' }
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
      } as AcpHostEvent
      hostLog.push(hostEvent)
      for (const deliver of hostSubscribers) deliver(hostEvent)
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
