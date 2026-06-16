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
  cleanupSession?(sessionId: string): void
}

export interface HostOptions {
  restart?: 'never' | 'on-crash'
  restartLimit?: number
  restartBackoff?: RestartBackoff
  storage?: StorageAdapter
  fs?: FsHandler
  terminal?: TerminalHandler
  killTimeoutMs?: number
}

export interface ResolvedHostOptions {
  restart: 'never' | 'on-crash'
  restartLimit: number
  restartBackoff: RestartBackoff
  storage: StorageAdapter
  fs?: FsHandler
  terminal?: TerminalHandler
  killTimeoutMs: number
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
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
  const killTimeoutMs = candidate.killTimeoutMs ?? 5000
  if (!isPositiveNumber(killTimeoutMs)) {
    throw configInvalid('invalid killTimeoutMs')
  }
  const storage = raw.storage ?? createMemoryStorage()
  if (
    typeof storage.appendEvent !== 'function' ||
    typeof storage.appendMeta !== 'function' ||
    typeof storage.listSessions !== 'function' ||
    typeof storage.loadEvents !== 'function' ||
    typeof storage.replaceSession !== 'function'
  ) {
    throw configInvalid('invalid storage adapter')
  }
  if (raw.fs !== undefined) {
    if (!isObject(raw.fs)) throw configInvalid('invalid fs handler')
    const fsHandler = raw.fs
    if (
      (fsHandler['readTextFile'] !== undefined &&
        !isFunction(fsHandler['readTextFile'])) ||
      (fsHandler['writeTextFile'] !== undefined &&
        !isFunction(fsHandler['writeTextFile']))
    ) {
      throw configInvalid('invalid fs handler')
    }
  }
  if (raw.terminal !== undefined) {
    if (!isObject(raw.terminal)) throw configInvalid('invalid terminal handler')
    const terminalHandler = raw.terminal
    if (
      (terminalHandler['createTerminal'] !== undefined &&
        !isFunction(terminalHandler['createTerminal'])) ||
      (terminalHandler['terminalOutput'] !== undefined &&
        !isFunction(terminalHandler['terminalOutput'])) ||
      (terminalHandler['waitForTerminalExit'] !== undefined &&
        !isFunction(terminalHandler['waitForTerminalExit'])) ||
      (terminalHandler['killTerminal'] !== undefined &&
        !isFunction(terminalHandler['killTerminal'])) ||
      (terminalHandler['releaseTerminal'] !== undefined &&
        !isFunction(terminalHandler['releaseTerminal'])) ||
      (terminalHandler['cleanupSession'] !== undefined &&
        !isFunction(terminalHandler['cleanupSession']))
    ) {
      throw configInvalid('invalid terminal handler')
    }
    const terminalMethodCount = [
      terminalHandler['createTerminal'],
      terminalHandler['terminalOutput'],
      terminalHandler['waitForTerminalExit'],
      terminalHandler['killTerminal'],
      terminalHandler['releaseTerminal'],
    ].filter(isFunction).length
    if (terminalMethodCount > 0 && terminalMethodCount < 5) {
      throw configInvalid(
        'terminal handler must implement every terminal method',
      )
    }
    if (
      terminalMethodCount === 5 &&
      !isFunction(terminalHandler['cleanupSession'])
    ) {
      throw configInvalid('terminal handler must implement cleanupSession')
    }
  }
  const resolved: ResolvedHostOptions = {
    restart,
    restartLimit,
    restartBackoff: Object.freeze({
      initialMs: restartBackoff.initialMs,
      factor: restartBackoff.factor,
      maxMs: restartBackoff.maxMs,
    }),
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
