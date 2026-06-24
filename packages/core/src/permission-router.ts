import { ACPJS_ERROR_CODES } from '@acpjs/protocol'

import { AcpError } from './errors.ts'

import type {
  RequestPermissionOutcome,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk'

import type { EventBus } from './event-bus.ts'
import type { PendingPermission, SessionHandle } from './internal.ts'

export class PermissionRouter {
  #bus: EventBus
  #pending = new Map<string, PendingPermission>()
  #counter = 0

  constructor(bus: EventBus) {
    this.#bus = bus
  }

  async handle(
    session: SessionHandle,
    params: RequestPermissionRequest,
  ): Promise<{ outcome: RequestPermissionOutcome }> {
    this.#counter += 1
    const requestId = `perm-${this.#counter}`
    this.#bus.emitSession(session, 'permission-request-created', {
      requestId,
      toolCall: params.toolCall,
      options: params.options,
    })
    return new Promise((resolvePromise) => {
      const pending: PendingPermission = {
        requestId,
        sessionId: session.sessionId,
        ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        toolCall: params.toolCall,
        options: params.options,
        settle: (status, outcome) => {
          this.#pending.delete(requestId)
          this.#bus.emitSession(session, 'permission-request-resolved', {
            requestId,
            status,
            ...(outcome ? { outcome } : {}),
          })
          this.#bus.emitPermissionUpdated({
            requestId,
            sessionId: session.sessionId,
            ...(session.agentId === undefined
              ? {}
              : { agentId: session.agentId }),
            status,
            toolCall: params.toolCall,
            options: params.options,
            ...(outcome ? { outcome } : {}),
          })
          resolvePromise({ outcome: outcome ?? { outcome: 'cancelled' } })
        },
      }
      this.#pending.set(requestId, pending)
      this.#bus.emitPermissionUpdated({
        requestId,
        sessionId: session.sessionId,
        ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        status: 'pending',
        toolCall: params.toolCall,
        options: params.options,
      })
    })
  }

  respond(requestId: string, outcome: RequestPermissionOutcome): void {
    const pending = this.#pending.get(requestId)
    if (!pending) {
      throw new AcpError(
        ACPJS_ERROR_CODES.alreadyAnswered,
        `permission request ${requestId} already answered`,
      )
    }
    pending.settle('answered', outcome)
  }

  supersedeForSession(sessionId: string): void {
    this.#supersede((pending) => pending.sessionId === sessionId)
  }

  supersedeForAgent(agentId: string): void {
    this.#supersede((pending) => pending.agentId === agentId)
  }

  #supersede(predicate: (pending: PendingPermission) => boolean): void {
    const matches = Array.from(this.#pending.values()).filter(predicate)
    for (const pending of matches) pending.settle('superseded')
  }
}
