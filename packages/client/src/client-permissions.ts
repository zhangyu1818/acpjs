import {
  ACPJS_ERROR_CODES,
  type HostPermissionSnapshot,
  type RequestPermissionOutcome,
  type HostClientTransport,
} from '@acpjs/protocol'

import { toClientError } from './errors.ts'
import {
  createPermissionRegistry,
  type PermissionRegistry,
} from './permission-registry.ts'

import type { PermissionRequest } from './types.ts'

export interface ClientPermissionController {
  readonly registry: PermissionRegistry
  applyProjection: (payload: HostPermissionSnapshot) => void
  respond: (
    requestId: string,
    outcome: RequestPermissionOutcome,
  ) => Promise<void>
}

export function createClientPermissionController(options: {
  ensureOpen: () => void
  connected: Promise<void>
  respondInbound: HostClientTransport['respondInbound']
  registry?: PermissionRegistry
}): ClientPermissionController {
  const registry = options.registry ?? createPermissionRegistry()

  async function respond(
    requestId: string,
    outcome: RequestPermissionOutcome,
  ): Promise<void> {
    options.ensureOpen()
    try {
      await options.connected
      await options.respondInbound({ id: requestId, result: outcome })
    } catch (error) {
      const clientError = toClientError(error)
      if (clientError.code === ACPJS_ERROR_CODES.alreadyAnswered) {
        registry.prune(requestId)
      }
      throw clientError
    }
    registry.prune(requestId)
  }

  function add(
    payload: Pick<
      HostPermissionSnapshot,
      'requestId' | 'sessionId' | 'toolCall' | 'options'
    >,
  ): void {
    const permission: PermissionRequest = Object.freeze({
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      toolCall: payload.toolCall,
      options: payload.options,
      respond: (outcome: RequestPermissionOutcome) =>
        respond(payload.requestId, outcome),
    })
    registry.add(permission)
  }

  return {
    registry,
    applyProjection(payload) {
      if (payload.status === 'pending') {
        add(payload)
      } else {
        registry.prune(payload.requestId)
      }
    },
    respond,
  }
}
