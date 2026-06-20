import {
  ACP_ERROR_CODES,
  type AgentSnapshotWire,
  type CreateOrLoadSessionParams,
  type PromptFinishedPayload,
  type ResumeSessionParams,
  type SessionSnapshotWire,
} from '@acpjs/protocol'

import { AgentRuntime } from './agent-runtime.ts'
import { deriveClientCapabilities } from './capabilities.ts'
import { AcpError } from './errors.ts'
import { EventBus, registerHostBus } from './event-bus.ts'
import { createDefaultFsHandler } from './fs-handler.ts'
import { createAgentClient } from './host-client.ts'
import { capabilityEnabled, type EventSubscriber } from './internal.ts'
import {
  resolveAgentDefinition,
  resolveHostOptions,
  type AgentDefinition,
  type FsHandler,
  type HostOptions,
  type ResolvedHostOptions,
  type TerminalHandler,
} from './options.ts'
import { PermissionRouter } from './permission-router.ts'
import { requireCapability } from './session-config.ts'
import {
  SessionManager,
  type CreateSessionResult,
  type SessionConfigValue,
} from './session-manager.ts'
import { recoverSessions, restoreSessions } from './session-recovery.ts'
import { agentSnapshot, sessionSnapshot } from './snapshots.ts'

import type {
  ContentBlock,
  ListSessionsResponse,
  RequestPermissionOutcome,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'

export type {
  AgentSnapshotWire,
  CreateOrLoadSessionParams,
  CreateSessionResult,
  ResumeSessionParams,
  SessionConfigValue,
  SessionSnapshotWire,
}
export type { EventSubscriber }

export type PromptResult = PromptFinishedPayload

export class AcpHost {
  #options: ResolvedHostOptions
  #bus: EventBus
  #runtime: AgentRuntime
  #router: PermissionRouter
  #sessions: SessionManager
  #fsHandler: FsHandler
  #terminalHandler: TerminalHandler
  #disposed = false

  constructor(options: HostOptions = {}) {
    this.#options = resolveHostOptions(options)
    this.#bus = new EventBus(this.#options.storage)
    registerHostBus(this, this.#bus)
    this.#fsHandler =
      this.#options.fs ??
      createDefaultFsHandler((sessionId) => {
        const session = this.#sessions.sessions.get(sessionId)
        return session
          ? [session.cwd, ...session.additionalDirectories]
          : undefined
      })
    this.#terminalHandler = this.#options.terminal ?? {}
    this.#router = new PermissionRouter(this.#bus)
    this.#runtime = new AgentRuntime({
      options: this.#options,
      bus: this.#bus,
      clientCapabilities: deriveClientCapabilities(
        this.#fsHandler,
        this.#terminalHandler,
      ),
      createClient: (handle) =>
        createAgentClient(
          {
            sessions: this.#sessions,
            bus: this.#bus,
            router: this.#router,
            fsHandler: this.#fsHandler,
            terminalHandler: this.#terminalHandler,
          },
          handle.agentId,
        ),
      onAgentDown: (handle) => {
        this.#router.supersedeForAgent(handle.agentId)
        this.#sessions.disconnectForAgent(handle.agentId)
      },
      onAgentReady: (handle) => {
        void recoverSessions(this.#sessions, handle)
      },
      isHostDisposed: () => this.#disposed,
    })
    this.#sessions = new SessionManager(
      this.#bus,
      this.#runtime,
      this.#router,
      (sessionId) => this.#terminalHandler.cleanupSession?.(sessionId),
    )
  }

  get options(): ResolvedHostOptions {
    return this.#options
  }

  async spawnAgent(definition: AgentDefinition): Promise<AgentSnapshotWire> {
    if (this.#disposed) {
      throw new AcpError(ACP_ERROR_CODES.agentExited, 'host disposed')
    }
    const handle = this.#runtime.register(resolveAgentDefinition(definition))
    await this.#runtime.start(handle)
    const snapshot = this.getAgent(handle.agentId)
    if (!snapshot) {
      throw new AcpError(ACP_ERROR_CODES.agentExited, 'agent record missing')
    }
    return snapshot
  }

  getAgent(agentId: string): AgentSnapshotWire | undefined {
    const handle = this.#runtime.agents.get(agentId)
    return handle ? agentSnapshot(handle) : undefined
  }

  getAgents(): AgentSnapshotWire[] {
    return Array.from(this.#runtime.agents.values(), agentSnapshot)
  }

  async disposeAgent(agentId: string): Promise<void> {
    const handle = this.#runtime.agents.get(agentId)
    if (!handle) return
    this.#runtime.agents.delete(agentId)
    await this.#runtime.dispose(handle)
    this.#bus.emitHost(
      { agentId, type: 'agent-removed', payload: { agentId } },
      false,
    )
  }

  getSession(sessionId: string): SessionSnapshotWire | undefined {
    const session = this.#sessions.sessions.get(sessionId)
    return session ? sessionSnapshot(session) : undefined
  }

  getSessions(): SessionSnapshotWire[] {
    return Array.from(this.#sessions.sessions.values(), sessionSnapshot)
  }

  async createSession(
    agentId: string,
    params: CreateOrLoadSessionParams,
  ): Promise<CreateSessionResult> {
    return this.#sessions.create(agentId, params)
  }

  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResult> {
    return this.#sessions.prompt(sessionId, prompt)
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#sessions.cancel(sessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#sessions.close(sessionId)
  }

  async listSessions(
    agentId: string,
    params: { cursor?: string; cwd?: string } = {},
  ): Promise<ListSessionsResponse> {
    const { handle, conn } = this.#runtime.requireReady(agentId)
    requireCapability(
      capabilityEnabled(handle.capabilities?.sessionCapabilities?.list),
      'session/list',
    )
    return this.#runtime.track(handle, conn.listSessions(params))
  }

  async resumeSession(
    agentId: string,
    sessionId: string,
    params: ResumeSessionParams,
  ): Promise<void> {
    await this.#sessions.resume(agentId, sessionId, params)
  }

  async deleteSession(agentId: string, sessionId: string): Promise<void> {
    await this.#sessions.delete(agentId, sessionId)
  }

  async loadSession(
    agentId: string,
    sessionId: string,
    params: CreateOrLoadSessionParams,
  ): Promise<void> {
    await this.#sessions.load(agentId, sessionId, params)
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.#sessions.setMode(sessionId, modeId)
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: SessionConfigValue,
  ): Promise<SessionConfigOption[]> {
    return this.#sessions.setConfigOption(sessionId, configId, value)
  }

  subscribe(
    sessionId: string | undefined,
    fromSeq: number,
    callback: EventSubscriber,
  ): () => void {
    if (sessionId === undefined) {
      return this.#bus.subscribeHost(fromSeq, callback)
    }
    const session = this.#sessions.sessions.get(sessionId)
    if (!session) {
      throw new AcpError(
        ACP_ERROR_CODES.sessionClosed,
        `unknown session: ${sessionId}`,
      )
    }
    return this.#bus.subscribeSession(session, fromSeq, callback)
  }

  respondPermission(
    requestId: string,
    outcome: RequestPermissionOutcome,
  ): void {
    this.#router.respond(requestId, outcome)
  }

  async restoreSessions(): Promise<SessionSnapshotWire[]> {
    const restored = await restoreSessions(
      this.#sessions,
      this.#options.storage,
    )
    return restored.map(sessionSnapshot)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await Promise.all(
      Array.from(this.#runtime.agents.values(), (handle) =>
        this.#runtime.dispose(handle),
      ),
    )
    await this.#bus.flushStorage()
  }
}

export function createAcpHost(options: HostOptions = {}): AcpHost {
  return new AcpHost(options)
}
