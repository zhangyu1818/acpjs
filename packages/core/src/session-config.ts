import { resolve } from 'node:path'

import {
  ACP_ERROR_CODES,
  type CreateOrLoadSessionParams,
  type ResumeSessionParams,
} from '@acpjs/protocol'

import { AcpError } from './errors.ts'
import {
  capabilityEnabled,
  type AgentHandle,
  type SessionHandle,
} from './internal.ts'

import type { McpServer } from '@agentclientprotocol/sdk'

import type { SessionMeta } from './storage.ts'

export function requireCapability(enabled: boolean, capability: string): void {
  if (!enabled) {
    throw new AcpError(
      ACP_ERROR_CODES.capabilityUnsupported,
      `agent does not support ${capability}`,
    )
  }
}

function configInvalid(message: string, data?: unknown): AcpError {
  return new AcpError(ACP_ERROR_CODES.configInvalid, message, { data })
}

function requireStringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw configInvalid(`${name} must be a string array`)
  }
  return value
}

function normalizeCwd(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw configInvalid('cwd must be a non-empty string')
  }
  return resolve(value)
}

function normalizeAdditionalDirectories(value: unknown): string[] {
  return requireStringArray(value, 'additionalDirectories').map((entry) =>
    resolve(entry),
  )
}

function normalizeMcpServers(
  value: unknown,
  required: boolean,
): McpServer[] | undefined {
  if (value === undefined && !required) return undefined
  if (!Array.isArray(value)) {
    throw configInvalid('mcpServers must be an array')
  }
  return value as McpServer[]
}

export function normalizeCreateOrLoadSessionParams(
  params: CreateOrLoadSessionParams,
): CreateOrLoadSessionParams {
  return {
    cwd: normalizeCwd(params.cwd),
    mcpServers: normalizeMcpServers(params.mcpServers, true) ?? [],
    additionalDirectories: normalizeAdditionalDirectories(
      params.additionalDirectories,
    ),
  }
}

export function normalizeResumeSessionParams(
  params: ResumeSessionParams,
): ResumeSessionParams {
  const mcpServers = normalizeMcpServers(params.mcpServers, false)
  const base = {
    cwd: normalizeCwd(params.cwd),
    additionalDirectories: normalizeAdditionalDirectories(
      params.additionalDirectories,
    ),
  }
  if (mcpServers === undefined) return base
  return {
    ...base,
    mcpServers,
  }
}

export function additionalDirectoryParams(
  handle: AgentHandle,
  additionalDirectories: string[],
): { additionalDirectories?: string[] } {
  const enabled = capabilityEnabled(
    handle.capabilities?.sessionCapabilities?.additionalDirectories,
  )
  if (!enabled) {
    if (additionalDirectories.length !== 0) {
      requireCapability(false, 'session/additionalDirectories')
    }
    return {}
  }
  return { additionalDirectories }
}

export function applyConfigCapabilities(
  session: SessionHandle,
  response: { modes?: unknown; configOptions?: unknown },
): void {
  if (response.configOptions != null) {
    session.hasConfigOptions = true
    session.hasModes = false
  } else if (response.modes != null && !session.hasConfigOptions) {
    session.hasModes = true
  }
}

export function sessionMeta(
  session: SessionHandle,
  lifecycle?: SessionMeta['lifecycle'],
): SessionMeta {
  const effectiveLifecycle =
    lifecycle ??
    (session.status === 'deleted'
      ? 'deleted'
      : session.status === 'closed'
        ? 'closed'
        : 'open')
  return {
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
    lifecycle: effectiveLifecycle,
  }
}

export function deletedSessionMeta(sessionId: string): SessionMeta {
  return {
    sessionId,
    cwd: '',
    additionalDirectories: [],
    lifecycle: 'deleted' as const,
  }
}

export function sameAgentOrUnknown(
  session: SessionHandle,
  agentId: string,
): boolean {
  return session.agentId === undefined || session.agentId === agentId
}
