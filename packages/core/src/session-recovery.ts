import {
  isStructuredCloneable,
  type AgentHandle,
  type SessionHandle,
} from './internal.ts'

import type { AcpjsSessionEvent } from '@acpjs/protocol'

import type { SessionManager } from './session-manager.ts'
import type { StorageAdapter } from './storage.ts'

function closeStalePermissions(
  events: AcpjsSessionEvent[],
): AcpjsSessionEvent[] {
  const pending = new Set<string>()
  for (const event of events) {
    if (event.type === 'permission-request-created') {
      pending.add(event.payload.requestId)
    } else if (event.type === 'permission-request-resolved') {
      pending.delete(event.payload.requestId)
    }
  }
  if (pending.size === 0) return events
  const next = [...events]
  let seq = next.at(-1)?.seq ?? 0
  for (const requestId of pending) {
    seq += 1
    next.push({
      sessionId: events[0]?.sessionId ?? '',
      seq,
      ts: Date.now(),
      type: 'permission-request-resolved',
      payload: { requestId, status: 'superseded' },
    })
  }
  return next
}

export async function recoverSessions(
  manager: SessionManager,
  handle: AgentHandle,
): Promise<void> {
  const disconnected = Array.from(manager.sessions.values()).filter(
    (session) =>
      session.agentId === handle.agentId && session.status === 'disconnected',
  )
  for (const session of disconnected) {
    if (session.log.length === 0) {
      manager.bus.diagnostic('info', 'session/recovery-skipped', {
        message: 'session has no local event log',
        agentId: handle.agentId,
        sessionId: session.sessionId,
      })
      continue
    }
    if (!handle.capabilities?.sessionCapabilities?.resume) {
      manager.bus.diagnostic('info', 'session/recovery-skipped', {
        message: 'agent does not support session/resume',
        agentId: handle.agentId,
        sessionId: session.sessionId,
      })
      continue
    }
    try {
      await manager.resume(handle.agentId, session.sessionId, {
        cwd: session.cwd,
        ...(session.mcpServers === undefined
          ? {}
          : { mcpServers: session.mcpServers }),
        additionalDirectories: session.additionalDirectories,
      })
    } catch {
      continue
    }
  }
}

export async function restoreSessions(
  manager: SessionManager,
  storage: StorageAdapter,
): Promise<SessionHandle[]> {
  const metas = await storage.listSessions()
  const restored: SessionHandle[] = []
  for (const meta of metas) {
    if (meta.lifecycle === 'closed' || meta.lifecycle === 'deleted') {
      manager.markTombstone(meta.sessionId, meta.lifecycle)
      continue
    }
    if (manager.sessions.has(meta.sessionId)) continue
    const events = await storage.loadEvents(meta.sessionId)
    const valid: AcpjsSessionEvent[] = []
    for (const event of events) {
      if (!isStructuredCloneable(event)) {
        manager.bus.diagnostic('error', 'event/unserializable', {
          message: 'dropped unserializable stored event',
          sessionId: meta.sessionId,
        })
        continue
      }
      valid.push(event)
    }
    const eventsWithClosedPermissions = closeStalePermissions(valid)
    const lastRestoredStatus = eventsWithClosedPermissions.findLast(
      (event) => event.type === 'session-status-change',
    )
    if (
      lastRestoredStatus?.type === 'session-status-change' &&
      (lastRestoredStatus.payload.status === 'closed' ||
        lastRestoredStatus.payload.status === 'deleted')
    ) {
      manager.markTombstone(meta.sessionId, lastRestoredStatus.payload.status)
      continue
    }
    const session: SessionHandle = {
      sessionId: meta.sessionId,
      status: 'disconnected',
      cwd: meta.cwd,
      ...(meta.mcpServers === undefined ? {} : { mcpServers: meta.mcpServers }),
      additionalDirectories: meta.additionalDirectories,
      log: eventsWithClosedPermissions,
      nextSeq: (eventsWithClosedPermissions.at(-1)?.seq ?? 0) + 1,
      hasModes: false,
      hasConfigOptions: false,
      subscribers: new Set(),
      ...(meta.agentDefinitionId === undefined
        ? {}
        : { agentDefinitionId: meta.agentDefinitionId }),
      ...(meta.title === undefined ? {} : { title: meta.title }),
      ...(meta.updatedAt === undefined ? {} : { updatedAt: meta.updatedAt }),
    }
    manager.sessions.set(session.sessionId, session)
    await manager.bus.replaceSession(session, {
      sessionId: session.sessionId,
      ...(session.agentDefinitionId === undefined
        ? {}
        : { agentDefinitionId: session.agentDefinitionId }),
      cwd: session.cwd,
      ...(session.mcpServers === undefined
        ? {}
        : { mcpServers: session.mcpServers }),
      additionalDirectories: session.additionalDirectories,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.updatedAt === undefined
        ? {}
        : { updatedAt: session.updatedAt }),
      lifecycle: 'open',
    })
    if (
      lastRestoredStatus?.type !== 'session-status-change' ||
      lastRestoredStatus.payload.status !== 'disconnected'
    ) {
      manager.bus.setSessionStatus(session, 'disconnected')
    } else {
      manager.bus.emitSessionUpdated(session)
    }
    restored.push(session)
  }
  return restored
}
