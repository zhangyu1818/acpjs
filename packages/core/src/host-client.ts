import {
  RequestError,
  type Client,
  type SessionNotification,
} from '@agentclientprotocol/sdk'

import { normalizeSessionUpdate } from './normalize.ts'
import { sessionMeta } from './session-config.ts'

import type { EventBus } from './event-bus.ts'
import type { BufferedSessionEvent, SessionHandle } from './internal.ts'
import type { FsHandler, TerminalHandler } from './options.ts'
import type { PermissionRouter } from './permission-router.ts'
import type { SessionManager } from './session-manager.ts'

interface HostClientContext {
  sessions: SessionManager
  bus: EventBus
  router: PermissionRouter
  fsHandler: FsHandler
  terminalHandler: TerminalHandler
}

function applySessionInfo(
  context: HostClientContext,
  session: SessionHandle,
): void {
  void context.bus.appendMeta(sessionMeta(session))
}

export function applyBufferedSessionEvent(
  context: Pick<HostClientContext, 'bus'>,
  session: SessionHandle,
  event: BufferedSessionEvent,
): void {
  context.bus.emitSession(session, event.type, event.payload, event.extensions)
  if (event.type === 'session-info-update') {
    const payload = event.payload as {
      title?: string | null
      updatedAt?: string | null
    }
    if (payload.title !== undefined) session.title = payload.title
    if (payload.updatedAt !== undefined) session.updatedAt = payload.updatedAt
    context.bus.emitSessionUpdated(session)
  }
}

function requireReverseSession(
  context: HostClientContext,
  agentId: string,
  sessionId: string,
) {
  const session = context.sessions.sessions.get(sessionId)
  if (
    !session ||
    session.status === 'closed' ||
    session.status === 'deleted' ||
    session.status === 'disconnected'
  ) {
    throw RequestError.invalidParams({ sessionId }, 'unknown or closed session')
  }
  if (session.agentId !== undefined && session.agentId !== agentId) {
    throw RequestError.invalidParams(
      { sessionId, agentId },
      'session belongs to another agent',
    )
  }
  if (session.lifecycleOperation !== undefined) {
    throw RequestError.invalidParams(
      { sessionId, operation: session.lifecycleOperation },
      'session lifecycle operation in progress',
    )
  }
  return session
}

function findUpdateSession(
  context: HostClientContext,
  sessionId: string,
): SessionHandle | undefined {
  return (
    context.sessions.sessions.get(sessionId) ??
    context.sessions.stagingSessions.get(sessionId)
  )
}

function onSessionUpdate(
  context: HostClientContext,
  agentId: string,
  notification: SessionNotification,
): void {
  const session = findUpdateSession(context, notification.sessionId)
  if (!session || session.status === 'closed' || session.status === 'deleted') {
    return
  }
  if (
    session.status === 'disconnected' &&
    session.lifecycleOperation === undefined
  ) {
    return
  }
  if (session.agentId !== undefined && session.agentId !== agentId) {
    context.bus.diagnostic('error', 'session/update-cross-agent', {
      message: 'agent sent update for a session it does not own',
      agentId,
      sessionId: notification.sessionId,
    })
    return
  }
  if (session.lifecycleOperation === 'resume') {
    context.bus.diagnostic('error', 'session/resume-replayed-history', {
      message: 'agent sent session/update while resuming',
      agentId,
      sessionId: notification.sessionId,
    })
    return
  }
  if (
    session.lifecycleOperation === 'close' ||
    session.lifecycleOperation === 'delete'
  ) {
    context.bus.diagnostic('warn', 'session/update-during-terminal-lifecycle', {
      message: 'agent sent session/update while closing or deleting',
      agentId,
      sessionId: notification.sessionId,
    })
    return
  }
  const normalized = normalizeSessionUpdate(notification.update)
  if (session.lifecycleOperation === 'load') {
    const replay = session.loadReplay ?? []
    replay.push(normalized)
    session.loadReplay = replay
    return
  }
  applyBufferedSessionEvent(context, session, normalized)
  if (normalized.type === 'session-info-update') {
    applySessionInfo(context, session)
  }
}

export function createAgentClient(
  context: HostClientContext,
  agentId: string,
): Client {
  const client: Client = {
    async sessionUpdate(notification) {
      onSessionUpdate(context, agentId, notification)
    },
    requestPermission(params) {
      const session = requireReverseSession(context, agentId, params.sessionId)
      return context.router.handle(session, params)
    },
  }
  const { readTextFile, writeTextFile } = context.fsHandler
  if (typeof readTextFile === 'function') {
    client.readTextFile = async (params) => {
      requireReverseSession(context, agentId, params.sessionId)
      return readTextFile.call(context.fsHandler, params)
    }
  }
  if (typeof writeTextFile === 'function') {
    client.writeTextFile = async (params) => {
      requireReverseSession(context, agentId, params.sessionId)
      return writeTextFile.call(context.fsHandler, params)
    }
  }
  const terminal = context.terminalHandler
  const {
    createTerminal,
    terminalOutput,
    waitForTerminalExit,
    killTerminal,
    releaseTerminal,
  } = terminal
  if (
    typeof createTerminal === 'function' &&
    typeof terminalOutput === 'function' &&
    typeof waitForTerminalExit === 'function' &&
    typeof killTerminal === 'function' &&
    typeof releaseTerminal === 'function' &&
    typeof terminal.cleanupSession === 'function'
  ) {
    const terminalOwners = new Map<string, string>()
    const requireTerminalOwner = (
      sessionId: string,
      terminalId: string,
    ): void => {
      const owner = terminalOwners.get(terminalId)
      if (owner !== undefined && owner !== sessionId) {
        throw RequestError.invalidParams(
          { sessionId, terminalId },
          'terminal belongs to another session',
        )
      }
    }
    client.createTerminal = async (params) => {
      requireReverseSession(context, agentId, params.sessionId)
      const response = await createTerminal.call(terminal, params)
      terminalOwners.set(response.terminalId, params.sessionId)
      return response
    }
    client.terminalOutput = async (params) => {
      requireReverseSession(context, agentId, params.sessionId)
      requireTerminalOwner(params.sessionId, params.terminalId)
      return terminalOutput.call(terminal, params)
    }
    client.waitForTerminalExit = async (params) => {
      requireReverseSession(context, agentId, params.sessionId)
      requireTerminalOwner(params.sessionId, params.terminalId)
      return waitForTerminalExit.call(terminal, params)
    }
    client.killTerminal = async (params) => {
      requireReverseSession(context, agentId, params.sessionId)
      requireTerminalOwner(params.sessionId, params.terminalId)
      return killTerminal.call(terminal, params)
    }
    client.releaseTerminal = async (params) => {
      requireReverseSession(context, agentId, params.sessionId)
      requireTerminalOwner(params.sessionId, params.terminalId)
      const response = await releaseTerminal.call(terminal, params)
      terminalOwners.delete(params.terminalId)
      return response
    }
  }
  return client
}
