import type { AgentDefinition, RegistryEntry } from './types.ts'

function entryMeta(entry: RegistryEntry): Record<string, unknown> {
  return {
    name: entry.name,
    version: entry.version,
    registryId: entry.id,
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
  }
}

export function makeDefinition(
  agentId: string,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  entry?: RegistryEntry,
): AgentDefinition {
  return {
    id: agentId,
    command,
    args,
    ...(env === undefined ? {} : { env }),
    ...(entry === undefined ? {} : { meta: entryMeta(entry) }),
  }
}
