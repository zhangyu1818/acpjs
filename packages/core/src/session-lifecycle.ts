import {
  ACPJS_ERROR_CODES,
  type CreateOrLoadSessionParams,
  type CreateSessionResult,
  type ResumeSessionParams,
} from '@acpjs/protocol'
import { methods, type McpServer } from '@agentclientprotocol/sdk'

import { AcpError } from './errors.ts'
import { capabilityEnabled } from './internal.ts'
import {
  additionalDirectoryParams,
  applyConfigCapabilities,
  normalizeCreateOrLoadSessionParams,
  normalizeResumeSessionParams,
  requireCapability,
  sameAgentOrUnknown,
  sessionMeta,
} from './session-config.ts'
import {
  applyCommittedDraft,
  applyLoadDraftReplay,
  createLoadDraft,
} from './session-load-draft.ts'
import { sessionSnapshot } from './snapshots.ts'

import type { SessionManager } from './session-manager.ts'

function mcpServersParam(mcpServers: McpServer[] | undefined): {
  mcpServers?: McpServer[]
} {
  return mcpServers === undefined ? {} : { mcpServers }
}

function requireOpenOrMissing(sessionId: string, status?: string): void {
  if (status === 'closed' || status === 'deleted') {
    throw new AcpError(
      ACPJS_ERROR_CODES.sessionClosed,
      `session ${sessionId} is closed or deleted`,
    )
  }
}

function requireLifecycleStart(
  sessionId: string,
  status: string | undefined,
): void {
  requireOpenOrMissing(sessionId, status)
  if (status === 'prompting') {
    throw new AcpError(
      ACPJS_ERROR_CODES.promptInFlight,
      `session ${sessionId} has a prompt in flight`,
    )
  }
  if (status === 'resuming') {
    throw new AcpError(
      ACPJS_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
}

export async function createManagedSession(
  manager: SessionManager,
  agentId: string,
  rawParams: CreateOrLoadSessionParams,
): Promise<CreateSessionResult> {
  const params = normalizeCreateOrLoadSessionParams(rawParams)
  const { handle, conn } = manager.runtime.requireReady(agentId)
  const extra = additionalDirectoryParams(handle, params.additionalDirectories)
  const response = await manager.runtime.track(
    handle,
    conn.agent.request(methods.agent.session.new, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      ...extra,
    }),
  )
  const session = manager.createHandle(
    agentId,
    handle,
    response.sessionId,
    params,
    'creating',
  )
  manager.addSession(session)
  applyConfigCapabilities(session, response)
  manager.bus.emitConfigInit(session, response, true)
  manager.bus.setSessionStatus(session, 'active')
  await manager.bus.appendMeta(sessionMeta(session))
  return sessionSnapshot(session)
}

export async function loadManagedSession(
  manager: SessionManager,
  agentId: string,
  sessionId: string,
  rawParams: CreateOrLoadSessionParams,
): Promise<void> {
  const params = normalizeCreateOrLoadSessionParams(rawParams)
  manager.assertNotDeleted(sessionId)
  const { handle, conn } = manager.runtime.requireReady(agentId)
  requireCapability(handle.capabilities?.loadSession === true, 'session/load')
  manager.reopenClosedSession(sessionId)
  const extra = additionalDirectoryParams(handle, params.additionalDirectories)
  let session = manager.sessions.get(sessionId)
  const isNewSession = session === undefined
  requireLifecycleStart(sessionId, session?.status)
  if (
    session !== undefined &&
    !sameAgentOrUnknown(session, agentId, handle.definition.id)
  ) {
    throw new AcpError(
      ACPJS_ERROR_CODES.configInvalid,
      `session ${sessionId} belongs to another agent`,
    )
  }
  if (session === undefined) {
    session = manager.createHandle(
      agentId,
      handle,
      sessionId,
      params,
      'resuming',
    )
    manager.addStagingSession(session)
  }
  const operationId = manager.beginLifecycle(session, 'load')
  session.loadReplay = []
  const previousStatus = session.status
  if (!isNewSession) manager.bus.setSessionStatus(session, 'resuming')
  try {
    const response = await manager.runtime.track(
      handle,
      conn.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        ...extra,
      }),
    )
    const replay = session.loadReplay ?? []
    if (isNewSession) {
      if (!manager.isCurrentStagingLifecycle(session, 'load', operationId)) {
        throw new AcpError(
          ACPJS_ERROR_CODES.sessionClosed,
          `session ${sessionId} is no longer pending`,
        )
      }
    } else if (!manager.isCurrentLifecycle(session, 'load', operationId)) {
      throw new AcpError(
        ACPJS_ERROR_CODES.sessionClosed,
        `session ${sessionId} is no longer active`,
      )
    }
    const draft = createLoadDraft(session, agentId, handle, params)
    applyConfigCapabilities(draft, response)
    applyLoadDraftReplay(manager, draft, replay, response)
    await manager.bus.replaceSession(draft, sessionMeta(draft))
    if (isNewSession) {
      if (!manager.isCurrentStagingLifecycle(session, 'load', operationId)) {
        throw new AcpError(
          ACPJS_ERROR_CODES.sessionClosed,
          `session ${sessionId} is no longer pending`,
        )
      }
      manager.commitStagingSession(session)
    } else if (!manager.isCurrentLifecycle(session, 'load', operationId)) {
      throw new AcpError(
        ACPJS_ERROR_CODES.sessionClosed,
        `session ${sessionId} is no longer active`,
      )
    }
    manager.endLifecycle(session, operationId)
    applyCommittedDraft(manager, session, draft)
  } catch (error) {
    manager.bus.diagnostic('warn', 'session/load-failed', {
      message: error instanceof Error ? error.message : String(error),
      agentId,
      sessionId,
    })
    if (isNewSession) {
      manager.stagingSessions.delete(sessionId)
    } else if (manager.isCurrentLifecycle(session, 'load', operationId)) {
      manager.endLifecycle(session, operationId)
      if (session.status === 'resuming') {
        manager.bus.setSessionStatus(session, previousStatus)
      }
    }
    throw error
  } finally {
    manager.endLifecycle(session, operationId)
    delete session.loadReplay
  }
}

export async function resumeManagedSession(
  manager: SessionManager,
  agentId: string,
  sessionId: string,
  rawParams: ResumeSessionParams,
): Promise<void> {
  const params = normalizeResumeSessionParams(rawParams)
  manager.assertNotTombstoned(sessionId)
  const { handle, conn } = manager.runtime.requireReady(agentId)
  requireCapability(
    capabilityEnabled(handle.capabilities?.sessionCapabilities?.resume),
    'session/resume',
  )
  const extra = additionalDirectoryParams(handle, params.additionalDirectories)
  let session = manager.sessions.get(sessionId)
  const isNewSession = session === undefined
  requireLifecycleStart(sessionId, session?.status)
  if (
    session !== undefined &&
    !sameAgentOrUnknown(session, agentId, handle.definition.id)
  ) {
    throw new AcpError(
      ACPJS_ERROR_CODES.configInvalid,
      `session ${sessionId} belongs to another agent`,
    )
  }
  if (session === undefined) {
    session = manager.createHandle(
      agentId,
      handle,
      sessionId,
      params,
      'resuming',
    )
    manager.addStagingSession(session)
  }
  const operationId = manager.beginLifecycle(session, 'resume')
  const previousStatus = session.status
  if (!isNewSession) manager.bus.setSessionStatus(session, 'resuming')
  try {
    const response = await manager.runtime.track(
      handle,
      conn.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd: params.cwd,
        ...mcpServersParam(params.mcpServers),
        ...extra,
      }),
    )
    if (isNewSession) {
      if (!manager.isCurrentStagingLifecycle(session, 'resume', operationId)) {
        throw new AcpError(
          ACPJS_ERROR_CODES.sessionClosed,
          `session ${sessionId} is no longer pending`,
        )
      }
      manager.commitStagingSession(session)
    } else if (!manager.isCurrentLifecycle(session, 'resume', operationId)) {
      throw new AcpError(
        ACPJS_ERROR_CODES.sessionClosed,
        `session ${sessionId} is no longer active`,
      )
    }
    manager.applyEffectiveConfig(session, agentId, handle, params)
    applyConfigCapabilities(session, response)
    manager.bus.emitConfigInit(session, response, false)
    manager.bus.setSessionStatus(session, 'active', { resumed: true })
    manager.endLifecycle(session, operationId)
    await manager.bus.appendMeta(sessionMeta(session))
  } catch (error) {
    manager.bus.diagnostic('warn', 'session/resume-failed', {
      message: error instanceof Error ? error.message : String(error),
      agentId,
      sessionId,
    })
    if (isNewSession) {
      manager.stagingSessions.delete(sessionId)
    } else if (manager.isCurrentLifecycle(session, 'resume', operationId)) {
      manager.endLifecycle(session, operationId)
      if (session.status === 'resuming') {
        manager.bus.setSessionStatus(session, previousStatus)
      }
    }
    throw error
  } finally {
    manager.endLifecycle(session, operationId)
  }
}
