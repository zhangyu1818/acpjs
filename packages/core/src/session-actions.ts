import {
  ACPJS_ERROR_CODES,
  type PromptFinishedPayload,
  type SessionConfigValue,
} from '@acpjs/protocol'
import {
  methods,
  type ContentBlock,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk'

import { AcpError } from './errors.ts'
import { requireCapability } from './session-config.ts'

import type { SessionHandle } from './internal.ts'
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
  delete session.clientPromptEchoes
  delete session.promptCancellationRequested
  if (canCommitPrompt(manager, session)) {
    manager.bus.emitSession(session, 'prompt-finished', payload)
    manager.bus.setSessionStatus(session, 'active')
  }
  return structuredClone(payload)
}

function restorePromptAfterFailure(
  manager: SessionManager,
  session: SessionHandle,
): void {
  delete session.clientPromptEchoes
  delete session.promptCancellationRequested
  if (canCommitPrompt(manager, session)) {
    manager.bus.setSessionStatus(session, 'active')
  }
}

function wasPromptCancellationRequested(session: SessionHandle): boolean {
  return session.promptCancellationRequested === true
}

function emitClientPrompt(
  manager: SessionManager,
  session: SessionHandle,
  prompt: ContentBlock[],
): void {
  if (prompt.length === 0) return
  const messageId = `acpjs-client-prompt-${session.nextSeq}`
  const content = structuredClone(prompt)
  session.clientPromptEchoes = [{ remaining: content }]
  for (const block of content) {
    manager.bus.emitSession(
      session,
      'user-message-chunk',
      { content: block, messageId },
      { acpjs: { source: 'client-prompt' } },
    )
  }
}

export async function promptManagedSession(
  manager: SessionManager,
  sessionId: string,
  prompt: ContentBlock[],
): Promise<PromptFinishedPayload> {
  const session = manager.require(sessionId)
  if (session.status === 'prompting') {
    throw new AcpError(
      ACPJS_ERROR_CODES.promptInFlight,
      `session ${sessionId} already has a prompt in flight`,
    )
  }
  if (session.lifecycleOperation !== undefined) {
    throw new AcpError(
      ACPJS_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
  if (session.status !== 'active') {
    throw new AcpError(
      ACPJS_ERROR_CODES.sessionClosed,
      `session ${sessionId} is not active`,
    )
  }
  const { handle, conn } = manager.runtime.requireReady(session.agentId)
  delete session.promptCancellationRequested
  manager.bus.setSessionStatus(session, 'prompting')
  emitClientPrompt(manager, session, prompt)
  let payload: PromptFinishedPayload
  try {
    const response = await manager.runtime.track(
      handle,
      conn.agent.request(methods.agent.session.prompt, { sessionId, prompt }),
    )
    payload = {
      stopReason: wasPromptCancellationRequested(session)
        ? 'cancelled'
        : response.stopReason,
      ...(response.usage == null ? {} : { usage: response.usage }),
    }
  } catch (error) {
    if (error instanceof AcpError) throw error
    restorePromptAfterFailure(manager, session)
    throw error
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
      ACPJS_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
  const { handle, conn } = manager.runtime.requireReady(session.agentId)
  if (session.status === 'prompting') {
    session.promptCancellationRequested = true
  }
  try {
    await manager.runtime.track(
      handle,
      conn.agent.notify(methods.agent.session.cancel, { sessionId }),
    )
  } finally {
    manager.router.supersedeForSession(sessionId)
  }
}

export async function setManagedSessionMode(
  manager: SessionManager,
  sessionId: string,
  modeId: string,
): Promise<void> {
  const session = manager.require(sessionId)
  if (session.lifecycleOperation !== undefined) {
    throw new AcpError(
      ACPJS_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
  const { handle, conn } = manager.runtime.requireReady(session.agentId)
  requireCapability(session.hasModes, 'session/set_mode')
  await manager.runtime.track(
    handle,
    conn.agent.request(methods.agent.session.setMode, { sessionId, modeId }),
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
      ACPJS_ERROR_CODES.configInvalid,
      `session ${sessionId} lifecycle operation in progress`,
    )
  }
  const { handle, conn } = manager.runtime.requireReady(session.agentId)
  requireCapability(session.hasConfigOptions, 'session/set_config_option')
  const response = await manager.runtime.track(
    handle,
    conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      ...value,
    }),
  )
  manager.bus.emitSession(session, 'config-options-update', {
    configOptions: response.configOptions,
  })
  return response.configOptions
}
