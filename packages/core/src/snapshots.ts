import type { AgentSnapshotWire, SessionSnapshotWire } from '@acpjs/protocol'

import type { AgentHandle, SessionHandle } from './internal.ts'

export type AgentSnapshot = AgentSnapshotWire

export type SessionSnapshot = SessionSnapshotWire

export function agentSnapshot(handle: AgentHandle): AgentSnapshot {
  return structuredClone({
    agentId: handle.agentId,
    status: handle.status,
    restartCount: handle.restartCount,
    ...(handle.reason ? { reason: handle.reason } : {}),
    ...(handle.exit ? { exit: handle.exit } : {}),
    ...(handle.capabilities ? { capabilities: handle.capabilities } : {}),
    ...(handle.authMethods ? { authMethods: handle.authMethods } : {}),
  })
}

export function sessionSnapshot(session: SessionHandle): SessionSnapshot {
  return {
    sessionId: session.sessionId,
    status: session.status,
    ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
    ...(session.cwd === '' ? {} : { cwd: session.cwd }),
    ...(session.agentDefinitionId === undefined
      ? {}
      : { agentDefinitionId: session.agentDefinitionId }),
  }
}
