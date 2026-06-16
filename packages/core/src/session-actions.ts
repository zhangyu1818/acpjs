import {
  ACP_ERROR_CODES,
  type PromptFinishedPayload,
  type SessionConfigValue,
} from '@acpjs/protocol'

import { AcpError } from './errors.ts'
import { protocolErrorInfo, type SessionHandle } from './internal.ts'
import { requireCapability } from './session-config.ts'

import type {
  ContentBlock,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'

import type { SessionManager } from './session-manager.ts'

function canCommitPrompt(
  manager: SessionManager,
  session: SessionHandle,
): boolean {
  return (
    manager.sessions.get(session.sessionId) === session &&
    session.status === 'prompting' &&
    session.lifecycleOperation === undefined
  )
}

function finishPrompt(
  manager: SessionManager,
  session: SessionHandle,
  payload: PromptFinishedPayload,
): PromptFinishedPayload {
  if (canCommitPrompt(manager, session)) {
    manager.bus.emitSession(session, 'prompt-finished', payload)
    manager.bus.setSessionStatus(session, 'active')
  }
  return structuredClone(payload)
}

export async function promptManagedSession(
  manager: SessionManager,
  sessionId: string,
  prompt: ContentBlock[],
): Promise<PromptFinishedPayload> {
  const session = manager.require(sessionId)
  if (session.status === 'prompting') {
    throw new AcpError(
      ACP_ERROR_CODES.promptInFlight,
      `session ${sessionId} already has a prompt in flight`,
    )
  }
  if (session.lifecycleOperation !== undefined) {
    throw new AcpError(
      ACP_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
  if (session.status !== 'active') {
    throw new AcpError(
      ACP_ERROR_CODES.sessionClosed,
      `session ${sessionId} is not active`,
    )
  }
  const { handle, conn } = manager.runtime.requireReady(session.agentId)
  manager.bus.setSessionStatus(session, 'prompting')
  let payload: PromptFinishedPayload
  try {
    const response = await manager.runtime.track(
      handle,
      conn.prompt({ sessionId, prompt }),
    )
    payload = {
      stopReason: response.stopReason,
      ...(response.usage == null ? {} : { usage: response.usage }),
    }
  } catch (error) {
    if (error instanceof AcpError) throw error
    const info = protocolErrorInfo(error)
    if (info === undefined) {
      if (canCommitPrompt(manager, session)) {
        manager.bus.setSessionStatus(session, 'active')
      }
      throw error
    }
    payload = { stopReason: 'end_turn', error: info }
    return finishPrompt(manager, session, payload)
  }
  return finishPrompt(manager, session, payload)
}

export async function cancelManagedSession(
  manager: SessionManager,
  sessionId: string,
): Promise<void> {
  const session = manager.require(sessionId)
  if (session.lifecycleOperation !== undefined) {
    throw new AcpError(
      ACP_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
  const { handle, conn } = manager.runtime.requireReady(session.agentId)
  manager.router.supersedeForSession(sessionId)
  await manager.runtime.track(handle, conn.cancel({ sessionId }))
}

export async function setManagedSessionMode(
  manager: SessionManager,
  sessionId: string,
  modeId: string,
): Promise<void> {
  const session = manager.require(sessionId)
  if (session.lifecycleOperation !== undefined) {
    throw new AcpError(
      ACP_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
  const { handle, conn } = manager.runtime.requireReady(session.agentId)
  requireCapability(session.hasModes, 'session/set_mode')
  await manager.runtime.track(
    handle,
    conn.setSessionMode({ sessionId, modeId }),
  )
  manager.bus.emitSession(session, 'current-mode-update', {
    currentModeId: modeId,
  })
}

export async function setManagedSessionConfigOption(
  manager: SessionManager,
  sessionId: string,
  configId: string,
  value: SessionConfigValue,
): Promise<SessionConfigOption[]> {
  const session = manager.require(sessionId)
  if (session.lifecycleOperation !== undefined) {
    throw new AcpError(
      ACP_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
  const { handle, conn } = manager.runtime.requireReady(session.agentId)
  requireCapability(session.hasConfigOptions, 'session/set_config_option')
  const response = await manager.runtime.track(
    handle,
    conn.setSessionConfigOption({ sessionId, configId, ...value }),
  )
  manager.bus.emitSession(session, 'config-options-update', {
    configOptions: response.configOptions,
  })
  return response.configOptions
}
