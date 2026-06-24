import { expect, test } from 'vitest'

import {
  ACPJS_ERROR_CODES,
  ACPJS_HOST_METHODS,
  isAcpjsErrorCode,
  type SessionSnapshot,
} from './index'

test('error codes form the closed acpjs host-contract namespace', () => {
  expect(ACPJS_ERROR_CODES).toEqual({
    configInvalid: 'acpjs/config-invalid',
    promptInFlight: 'acpjs/prompt-in-flight',
    alreadyAnswered: 'acpjs/already-answered',
    sessionClosed: 'acpjs/session-closed',
    agentExited: 'acpjs/agent-exited',
    capabilityUnsupported: 'acpjs/capability-unsupported',
    agentError: 'acpjs/agent-error',
    transportClosed: 'acpjs/transport-closed',
  })
  expect(Object.isFrozen(ACPJS_ERROR_CODES)).toBe(true)
})

test('host method names form the host contract shared by core and client', () => {
  expect(ACPJS_HOST_METHODS).toEqual({
    spawnAgent: 'agents/spawn',
    createSession: 'sessions/create',
    loadSession: 'sessions/load',
    listSessions: 'sessions/list',
    resumeSession: 'sessions/resume',
    deleteSession: 'sessions/delete',
    prompt: 'sessions/prompt',
    cancel: 'sessions/cancel',
    closeSession: 'sessions/close',
    setMode: 'sessions/setMode',
    setConfigOption: 'sessions/setConfigOption',
    getAllSessions: 'sessions/getAll',
    restoreSessions: 'sessions/restore',
    listAgents: 'agents/list',
    disposeAgent: 'agents/dispose',
  })
  expect(Object.isFrozen(ACPJS_HOST_METHODS)).toBe(true)
})

test('a session snapshot carries the full session projection shape', () => {
  const minimal = {
    sessionId: 'sess-1',
    status: 'disconnected',
    cwd: '',
    additionalDirectories: [],
  } satisfies SessionSnapshot
  const full = {
    sessionId: 'sess-2',
    status: 'active',
    agentId: 'agent-1',
    cwd: '/workspace',
    mcpServers: [],
    additionalDirectories: ['/extra'],
    agentDefinitionId: 'claude-code',
  } satisfies SessionSnapshot
  expect(minimal).toEqual({
    sessionId: 'sess-1',
    status: 'disconnected',
    cwd: '',
    additionalDirectories: [],
  })
  expect(full.agentId).toBe('agent-1')
  expect(full.cwd).toBe('/workspace')
  expect(full.agentDefinitionId).toBe('claude-code')
})

test('isAcpjsErrorCode accepts only codes from the closed namespace', () => {
  expect(isAcpjsErrorCode('acpjs/prompt-in-flight')).toBe(true)
  expect(isAcpjsErrorCode('acpjs/unknown-code')).toBe(false)
  expect(isAcpjsErrorCode('config-invalid')).toBe(false)
})
