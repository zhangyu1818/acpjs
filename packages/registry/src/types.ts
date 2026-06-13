export interface PackageDistribution {
  package: string
  args?: string[]
  env?: Record<string, string>
}

export interface BinaryTarget {
  archive: string
  cmd: string
  args?: string[]
  env?: Record<string, string>
}

export type PlatformKey =
  | 'darwin-aarch64'
  | 'darwin-x86_64'
  | 'linux-aarch64'
  | 'linux-x86_64'
  | 'windows-aarch64'
  | 'windows-x86_64'

export interface RegistryDistribution {
  npx?: PackageDistribution
  uvx?: PackageDistribution
  binary?: Partial<Record<PlatformKey, BinaryTarget>>
}

export interface RegistryEntry {
  id: string
  name: string
  version: string
  description: string
  distribution: RegistryDistribution
  authors?: string[]
  license?: string
  icon?: string
  repository?: string
  website?: string
}

export interface RegistryIndex {
  version?: string
  entries: RegistryEntry[]
}

export interface AgentDefinition {
  id: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  meta?: Record<string, unknown>
}

export interface InstallArtifact {
  agentId: string
  version: string
  platform: PlatformKey
  executablePath: string
  installedAt: number
}

export type RegistryErrorCode =
  | 'registry/index-unavailable'
  | 'registry/index-invalid'
  | 'registry/agent-not-found'
  | 'registry/no-distribution'
  | 'registry/platform-unsupported'
  | 'registry/unsupported-archive'
  | 'registry/download-failed'
  | 'registry/install-failed'

export class RegistryError extends Error {
  readonly code: RegistryErrorCode

  constructor(code: RegistryErrorCode, message: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}
