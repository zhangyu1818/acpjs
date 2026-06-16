import type { AgentSnapshotWire, SessionSnapshotWire } from '@acpjs/protocol'

import type { AgentHandle, SessionHandle } from './internal.ts'

function capabilitiesSnapshot(
  handle: AgentHandle,
): AgentSnapshotWire['capabilities'] | undefined {
  const capabilities = handle.capabilities
  if (capabilities === undefined) return undefined
  return {
    ...(capabilities.loadSession === undefined
      ? {}
      : { loadSession: capabilities.loadSession }),
    ...(capabilities.mcpCapabilities === undefined
      ? {}
      : { mcpCapabilities: capabilities.mcpCapabilities }),
    ...(capabilities.nes === undefined ? {} : { nes: capabilities.nes }),
    ...(capabilities.positionEncoding === undefined
      ? {}
      : { positionEncoding: capabilities.positionEncoding }),
    ...(capabilities.promptCapabilities === undefined
      ? {}
      : { promptCapabilities: capabilities.promptCapabilities }),
    ...(capabilities.sessionCapabilities === undefined
      ? {}
      : { sessionCapabilities: capabilities.sessionCapabilities }),
  }
}

export function agentSnapshot(handle: AgentHandle): AgentSnapshotWire {
  const capabilities = capabilitiesSnapshot(handle)
  return structuredClone({
    agentId: handle.agentId,
    status: handle.status,
    restartCount: handle.restartCount,
    ...(handle.reason ? { reason: handle.reason } : {}),
    ...(handle.exit ? { exit: handle.exit } : {}),
    ...(capabilities ? { capabilities } : {}),
  })
}

export function sessionSnapshot(session: SessionHandle): SessionSnapshotWire {
  return {
    sessionId: session.sessionId,
    status: session.status,
    ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
    cwd: session.cwd,
    ...(session.mcpServers === undefined
      ? {}
      : { mcpServers: session.mcpServers }),
    additionalDirectories: session.additionalDirectories,
    ...(session.agentDefinitionId === undefined
      ? {}
      : { agentDefinitionId: session.agentDefinitionId }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.updatedAt === undefined
      ? {}
      : { updatedAt: session.updatedAt }),
  }
}
