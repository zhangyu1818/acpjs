import {
  ACPJS_ERROR_CODES,
  type CreateOrLoadSessionParams,
  type CreateSessionResult,
  type PromptFinishedPayload,
  type ResumeSessionParams,
  type SessionConfigValue,
} from '@acpjs/protocol'

import { AcpError } from './errors.ts'
import {
  cancelManagedSession,
  promptManagedSession,
  setManagedSessionConfigOption,
  setManagedSessionMode,
} from './session-actions.ts'
import { sameAgentOrUnknown } from './session-config.ts'
import {
  createManagedSession,
  loadManagedSession,
  resumeManagedSession,
} from './session-lifecycle.ts'
import {
  closeManagedSession,
  deleteManagedSession,
} from './session-terminal-actions.ts'

import type {
  ContentBlock,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'

import type { AgentRuntime } from './agent-runtime.ts'
import type { EventBus } from './event-bus.ts'
import type { AgentHandle, SessionHandle } from './internal.ts'
import type { PermissionRouter } from './permission-router.ts'

export type {
  CreateOrLoadSessionParams,
  CreateSessionResult,
  ResumeSessionParams,
  SessionConfigValue,
}

export class SessionManager {
  readonly sessions = new Map<string, SessionHandle>()
  readonly stagingSessions = new Map<string, SessionHandle>()
  readonly tombstones = new Map<string, 'closed' | 'deleted'>()
  readonly bus: EventBus
  readonly runtime: AgentRuntime
  readonly router: PermissionRouter
  readonly cleanupSession: (sessionId: string) => void
  #operationCounter = 0

  constructor(
    bus: EventBus,
    runtime: AgentRuntime,
    router: PermissionRouter,
    cleanupSession: (sessionId: string) => void = () => {},
  ) {
    this.bus = bus
    this.runtime = runtime
    this.router = router
    this.cleanupSession = cleanupSession
  }

  require(sessionId: string): SessionHandle {
    const session = this.sessions.get(sessionId)
    if (
      this.tombstones.has(sessionId) ||
      !session ||
      session.status === 'closed' ||
      session.status === 'deleted'
    ) {
      throw new AcpError(
        ACPJS_ERROR_CODES.sessionClosed,
        `session ${sessionId} is closed or unknown`,
      )
    }
    return session
  }

  beginLifecycle(
    session: SessionHandle,
    operation: NonNullable<SessionHandle['lifecycleOperation']>,
  ): number {
    if (session.lifecycleOperation !== undefined) {
      throw new AcpError(
        ACPJS_ERROR_CODES.configInvalid,
        `session ${session.sessionId} lifecycle operation in progress`,
      )
    }
    this.#operationCounter += 1
    session.lifecycleOperation = operation
    session.lifecycleOperationId = this.#operationCounter
    return this.#operationCounter
  }

  isCurrentLifecycle(
    session: SessionHandle,
    operation: NonNullable<SessionHandle['lifecycleOperation']>,
    operationId: number,
  ): boolean {
    return (
      this.sessions.get(session.sessionId) === session &&
      session.lifecycleOperation === operation &&
      session.lifecycleOperationId === operationId &&
      session.status !== 'closed' &&
      session.status !== 'deleted'
    )
  }

  isCurrentStagingLifecycle(
    session: SessionHandle,
    operation: NonNullable<SessionHandle['lifecycleOperation']>,
    operationId: number,
  ): boolean {
    return (
      this.stagingSessions.get(session.sessionId) === session &&
      session.lifecycleOperation === operation &&
      session.lifecycleOperationId === operationId
    )
  }

  endLifecycle(session: SessionHandle, operationId: number): void {
    if (session.lifecycleOperationId !== operationId) return
    delete session.lifecycleOperation
    delete session.lifecycleOperationId
  }

  invalidateLifecycle(session: SessionHandle): void {
    delete session.lifecycleOperation
    delete session.lifecycleOperationId
    delete session.loadReplay
  }

  markTombstone(sessionId: string, lifecycle: 'closed' | 'deleted'): void {
    this.tombstones.set(sessionId, lifecycle)
  }

  assertNotTombstoned(sessionId: string): void {
    if (!this.tombstones.has(sessionId)) return
    throw new AcpError(
      ACPJS_ERROR_CODES.sessionClosed,
      `session ${sessionId} is closed or deleted`,
    )
  }

  assertNotDeleted(sessionId: string): void {
    if (this.tombstones.get(sessionId) !== 'deleted') return
    throw new AcpError(
      ACPJS_ERROR_CODES.sessionClosed,
      `session ${sessionId} is deleted`,
    )
  }

  reopenClosedSession(sessionId: string): void {
    if (this.tombstones.get(sessionId) !== 'closed') return
    this.tombstones.delete(sessionId)
    this.sessions.delete(sessionId)
  }

  disconnectForAgent(agentId: string): void {
    for (const session of this.sessions.values()) {
      if (
        session.agentId === agentId &&
        session.status !== 'closed' &&
        session.status !== 'deleted' &&
        session.status !== 'disconnected'
      ) {
        this.cleanupSession(session.sessionId)
        this.bus.setSessionStatus(session, 'disconnected')
      }
    }
  }

  createHandle(
    agentId: string,
    handle: AgentHandle,
    sessionId: string,
    params: CreateOrLoadSessionParams | ResumeSessionParams,
    status: SessionHandle['status'],
  ): SessionHandle {
    const session: SessionHandle = {
      sessionId,
      agentId,
      agentDefinitionId: handle.definition.id,
      status,
      cwd: params.cwd,
      ...(params.mcpServers === undefined
        ? {}
        : { mcpServers: params.mcpServers }),
      additionalDirectories: params.additionalDirectories,
      log: [],
      nextSeq: 1,
      hasModes: false,
      hasConfigOptions: false,
      subscribers: new Set(),
    }
    return session
  }

  addSession(session: SessionHandle): void {
    this.assertNotTombstoned(session.sessionId)
    if (
      this.sessions.has(session.sessionId) ||
      this.stagingSessions.has(session.sessionId)
    ) {
      throw new AcpError(
        ACPJS_ERROR_CODES.configInvalid,
        `session ${session.sessionId} already exists`,
      )
    }
    this.sessions.set(session.sessionId, session)
  }

  addStagingSession(session: SessionHandle): void {
    this.assertNotTombstoned(session.sessionId)
    if (
      this.sessions.has(session.sessionId) ||
      this.stagingSessions.has(session.sessionId)
    ) {
      throw new AcpError(
        ACPJS_ERROR_CODES.configInvalid,
        `session ${session.sessionId} already exists`,
      )
    }
    this.stagingSessions.set(session.sessionId, session)
  }

  commitStagingSession(session: SessionHandle): void {
    this.assertNotTombstoned(session.sessionId)
    if (this.stagingSessions.get(session.sessionId) !== session) {
      throw new AcpError(
        ACPJS_ERROR_CODES.sessionClosed,
        `session ${session.sessionId} is no longer pending`,
      )
    }
    if (this.sessions.has(session.sessionId)) {
      throw new AcpError(
        ACPJS_ERROR_CODES.configInvalid,
        `session ${session.sessionId} already exists`,
      )
    }
    this.stagingSessions.delete(session.sessionId)
    this.sessions.set(session.sessionId, session)
  }

  applyEffectiveConfig(
    session: SessionHandle,
    agentId: string,
    handle: AgentHandle,
    params: CreateOrLoadSessionParams | ResumeSessionParams,
  ): void {
    if (!sameAgentOrUnknown(session, agentId, handle.definition.id)) {
      throw new AcpError(
        ACPJS_ERROR_CODES.configInvalid,
        `session ${session.sessionId} belongs to another agent`,
      )
    }
    session.agentId = agentId
    session.agentDefinitionId = handle.definition.id
    session.cwd = params.cwd
    if (params.mcpServers === undefined) {
      delete session.mcpServers
    } else {
      session.mcpServers = params.mcpServers
    }
    session.additionalDirectories = params.additionalDirectories
  }

  async create(
    agentId: string,
    params: CreateOrLoadSessionParams,
  ): Promise<CreateSessionResult> {
    return createManagedSession(this, agentId, params)
  }

  async load(
    agentId: string,
    sessionId: string,
    params: CreateOrLoadSessionParams,
  ): Promise<void> {
    await loadManagedSession(this, agentId, sessionId, params)
  }

  async resume(
    agentId: string,
    sessionId: string,
    params: ResumeSessionParams,
  ): Promise<void> {
    await resumeManagedSession(this, agentId, sessionId, params)
  }

  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptFinishedPayload> {
    return promptManagedSession(this, sessionId, prompt)
  }

  async cancel(sessionId: string): Promise<void> {
    await cancelManagedSession(this, sessionId)
  }

  async close(sessionId: string): Promise<void> {
    await closeManagedSession(this, sessionId)
  }

  async delete(agentId: string, sessionId: string): Promise<void> {
    await deleteManagedSession(this, agentId, sessionId)
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await setManagedSessionMode(this, sessionId, modeId)
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: SessionConfigValue,
  ): Promise<SessionConfigOption[]> {
    return setManagedSessionConfigOption(this, sessionId, configId, value)
  }
}
