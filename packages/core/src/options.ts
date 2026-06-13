import { resolve } from 'node:path'

import { configInvalid } from './errors.ts'
import { createMemoryStorage, type StorageAdapter } from './storage.ts'

import type { AgentDefinition } from '@acpjs/protocol'
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  ToolKind,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'

export type { AgentDefinition }

export interface ResolvedAgentDefinition {
  id: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd: string
  meta?: Record<string, unknown>
}

export interface RestartBackoff {
  initialMs: number
  factor: number
  maxMs: number
}

export type PermissionPolicyAction = 'allow' | 'reject' | 'ask'

export interface PermissionPolicyRule {
  kind?: ToolKind
  action: PermissionPolicyAction
}

export interface FsHandler {
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>
}

export interface TerminalHandler {
  createTerminal?(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse>
  terminalOutput?(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse>
  waitForTerminalExit?(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse>
  killTerminal?(params: KillTerminalRequest): Promise<KillTerminalResponse>
  releaseTerminal?(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse>
}

export interface HostOptions {
  restart?: 'never' | 'on-crash'
  restartLimit?: number
  restartBackoff?: RestartBackoff
  permissionPolicy?: PermissionPolicyRule[]
  storage?: StorageAdapter
  fs?: FsHandler
  terminal?: TerminalHandler
  killTimeoutMs?: number
}

export interface ResolvedHostOptions {
  restart: 'never' | 'on-crash'
  restartLimit: number
  restartBackoff: RestartBackoff
  permissionPolicy: readonly PermissionPolicyRule[]
  storage: StorageAdapter
  fs?: FsHandler
  terminal?: TerminalHandler
  killTimeoutMs: number
}

const POLICY_ACTIONS: ReadonlySet<string> = new Set(['allow', 'reject', 'ask'])

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isPolicyRule(value: unknown): value is PermissionPolicyRule {
  if (typeof value !== 'object' || value === null) return false
  const rule = value as { action?: unknown; kind?: unknown }
  return (
    typeof rule.action === 'string' &&
    POLICY_ACTIONS.has(rule.action) &&
    (rule.kind === undefined || typeof rule.kind === 'string')
  )
}

export function resolveHostOptions(raw: HostOptions = {}): ResolvedHostOptions {
  const candidate = raw as { [K in keyof HostOptions]?: unknown }
  const restart = candidate.restart ?? 'never'
  if (restart !== 'never' && restart !== 'on-crash') {
    throw configInvalid('invalid restart mode')
  }
  const restartLimit = candidate.restartLimit ?? 3
  if (
    typeof restartLimit !== 'number' ||
    !Number.isInteger(restartLimit) ||
    restartLimit < 0
  ) {
    throw configInvalid('invalid restartLimit')
  }
  const restartBackoff = (candidate.restartBackoff ?? {
    initialMs: 1000,
    factor: 2,
    maxMs: 30_000,
  }) as { [K in keyof RestartBackoff]?: unknown }
  if (
    !isPositiveNumber(restartBackoff.initialMs) ||
    !isPositiveNumber(restartBackoff.maxMs) ||
    typeof restartBackoff.factor !== 'number' ||
    restartBackoff.factor < 1
  ) {
    throw configInvalid('invalid restartBackoff')
  }
  const permissionPolicy = candidate.permissionPolicy ?? []
  if (!Array.isArray(permissionPolicy)) {
    throw configInvalid('permissionPolicy must be an array')
  }
  for (const rule of permissionPolicy) {
    if (!isPolicyRule(rule)) {
      throw configInvalid('invalid permissionPolicy rule')
    }
  }
  const killTimeoutMs = candidate.killTimeoutMs ?? 5000
  if (!isPositiveNumber(killTimeoutMs)) {
    throw configInvalid('invalid killTimeoutMs')
  }
  const storage = raw.storage ?? createMemoryStorage()
  if (
    typeof storage.appendEvent !== 'function' ||
    typeof storage.appendMeta !== 'function' ||
    typeof storage.listSessions !== 'function' ||
    typeof storage.loadEvents !== 'function'
  ) {
    throw configInvalid('invalid storage adapter')
  }
  const resolved: ResolvedHostOptions = {
    restart,
    restartLimit,
    restartBackoff: Object.freeze({
      initialMs: restartBackoff.initialMs,
      factor: restartBackoff.factor,
      maxMs: restartBackoff.maxMs,
    }),
    permissionPolicy: Object.freeze(
      (permissionPolicy as PermissionPolicyRule[]).map((rule) =>
        Object.freeze({ ...rule }),
      ),
    ),
    storage,
    ...(raw.fs ? { fs: raw.fs } : {}),
    ...(raw.terminal ? { terminal: raw.terminal } : {}),
    killTimeoutMs,
  }
  return Object.freeze(resolved)
}

export function resolveAgentDefinition(
  raw: AgentDefinition,
): ResolvedAgentDefinition {
  const candidate = raw as { [K in keyof AgentDefinition]?: unknown } | null
  if (typeof candidate !== 'object' || candidate === null) {
    throw configInvalid('agent definition must be an object')
  }
  const { id, command, cwd } = candidate
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw configInvalid('agent definition id must be a non-empty string')
  }
  if (typeof command !== 'string' || command.length === 0) {
    throw configInvalid('agent definition command must be a non-empty string')
  }
  const args = candidate.args ?? []
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw configInvalid('agent definition args must be a string array')
  }
  const env = candidate.env
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null) {
      throw configInvalid('agent definition env must be a string map')
    }
    for (const value of Object.values(env)) {
      if (typeof value !== 'string') {
        throw configInvalid('agent definition env must be a string map')
      }
    }
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw configInvalid('agent definition cwd must be a string')
  }
  const meta = candidate.meta
  if (meta !== undefined && (typeof meta !== 'object' || meta === null)) {
    throw configInvalid('agent definition meta must be an object')
  }
  const resolved: ResolvedAgentDefinition = {
    id,
    command,
    args: Object.freeze([...(args as string[])]) as string[],
    ...(env
      ? { env: Object.freeze({ ...env }) as Record<string, string> }
      : {}),
    cwd: resolve(cwd ?? process.cwd()),
    ...(meta
      ? { meta: Object.freeze({ ...meta }) as Record<string, unknown> }
      : {}),
  }
  return Object.freeze(resolved)
}
