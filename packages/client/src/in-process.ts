import {
  ACPJS_ERROR_CODES,
  type EnvelopeEndpoint,
  type HostClientTransport,
  type HostClientTransportConnectionStatus,
  type HostClientTransportHandlers,
} from '@acpjs/protocol'

import { AcpClientError, transportClosedError } from './errors.ts'

export function createInProcessTransport(
  endpoint: EnvelopeEndpoint,
): HostClientTransport {
  let status: HostClientTransportConnectionStatus = 'connecting'
  let handlers: HostClientTransportHandlers | undefined
  const unsubscribers = new Set<() => void>()
  let detachInbound: (() => void) | undefined

  return {
    async connect(next: HostClientTransportHandlers): Promise<void> {
      if (status === 'closed') {
        throw new AcpClientError(transportClosedError())
      }
      if (handlers) {
        throw new AcpClientError({
          code: ACPJS_ERROR_CODES.configInvalid,
          message: 'transport already connected',
          retryable: false,
        })
      }
      handlers = next
      next.onLifecycle({ status: 'connecting' })
      detachInbound = endpoint.onInboundRequest((request) => {
        next.onInboundRequest(request)
      })
      status = 'connected'
      next.onLifecycle({ status: 'connected' })
    },
    async request(request) {
      if (status !== 'connected') {
        return { id: request.id, ok: false, error: transportClosedError() }
      }
      return endpoint.request(request)
    },
    subscribe(params, onEvent) {
      if (status !== 'connected') {
        throw new AcpClientError(transportClosedError())
      }
      const unsubscribe = endpoint.subscribe(params, onEvent)
      unsubscribers.add(unsubscribe)
      return () => {
        unsubscribers.delete(unsubscribe)
        unsubscribe()
      }
    },
    async respondInbound(response) {
      if (status !== 'connected') {
        throw new AcpClientError(transportClosedError())
      }
      await endpoint.respondInbound(response)
    },
    async close() {
      if (status === 'closed') return
      status = 'closed'
      detachInbound?.()
      for (const unsubscribe of unsubscribers) unsubscribe()
      unsubscribers.clear()
      handlers?.onLifecycle({ status: 'closed' })
    },
  }
}
