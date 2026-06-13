import {
  isStructuredCloneable,
  type AgentHandle,
  type EventSubscriber,
  type SessionHandle,
} from './internal.ts'

import type {
  AcpEvent,
  AcpEventExtensions,
  AcpHostEvent,
  AcpSessionEvent,
  AgentExitReason,
  AgentStatus,
  DiagnosticLevel,
  SessionAnnouncePayload,
  SessionStatus,
} from '@acpjs/protocol'
import type { AuthMethod } from '@agentclientprotocol/sdk'

import type { SessionMeta, StorageAdapter } from './storage.ts'

export interface ConfigInitSource {
  modes?: unknown
  configOptions?: unknown
}

function isSubscriberErrorDiagnostic(event: AcpEvent): boolean {
  return (
    event.type === 'diagnostic' && event.payload.code === 'subscriber/error'
  )
}

type HostEventInput<T = AcpHostEvent> = T extends AcpHostEvent
  ? Omit<T, 'seq' | 'ts'>
  : never

const hostBuses = new WeakMap<object, EventBus>()

export function registerHostBus(host: object, bus: EventBus): void {
  hostBuses.set(host, bus)
}

export function hostBus(host: object): EventBus | undefined {
  return hostBuses.get(host)
}

export class EventBus {
  #storage: StorageAdapter
  #hostLog: AcpHostEvent[] = []
  #hostNextSeq = 1
  #hostSubscribers = new Set<EventSubscriber>()

  constructor(storage: StorageAdapter) {
    this.#storage = storage
  }

  emitHost(partial: HostEventInput, silent: boolean): void {
    const event = {
      ...partial,
      seq: this.#hostNextSeq,
      ts: Date.now(),
    } as AcpHostEvent
    if (!isStructuredCloneable(event)) {
      if (
        event.type === 'diagnostic' &&
        event.payload.code === 'event/unserializable'
      ) {
        return
      }
      const agentId = 'agentId' in event ? event.agentId : undefined
      this.diagnostic('error', 'event/unserializable', {
        message: `rejected unserializable ${event.type} event`,
        ...(agentId === undefined ? {} : { agentId }),
      })
      return
    }
    this.#hostNextSeq += 1
    this.#hostLog.push(event)
    this.#queueStorage(event)
    const subscribers = Array.from(this.#hostSubscribers)
    for (const subscriber of subscribers) {
      this.#notify(subscriber, event, !silent)
    }
  }

  emitSession(
    session: SessionHandle,
    type: AcpSessionEvent['type'],
    payload: unknown,
    extensions?: AcpEventExtensions,
  ): void {
    const event = {
      sessionId: session.sessionId,
      seq: session.nextSeq,
      ts: Date.now(),
      type,
      payload,
      ...(extensions ? { extensions } : {}),
    } as AcpSessionEvent
    if (!isStructuredCloneable(event)) {
      this.diagnostic('error', 'event/unserializable', {
        message: `rejected unserializable ${type} event`,
        sessionId: session.sessionId,
      })
      return
    }
    session.nextSeq += 1
    session.log.push(event)
    this.#queueStorage(event)
    const subscribers = Array.from(session.subscribers)
    for (const subscriber of subscribers) {
      this.#notify(subscriber, event, true)
    }
  }

  emitSessionLifecycle(
    type: 'session-created' | 'session-closed',
    payload: SessionAnnouncePayload,
  ): void {
    this.emitHost({ type, payload }, false)
  }

  diagnostic(
    level: DiagnosticLevel,
    code: string,
    context: {
      message: string
      agentId?: string
      sessionId?: string
      data?: unknown
    },
  ): void {
    this.emitHost(
      {
        ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
        type: 'diagnostic',
        payload: {
          level,
          code,
          message: context.message,
          ...(context.sessionId === undefined
            ? {}
            : { sessionId: context.sessionId }),
          ...(context.data === undefined ? {} : { data: context.data }),
        },
      },
      code === 'subscriber/error',
    )
  }

  subscribeHost(fromSeq: number, callback: EventSubscriber): () => void {
    for (let index = 0; index < this.#hostLog.length; index += 1) {
      const event = this.#hostLog[index]
      if (event !== undefined && event.seq > fromSeq) {
        this.#notify(callback, event, !isSubscriberErrorDiagnostic(event))
      }
    }
    this.#hostSubscribers.add(callback)
    return () => {
      this.#hostSubscribers.delete(callback)
    }
  }

  subscribeSession(
    session: SessionHandle,
    fromSeq: number,
    callback: EventSubscriber,
  ): () => void {
    for (const event of session.log) {
      if (event.seq > fromSeq) this.#notify(callback, event, true)
    }
    session.subscribers.add(callback)
    return () => {
      session.subscribers.delete(callback)
    }
  }

  setSessionStatus(
    session: SessionHandle,
    status: SessionStatus,
    extras: { resumed?: boolean; authMethods?: AuthMethod[] } = {},
  ): void {
    session.status = status
    this.emitSession(session, 'session-status-change', {
      status,
      ...(extras.resumed === undefined ? {} : { resumed: extras.resumed }),
      ...(extras.authMethods === undefined
        ? {}
        : { authMethods: extras.authMethods }),
    })
  }

  emitAuthRequired(agentId: string, authMethods: AuthMethod[]): void {
    this.emitHost(
      {
        agentId,
        type: 'auth-required',
        payload: { agentId, authMethods },
      },
      false,
    )
  }

  setAgentStatus(
    handle: AgentHandle,
    status: AgentStatus,
    reason?: AgentExitReason,
  ): void {
    handle.status = status
    if (reason) handle.reason = reason
    this.emitHost(
      {
        agentId: handle.agentId,
        type: 'agent-status-change',
        payload: {
          status,
          restartCount: handle.restartCount,
          ...(status === 'exited' && handle.reason
            ? { reason: handle.reason }
            : {}),
          ...(status === 'exited' && handle.exit ? { exit: handle.exit } : {}),
        },
      },
      false,
    )
  }

  emitConfigInit(
    session: SessionHandle,
    response: ConfigInitSource,
    always: boolean,
  ): void {
    const payload = {
      ...(response.modes == null ? {} : { modes: response.modes }),
      ...(response.configOptions == null
        ? {}
        : { configOptions: response.configOptions }),
    }
    if (always || Object.keys(payload).length !== 0) {
      this.emitSession(session, 'session-config-init', payload)
    }
  }

  appendMeta(meta: SessionMeta): void {
    this.#runStorageWrite(() => this.#storage.appendMeta(meta))
  }

  #queueStorage(event: AcpEvent): void {
    if (
      event.type === 'diagnostic' &&
      event.payload.code === 'storage/write-failed'
    ) {
      return
    }
    this.#runStorageWrite(() => this.#storage.appendEvent(event))
  }

  #runStorageWrite(write: () => void | Promise<void>): void {
    const report = (error: unknown) => {
      this.diagnostic('error', 'storage/write-failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      const result = write()
      if (result && typeof result.then === 'function') {
        result.then(undefined, report)
      }
    } catch (error) {
      report(error)
    }
  }

  #notify(
    callback: EventSubscriber,
    event: AcpEvent,
    reportErrors: boolean,
  ): void {
    try {
      callback(event)
    } catch (error) {
      if (reportErrors) {
        this.diagnostic('error', 'subscriber/error', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
