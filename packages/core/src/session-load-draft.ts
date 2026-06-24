import {
  isStructuredCloneable,
  type AgentHandle,
  type BufferedSessionEvent,
  type SessionHandle,
} from './internal.ts'

import type {
  AcpjsEventExtensions,
  AcpjsSessionEvent,
  CreateOrLoadSessionParams,
} from '@acpjs/protocol'

import type { SessionManager } from './session-manager.ts'

function pushDraftEvent(
  manager: SessionManager,
  session: SessionHandle,
  type: AcpjsSessionEvent['type'],
  payload: unknown,
  extensions?: AcpjsEventExtensions,
): void {
  const event = {
    sessionId: session.sessionId,
    seq: session.nextSeq,
    ts: Date.now(),
    type,
    payload,
    ...(extensions ? { extensions } : {}),
  } as AcpjsSessionEvent
  if (!isStructuredCloneable(event)) {
    manager.bus.diagnostic('error', 'event/unserializable', {
      message: `rejected unserializable ${type} event`,
      sessionId: session.sessionId,
    })
    return
  }
  session.nextSeq += 1
  session.log.push(event)
}

function pushDraftConfigInit(
  manager: SessionManager,
  session: SessionHandle,
  response: { modes?: unknown; configOptions?: unknown },
): void {
  const hasConfigOptions = response.configOptions != null
  const payload = {
    ...(response.modes == null || hasConfigOptions
      ? {}
      : { modes: response.modes }),
    ...(hasConfigOptions ? { configOptions: response.configOptions } : {}),
  }
  if (Object.keys(payload).length !== 0) {
    pushDraftEvent(manager, session, 'session-config-init', payload)
  }
}

function applyDraftBufferedEvent(
  manager: SessionManager,
  session: SessionHandle,
  event: BufferedSessionEvent,
): void {
  pushDraftEvent(manager, session, event.type, event.payload, event.extensions)
  if (event.type !== 'session-info-update') return
  const payload = event.payload as {
    title?: string | null
    updatedAt?: string | null
  }
  if (payload.title !== undefined) session.title = payload.title
  if (payload.updatedAt !== undefined) session.updatedAt = payload.updatedAt
}

export function createLoadDraft(
  session: SessionHandle,
  agentId: string,
  handle: AgentHandle,
  params: CreateOrLoadSessionParams,
): SessionHandle {
  return {
    sessionId: session.sessionId,
    agentId,
    agentDefinitionId: handle.definition.id,
    status: 'active',
    cwd: params.cwd,
    mcpServers: params.mcpServers,
    additionalDirectories: params.additionalDirectories,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.updatedAt === undefined
      ? {}
      : { updatedAt: session.updatedAt }),
    log: [],
    nextSeq: 1,
    hasModes: false,
    hasConfigOptions: false,
    subscribers: new Set(),
  }
}

export function applyLoadDraftReplay(
  manager: SessionManager,
  draft: SessionHandle,
  replay: BufferedSessionEvent[],
  response: { modes?: unknown; configOptions?: unknown },
): void {
  pushDraftEvent(manager, draft, 'session-reset', { reason: 'load' })
  for (const event of replay) {
    applyDraftBufferedEvent(manager, draft, event)
  }
  pushDraftConfigInit(manager, draft, response)
  pushDraftEvent(manager, draft, 'session-status-change', {
    status: 'active',
    resumed: true,
  })
}

export function applyCommittedDraft(
  manager: SessionManager,
  session: SessionHandle,
  draft: SessionHandle,
): void {
  if (draft.agentId === undefined) {
    delete session.agentId
  } else {
    session.agentId = draft.agentId
  }
  if (draft.agentDefinitionId === undefined) {
    delete session.agentDefinitionId
  } else {
    session.agentDefinitionId = draft.agentDefinitionId
  }
  session.status = draft.status
  session.cwd = draft.cwd
  if (draft.mcpServers === undefined) {
    delete session.mcpServers
  } else {
    session.mcpServers = draft.mcpServers
  }
  session.additionalDirectories = draft.additionalDirectories
  if (draft.title === undefined) {
    delete session.title
  } else {
    session.title = draft.title
  }
  if (draft.updatedAt === undefined) {
    delete session.updatedAt
  } else {
    session.updatedAt = draft.updatedAt
  }
  session.log = []
  session.nextSeq = 1
  session.hasModes = draft.hasModes
  session.hasConfigOptions = draft.hasConfigOptions
  for (const event of draft.log) {
    manager.bus.publishCommittedSessionEvent(session, event)
  }
  manager.bus.emitSessionUpdated(session)
}
