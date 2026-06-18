import { expect, test } from 'vitest'

import {
  ACP_ERROR_CODES,
  ACPJS_HOST_RPC_METHODS,
  isAcpErrorCode,
  type SessionSnapshotWire,
} from './index'

test('error codes form the closed acpjs/* namespace required by the spec', () => {
  expect(ACP_ERROR_CODES).toEqual({
    configInvalid: 'acpjs/config-invalid',
    promptInFlight: 'acpjs/prompt-in-flight',
    alreadyAnswered: 'acpjs/already-answered',
    sessionClosed: 'acpjs/session-closed',
    agentExited: 'acpjs/agent-exited',
    capabilityUnsupported: 'acpjs/capability-unsupported',
    agentError: 'acpjs/agent-error',
    transportClosed: 'acpjs/transport-closed',
  })
  expect(Object.isFrozen(ACP_ERROR_CODES)).toBe(true)
})

test('rpc method names form the single wire contract shared by core and client', () => {
  expect(ACPJS_HOST_RPC_METHODS).toEqual({
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
  expect(Object.isFrozen(ACPJS_HOST_RPC_METHODS)).toBe(true)
})

test('a session snapshot wire object carries the full session projection shape', () => {
  const minimal = {
    sessionId: 'sess-1',
    status: 'disconnected',
    cwd: '',
    additionalDirectories: [],
  } satisfies SessionSnapshotWire
  const full = {
    sessionId: 'sess-2',
    status: 'active',
    agentId: 'agent-1',
    cwd: '/workspace',
    mcpServers: [],
    additionalDirectories: ['/extra'],
    agentDefinitionId: 'claude-code',
  } satisfies SessionSnapshotWire
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

test('isAcpErrorCode accepts only codes from the closed namespace', () => {
  expect(isAcpErrorCode('acpjs/prompt-in-flight')).toBe(true)
  expect(isAcpErrorCode('acpjs/unknown-code')).toBe(false)
  expect(isAcpErrorCode('config-invalid')).toBe(false)
})
