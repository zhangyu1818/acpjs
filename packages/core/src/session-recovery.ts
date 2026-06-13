import { resolve } from 'node:path'

import { ACP_ERROR_CODES, type AcpSessionEvent } from '@acpjs/protocol'

import { AcpError } from './errors.ts'
import {
  isStructuredCloneable,
  type AgentHandle,
  type SessionHandle,
} from './internal.ts'
import { requireCapability, type SessionManager } from './session-manager.ts'

import type { LoadSessionResponse, McpServer } from '@agentclientprotocol/sdk'

import type { StorageAdapter } from './storage.ts'

export async function loadIntoAgent(
  manager: SessionManager,
  handle: AgentHandle,
  session: SessionHandle,
): Promise<void> {
  const conn = handle.conn
  if (!conn) {
    throw new AcpError(ACP_ERROR_CODES.agentExited, 'agent not connected')
  }
  manager.bus.setSessionStatus(session, 'resuming')
  session.suppressUpdates = true
  let response: LoadSessionResponse
  try {
    response = await manager.runtime.track(
      handle,
      conn.loadSession({
        sessionId: session.sessionId,
        cwd: session.cwd,
        mcpServers: session.mcpServers,
      }),
    )
  } catch (error) {
    session.suppressUpdates = false
    manager.bus.diagnostic('warn', 'session/load-failed', {
      message: error instanceof Error ? error.message : String(error),
      agentId: handle.agentId,
      sessionId: session.sessionId,
    })
    manager.bus.setSessionStatus(session, 'disconnected')
    throw error
  }
  session.suppressUpdates = false
  session.hasModes = session.hasModes || response.modes != null
  session.hasConfigOptions =
    session.hasConfigOptions || response.configOptions != null
  manager.bus.emitConfigInit(session, response, false)
  manager.bus.setSessionStatus(session, 'active', { resumed: true })
}

export async function loadSessionOp(
  manager: SessionManager,
  agentId: string,
  sessionId: string,
  params: { cwd?: string; mcpServers?: McpServer[] },
): Promise<void> {
  const { handle } = manager.runtime.requireReady(agentId)
  requireCapability(handle.capabilities?.loadSession === true, 'session/load')
  const session = manager.require(sessionId)
  if (params.cwd !== undefined) session.cwd = resolve(params.cwd)
  if (params.mcpServers !== undefined) session.mcpServers = params.mcpServers
  if (session.cwd === '') {
    throw new AcpError(
      ACP_ERROR_CODES.configInvalid,
      'cwd required to load a restored session',
    )
  }
  session.agentId = agentId
  await loadIntoAgent(manager, handle, session)
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
    if (handle.capabilities?.loadSession === true) {
      try {
        await loadIntoAgent(manager, handle, session)
      } catch {
        continue
      }
    } else {
      manager.bus.diagnostic('info', 'session/recovery-skipped', {
        message: 'agent does not support session/load',
        agentId: handle.agentId,
        sessionId: session.sessionId,
      })
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
    if (manager.sessions.has(meta.sessionId)) continue
    const events = await storage.loadEvents(meta.sessionId)
    const valid: AcpSessionEvent[] = []
    for (const event of events) {
      if (!isStructuredCloneable(event)) {
        manager.bus.diagnostic('error', 'event/unserializable', {
          message: 'dropped unserializable stored event',
          sessionId: meta.sessionId,
        })
        continue
      }
      valid.push(event as AcpSessionEvent)
    }
    const session: SessionHandle = {
      sessionId: meta.sessionId,
      status: 'disconnected',
      cwd: meta.cwd ?? '',
      mcpServers: [],
      log: valid,
      nextSeq: (valid.at(-1)?.seq ?? 0) + 1,
      hasModes: false,
      hasConfigOptions: false,
      suppressUpdates: false,
      subscribers: new Set(),
      ...(meta.agentDefinitionId === undefined
        ? {}
        : { agentDefinitionId: meta.agentDefinitionId }),
    }
    manager.sessions.set(session.sessionId, session)
    const lastStatus = valid.findLast(
      (event) => event.type === 'session-status-change',
    )
    if (
      lastStatus?.type !== 'session-status-change' ||
      lastStatus.payload.status !== 'disconnected'
    ) {
      manager.bus.setSessionStatus(session, 'disconnected')
    }
    manager.bus.emitSessionLifecycle('session-created', {
      sessionId: session.sessionId,
      status: 'disconnected',
    })
    restored.push(session)
  }
  return restored
}
