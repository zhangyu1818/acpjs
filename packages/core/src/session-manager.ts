import { resolve } from 'node:path'

import {
  ACP_ERROR_CODES,
  type CreateSessionResult,
  type PromptFinishedPayload,
  type SessionConfigValue,
} from '@acpjs/protocol'

import { AcpError } from './errors.ts'
import {
  capabilityEnabled,
  protocolErrorInfo,
  type SessionHandle,
} from './internal.ts'

import type {
  ContentBlock,
  McpServer,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'

import type { AgentRuntime } from './agent-runtime.ts'
import type { EventBus } from './event-bus.ts'
import type { PermissionRouter } from './permission-router.ts'

export type { CreateSessionResult, SessionConfigValue }

export function requireCapability(enabled: boolean, capability: string): void {
  if (!enabled) {
    throw new AcpError(
      ACP_ERROR_CODES.capabilityUnsupported,
      `agent does not support ${capability}`,
    )
  }
}

export class SessionManager {
  readonly sessions = new Map<string, SessionHandle>()
  readonly bus: EventBus
  readonly runtime: AgentRuntime
  readonly router: PermissionRouter

  constructor(bus: EventBus, runtime: AgentRuntime, router: PermissionRouter) {
    this.bus = bus
    this.runtime = runtime
    this.router = router
  }

  require(sessionId: string): SessionHandle {
    const session = this.sessions.get(sessionId)
    if (!session || session.status === 'closed') {
      throw new AcpError(
        ACP_ERROR_CODES.sessionClosed,
        `session ${sessionId} is closed or unknown`,
      )
    }
    return session
  }

  disconnectForAgent(agentId: string): void {
    for (const session of this.sessions.values()) {
      if (
        session.agentId === agentId &&
        session.status !== 'closed' &&
        session.status !== 'disconnected'
      ) {
        this.bus.setSessionStatus(session, 'disconnected')
      }
    }
  }

  async create(
    agentId: string,
    params: { cwd: string; mcpServers?: McpServer[] },
  ): Promise<CreateSessionResult> {
    const { handle, conn } = this.runtime.requireReady(agentId)
    const cwd = resolve(params.cwd)
    const mcpServers = params.mcpServers ?? []
    let response
    try {
      response = await this.runtime.track(
        handle,
        conn.newSession({ cwd, mcpServers }),
      )
    } catch (error) {
      if (protocolErrorInfo(error)?.code === -32000) {
        const authMethods = handle.authMethods ?? []
        this.bus.emitAuthRequired(agentId, authMethods)
        return {
          status: 'auth-required',
          authMethods,
        }
      }
      throw error
    }
    const session: SessionHandle = {
      sessionId: response.sessionId,
      agentId,
      status: 'creating',
      cwd,
      mcpServers,
      log: [],
      nextSeq: 1,
      hasModes: response.modes != null,
      hasConfigOptions: response.configOptions != null,
      suppressUpdates: false,
      subscribers: new Set(),
    }
    session.agentDefinitionId = handle.definition.id
    this.sessions.set(session.sessionId, session)
    this.bus.emitConfigInit(session, response, true)
    this.bus.setSessionStatus(session, 'active')
    this.bus.appendMeta({
      sessionId: session.sessionId,
      agentDefinitionId: handle.definition.id,
      cwd,
    })
    this.bus.emitSessionLifecycle('session-created', {
      sessionId: session.sessionId,
      agentId,
      cwd,
      status: 'active',
    })
    return { status: 'active', sessionId: session.sessionId }
  }

  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptFinishedPayload> {
    const session = this.require(sessionId)
    const { handle, conn } = this.runtime.requireReady(session.agentId)
    if (session.status === 'prompting') {
      throw new AcpError(
        ACP_ERROR_CODES.promptInFlight,
        `session ${sessionId} already has a prompt in flight`,
      )
    }
    this.bus.setSessionStatus(session, 'prompting')
    let payload: PromptFinishedPayload
    try {
      const response = await this.runtime.track(
        handle,
        conn.prompt({ sessionId, prompt }),
      )
      payload = {
        stopReason: response.stopReason,
        ...(response.usage == null ? {} : { usage: response.usage }),
      }
    } catch (error) {
      if (session.status === 'disconnected' || error instanceof AcpError) {
        throw error instanceof AcpError
          ? error
          : new AcpError(ACP_ERROR_CODES.agentExited, 'agent exited mid-prompt')
      }
      const info = protocolErrorInfo(error)
      if (info === undefined) {
        this.bus.setSessionStatus(session, 'active')
        throw error
      }
      payload = { stopReason: 'end_turn', error: info }
      this.bus.emitSession(session, 'prompt-finished', payload)
      if (info.code === -32000) {
        this.bus.setSessionStatus(session, 'auth-required', {
          authMethods: handle.authMethods ?? [],
        })
      } else {
        this.bus.setSessionStatus(session, 'active')
      }
      return structuredClone(payload)
    }
    this.bus.emitSession(session, 'prompt-finished', payload)
    this.bus.setSessionStatus(session, 'active')
    return structuredClone(payload)
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.require(sessionId)
    const { conn } = this.runtime.requireReady(session.agentId)
    this.router.supersedeForSession(sessionId)
    await conn.cancel({ sessionId })
  }

  async close(sessionId: string): Promise<void> {
    const session = this.require(sessionId)
    const handle = session.agentId
      ? this.runtime.agents.get(session.agentId)
      : undefined
    if (
      handle?.status === 'ready' &&
      handle.conn &&
      capabilityEnabled(handle.capabilities?.sessionCapabilities?.close)
    ) {
      await this.runtime.track(handle, handle.conn.closeSession({ sessionId }))
    }
    this.router.supersedeForSession(sessionId)
    this.bus.setSessionStatus(session, 'closed')
    this.bus.emitSessionLifecycle('session-closed', {
      sessionId,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      status: 'closed',
    })
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.require(sessionId)
    const { handle, conn } = this.runtime.requireReady(session.agentId)
    requireCapability(
      capabilityEnabled(handle.capabilities?.sessionCapabilities?.resume),
      'session/resume',
    )
    const response = await this.runtime.track(
      handle,
      conn.resumeSession({
        sessionId,
        cwd: session.cwd,
        mcpServers: session.mcpServers,
      }),
    )
    this.bus.emitConfigInit(session, response, false)
    this.bus.setSessionStatus(session, 'active', { resumed: true })
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.require(sessionId)
    const { handle, conn } = this.runtime.requireReady(session.agentId)
    requireCapability(
      capabilityEnabled(handle.capabilities?.sessionCapabilities?.delete),
      'session/delete',
    )
    await this.runtime.track(handle, conn.deleteSession({ sessionId }))
    this.router.supersedeForSession(sessionId)
    this.bus.setSessionStatus(session, 'closed')
    this.bus.emitSessionLifecycle('session-closed', {
      sessionId,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      status: 'closed',
    })
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const session = this.require(sessionId)
    const { handle, conn } = this.runtime.requireReady(session.agentId)
    requireCapability(session.hasModes, 'session/set_mode')
    await this.runtime.track(handle, conn.setSessionMode({ sessionId, modeId }))
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: SessionConfigValue,
  ): Promise<SessionConfigOption[]> {
    const session = this.require(sessionId)
    const { handle, conn } = this.runtime.requireReady(session.agentId)
    requireCapability(session.hasConfigOptions, 'session/set_config_option')
    const response = await this.runtime.track(
      handle,
      conn.setSessionConfigOption({ sessionId, configId, ...value }),
    )
    this.bus.emitSession(session, 'config-options-update', {
      configOptions: response.configOptions,
    })
    return response.configOptions
  }
}
