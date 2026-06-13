import { ACP_ERROR_CODES, type PromptFinishedPayload } from '@acpjs/protocol'

import { AgentRuntime } from './agent-runtime.ts'
import { deriveClientCapabilities } from './capabilities.ts'
import { AcpError } from './errors.ts'
import { EventBus, registerHostBus } from './event-bus.ts'
import { createDefaultFsHandler } from './fs-handler.ts'
import { capabilityEnabled, type EventSubscriber } from './internal.ts'
import { normalizeSessionUpdate } from './normalize.ts'
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
import {
  requireCapability,
  SessionManager,
  type CreateSessionResult,
  type SessionConfigValue,
} from './session-manager.ts'
import {
  loadSessionOp,
  recoverSessions,
  restoreSessions,
} from './session-recovery.ts'
import {
  agentSnapshot,
  sessionSnapshot,
  type AgentSnapshot,
  type SessionSnapshot,
} from './snapshots.ts'
import { createDefaultTerminalHandler } from './terminal-handler.ts'

import type {
  Client,
  ContentBlock,
  ListSessionsResponse,
  McpServer,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk'

export type { CreateSessionResult, SessionConfigValue }
export type { EventSubscriber }
export type { AgentSnapshot, SessionSnapshot }

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
    this.#fsHandler = this.#options.fs ?? createDefaultFsHandler()
    this.#terminalHandler =
      this.#options.terminal ??
      createDefaultTerminalHandler((sessionId, payload) => {
        const session = this.#sessions.sessions.get(sessionId)
        if (session) this.#bus.emitSession(session, 'terminal-output', payload)
      })
    this.#router = new PermissionRouter(
      this.#bus,
      this.#options.permissionPolicy,
    )
    this.#runtime = new AgentRuntime({
      options: this.#options,
      bus: this.#bus,
      clientCapabilities: deriveClientCapabilities(
        this.#fsHandler,
        this.#terminalHandler,
      ),
      createClient: () => this.#createClient(),
      onAgentDown: (handle) => {
        this.#router.supersedeForAgent(handle.agentId)
        this.#sessions.disconnectForAgent(handle.agentId)
      },
      onAgentReady: (handle) => {
        void recoverSessions(this.#sessions, handle)
      },
      isHostDisposed: () => this.#disposed,
    })
    this.#sessions = new SessionManager(this.#bus, this.#runtime, this.#router)
  }

  get options(): ResolvedHostOptions {
    return this.#options
  }

  async spawnAgent(definition: AgentDefinition): Promise<AgentSnapshot> {
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

  getAgent(agentId: string): AgentSnapshot | undefined {
    const handle = this.#runtime.agents.get(agentId)
    return handle ? agentSnapshot(handle) : undefined
  }

  getAgents(): AgentSnapshot[] {
    return Array.from(this.#runtime.agents.values(), agentSnapshot)
  }

  getSession(sessionId: string): SessionSnapshot | undefined {
    const session = this.#sessions.sessions.get(sessionId)
    return session ? sessionSnapshot(session) : undefined
  }

  getSessions(): SessionSnapshot[] {
    return Array.from(this.#sessions.sessions.values(), sessionSnapshot)
  }

  async createSession(
    agentId: string,
    params: { cwd: string; mcpServers?: McpServer[] },
  ): Promise<CreateSessionResult> {
    return this.#sessions.create(agentId, params)
  }

  async authenticate(agentId: string, methodId: string): Promise<void> {
    const { handle, conn } = this.#runtime.requireReady(agentId)
    await this.#runtime.track(handle, conn.authenticate({ methodId }))
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

  async resumeSession(sessionId: string): Promise<void> {
    await this.#sessions.resume(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#sessions.delete(sessionId)
  }

  async loadSession(
    agentId: string,
    sessionId: string,
    params: { cwd?: string; mcpServers?: McpServer[] } = {},
  ): Promise<void> {
    await loadSessionOp(this.#sessions, agentId, sessionId, params)
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

  async logout(agentId: string): Promise<void> {
    const { handle, conn } = this.#runtime.requireReady(agentId)
    requireCapability(
      capabilityEnabled(handle.capabilities?.auth?.logout),
      'logout',
    )
    await this.#runtime.track(handle, conn.logout({}))
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

  async restoreSessions(): Promise<SessionSnapshot[]> {
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
  }

  #createClient(): Client {
    const client: Client = {
      sessionUpdate: async (notification) => {
        this.#onSessionUpdate(notification)
      },
      requestPermission: (params) => {
        const session = this.#sessions.sessions.get(params.sessionId)
        if (!session) {
          return Promise.resolve({
            outcome: { outcome: 'cancelled' as const },
          })
        }
        return this.#router.handle(session, params)
      },
    }
    const { readTextFile, writeTextFile } = this.#fsHandler
    if (readTextFile) client.readTextFile = readTextFile.bind(this.#fsHandler)
    if (writeTextFile) {
      client.writeTextFile = writeTextFile.bind(this.#fsHandler)
    }
    const terminal = this.#terminalHandler
    const {
      createTerminal,
      terminalOutput,
      waitForTerminalExit,
      killTerminal,
      releaseTerminal,
    } = terminal
    if (
      createTerminal &&
      terminalOutput &&
      waitForTerminalExit &&
      killTerminal &&
      releaseTerminal
    ) {
      client.createTerminal = createTerminal.bind(terminal)
      client.terminalOutput = terminalOutput.bind(terminal)
      client.waitForTerminalExit = waitForTerminalExit.bind(terminal)
      client.killTerminal = killTerminal.bind(terminal)
      client.releaseTerminal = releaseTerminal.bind(terminal)
    }
    return client
  }

  #onSessionUpdate(notification: SessionNotification): void {
    const session = this.#sessions.sessions.get(notification.sessionId)
    if (!session || session.suppressUpdates) return
    const normalized = normalizeSessionUpdate(notification.update)
    this.#bus.emitSession(
      session,
      normalized.type,
      normalized.payload,
      normalized.extensions,
    )
  }
}

export function createAcpHost(options: HostOptions = {}): AcpHost {
  return new AcpHost(options)
}
