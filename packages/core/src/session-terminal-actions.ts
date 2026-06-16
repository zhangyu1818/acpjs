import { ACP_ERROR_CODES } from '@acpjs/protocol'

import { AcpError } from './errors.ts'
import { capabilityEnabled, type SessionHandle } from './internal.ts'
import {
  deletedSessionMeta,
  sameAgentOrUnknown,
  sessionMeta,
} from './session-config.ts'

import type { SessionManager } from './session-manager.ts'

function reportLifecycleCleanupFailure(
  manager: SessionManager,
  code: string,
  context: { agentId?: string; sessionId: string; error: unknown },
): void {
  manager.bus.diagnostic('warn', code, {
    message:
      context.error instanceof Error
        ? context.error.message
        : String(context.error),
    ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
    sessionId: context.sessionId,
  })
}

async function cancelPromptIfNeeded(
  manager: SessionManager,
  session: SessionHandle,
): Promise<void> {
  if (session.status !== 'prompting') return
  try {
    const { handle, conn } = manager.runtime.requireReady(session.agentId)
    await manager.runtime.track(
      handle,
      conn.cancel({ sessionId: session.sessionId }),
    )
  } catch (error) {
    reportLifecycleCleanupFailure(
      manager,
      'session/cancel-before-close-failed',
      {
        ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        sessionId: session.sessionId,
        error,
      },
    )
  }
}

function beginTerminalLifecycle(
  manager: SessionManager,
  session: SessionHandle,
  operation: 'close' | 'delete',
): number {
  if (
    session.lifecycleOperation === 'close' ||
    session.lifecycleOperation === 'delete'
  ) {
    throw new AcpError(
      ACP_ERROR_CODES.configInvalid,
      `session ${session.sessionId} lifecycle operation in progress`,
    )
  }
  if (session.lifecycleOperation !== undefined) {
    manager.invalidateLifecycle(session)
  }
  return manager.beginLifecycle(session, operation)
}

function restoredStatus(
  previousStatus: SessionHandle['status'],
): SessionHandle['status'] {
  return previousStatus === 'prompting' || previousStatus === 'resuming'
    ? 'active'
    : previousStatus
}

export async function closeManagedSession(
  manager: SessionManager,
  sessionId: string,
): Promise<void> {
  const session = manager.require(sessionId)
  const previousStatus = session.status
  const operationId = beginTerminalLifecycle(manager, session, 'close')
  try {
    await cancelPromptIfNeeded(manager, session)
    manager.router.supersedeForSession(sessionId)
    manager.cleanupSession(sessionId)
    await manager.bus.commitMeta(sessionMeta(session, 'closed'))
    if (!manager.isCurrentLifecycle(session, 'close', operationId)) {
      throw new AcpError(
        ACP_ERROR_CODES.sessionClosed,
        `session ${sessionId} is no longer active`,
      )
    }
    manager.markTombstone(sessionId, 'closed')
    manager.endLifecycle(session, operationId)
    manager.bus.setSessionStatus(session, 'closed')
  } catch (error) {
    manager.endLifecycle(session, operationId)
    if (session.status === 'prompting' || session.status === 'resuming') {
      manager.bus.setSessionStatus(session, restoredStatus(previousStatus))
    }
    throw error
  }
  try {
    const { handle, conn } = manager.runtime.requireReady(session.agentId)
    if (capabilityEnabled(handle.capabilities?.sessionCapabilities?.close)) {
      void manager.runtime
        .track(handle, conn.closeSession({ sessionId }))
        .catch((error: unknown) =>
          reportLifecycleCleanupFailure(manager, 'session/close-failed', {
            ...(session.agentId === undefined
              ? {}
              : { agentId: session.agentId }),
            sessionId,
            error,
          }),
        )
    }
  } catch (error) {
    reportLifecycleCleanupFailure(manager, 'session/close-skipped', {
      ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
      sessionId,
      error,
    })
  } finally {
    manager.endLifecycle(session, operationId)
  }
}

export async function deleteManagedSession(
  manager: SessionManager,
  agentId: string,
  sessionId: string,
): Promise<void> {
  const session =
    manager.sessions.get(sessionId) ?? manager.stagingSessions.get(sessionId)
  const publicSession = manager.sessions.get(sessionId)
  if (session && !sameAgentOrUnknown(session, agentId)) {
    throw new AcpError(
      ACP_ERROR_CODES.configInvalid,
      `session ${sessionId} belongs to another agent`,
    )
  }
  if (session) {
    const previousStatus = session.status
    const operationId = beginTerminalLifecycle(manager, session, 'delete')
    try {
      await cancelPromptIfNeeded(manager, session)
      manager.router.supersedeForSession(sessionId)
      manager.cleanupSession(sessionId)
      await manager.bus.commitMeta(sessionMeta(session, 'deleted'))
      const current =
        publicSession === undefined
          ? manager.isCurrentStagingLifecycle(session, 'delete', operationId)
          : manager.isCurrentLifecycle(session, 'delete', operationId)
      if (!current) {
        throw new AcpError(
          ACP_ERROR_CODES.sessionClosed,
          `session ${sessionId} is no longer active`,
        )
      }
      manager.markTombstone(sessionId, 'deleted')
      manager.endLifecycle(session, operationId)
      if (publicSession === undefined) {
        manager.stagingSessions.delete(sessionId)
      } else {
        manager.bus.setSessionStatus(session, 'deleted')
        manager.sessions.delete(sessionId)
      }
      manager.invalidateLifecycle(session)
    } catch (error) {
      manager.endLifecycle(session, operationId)
      if (
        publicSession !== undefined &&
        (session.status === 'prompting' || session.status === 'resuming')
      ) {
        manager.bus.setSessionStatus(session, restoredStatus(previousStatus))
      }
      throw error
    }
  } else {
    await manager.bus.commitMeta(deletedSessionMeta(sessionId))
    manager.markTombstone(sessionId, 'deleted')
  }
  try {
    const { handle, conn } = manager.runtime.requireReady(agentId)
    if (capabilityEnabled(handle.capabilities?.sessionCapabilities?.delete)) {
      void manager.runtime
        .track(handle, conn.deleteSession({ sessionId }))
        .catch((error: unknown) =>
          reportLifecycleCleanupFailure(manager, 'session/delete-failed', {
            agentId,
            sessionId,
            error,
          }),
        )
    }
  } catch (error) {
    reportLifecycleCleanupFailure(manager, 'session/delete-skipped', {
      agentId,
      sessionId,
      error,
    })
  }
}
