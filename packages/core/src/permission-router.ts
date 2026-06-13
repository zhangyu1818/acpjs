import { ACP_ERROR_CODES } from '@acpjs/protocol'

import { AcpError } from './errors.ts'
import {
  pickOption,
  type PendingPermission,
  type SessionHandle,
} from './internal.ts'

import type {
  RequestPermissionOutcome,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk'

import type { EventBus } from './event-bus.ts'
import type { PermissionPolicyAction, PermissionPolicyRule } from './options.ts'

export class PermissionRouter {
  #bus: EventBus
  #policy: readonly PermissionPolicyRule[]
  #pending = new Map<string, PendingPermission>()
  #counter = 0

  constructor(bus: EventBus, policy: readonly PermissionPolicyRule[]) {
    this.#bus = bus
    this.#policy = policy
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
    const action = this.#match(params.toolCall.kind ?? undefined)
    if (action === 'allow' || action === 'reject') {
      const option = pickOption(params.options, action)
      if (option) {
        const outcome: RequestPermissionOutcome = {
          outcome: 'selected',
          optionId: option.optionId,
        }
        this.#bus.emitSession(session, 'permission-request-resolved', {
          requestId,
          status: 'answered',
          outcome,
        })
        return { outcome }
      }
    }
    return new Promise((resolvePromise) => {
      const pending: PendingPermission = {
        requestId,
        sessionId: session.sessionId,
        ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        settle: (status, outcome) => {
          this.#pending.delete(requestId)
          this.#bus.emitSession(session, 'permission-request-resolved', {
            requestId,
            status,
            ...(outcome ? { outcome } : {}),
          })
          resolvePromise({ outcome: outcome ?? { outcome: 'cancelled' } })
        },
      }
      this.#pending.set(requestId, pending)
    })
  }

  respond(requestId: string, outcome: RequestPermissionOutcome): void {
    const pending = this.#pending.get(requestId)
    if (!pending) {
      throw new AcpError(
        ACP_ERROR_CODES.alreadyAnswered,
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

  #match(kind: string | undefined): PermissionPolicyAction {
    for (const rule of this.#policy) {
      if (rule.kind === undefined || rule.kind === kind) return rule.action
    }
    return 'ask'
  }
}
