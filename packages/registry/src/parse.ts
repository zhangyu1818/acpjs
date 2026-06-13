import {
  RegistryError,
  type BinaryTarget,
  type PackageDistribution,
  type PlatformKey,
  type RegistryDistribution,
  type RegistryEntry,
} from './types.ts'

const PLATFORM_KEYS: readonly PlatformKey[] = [
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-aarch64',
  'linux-x86_64',
  'windows-aarch64',
  'windows-x86_64',
]

export interface ParsedIndex {
  version?: string
  entries: RegistryEntry[]
  invalid: { id?: string; reason: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length !== 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

function parsePackageDistribution(
  value: unknown,
): PackageDistribution | undefined {
  if (!isRecord(value) || !isNonEmptyString(value['package'])) return undefined
  const result: PackageDistribution = { package: value['package'] }
  if (isStringArray(value['args'])) result.args = value['args']
  if (isStringRecord(value['env'])) result.env = value['env']
  return result
}

function parseBinaryTarget(value: unknown): BinaryTarget | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value['archive']) ||
    !isNonEmptyString(value['cmd'])
  ) {
    return undefined
  }
  const result: BinaryTarget = {
    archive: value['archive'],
    cmd: value['cmd'],
  }
  if (isStringArray(value['args'])) result.args = value['args']
  if (isStringRecord(value['env'])) result.env = value['env']
  return result
}

function parseDistribution(value: unknown): RegistryDistribution | undefined {
  if (!isRecord(value)) return undefined
  const result: RegistryDistribution = {}
  for (const key of ['npx', 'uvx'] as const) {
    if (value[key] === undefined) continue
    const parsed = parsePackageDistribution(value[key])
    if (!parsed) return undefined
    result[key] = parsed
  }
  if (value['binary'] !== undefined) {
    if (!isRecord(value['binary'])) return undefined
    const binary: Partial<Record<PlatformKey, BinaryTarget>> = {}
    let count = 0
    for (const key of PLATFORM_KEYS) {
      const raw = value['binary'][key]
      if (raw === undefined) continue
      const parsed = parseBinaryTarget(raw)
      if (!parsed) return undefined
      binary[key] = parsed
      count += 1
    }
    if (count === 0) return undefined
    result.binary = binary
  }
  if (!result.npx && !result.uvx && !result.binary) return undefined
  return result
}

export function parseEntry(value: unknown): RegistryEntry | undefined {
  if (!isRecord(value)) return undefined
  if (
    !isNonEmptyString(value['id']) ||
    !isNonEmptyString(value['name']) ||
    !isNonEmptyString(value['version']) ||
    !isNonEmptyString(value['description'])
  ) {
    return undefined
  }
  const distribution = parseDistribution(value['distribution'])
  if (!distribution) return undefined
  const entry: RegistryEntry = {
    id: value['id'],
    name: value['name'],
    version: value['version'],
    description: value['description'],
    distribution,
  }
  if (isStringArray(value['authors'])) entry.authors = value['authors']
  if (isNonEmptyString(value['license'])) entry.license = value['license']
  if (isNonEmptyString(value['icon'])) entry.icon = value['icon']
  if (isNonEmptyString(value['repository'])) {
    entry.repository = value['repository']
  }
  if (isNonEmptyString(value['website'])) entry.website = value['website']
  return entry
}

export function parseIndex(raw: unknown): ParsedIndex {
  if (!isRecord(raw) || !Array.isArray(raw['agents'])) {
    throw new RegistryError(
      'registry/index-invalid',
      'registry index is not an object with an agents array',
    )
  }
  const result: ParsedIndex = { entries: [], invalid: [] }
  if (isNonEmptyString(raw['version'])) result.version = raw['version']
  for (const item of raw['agents']) {
    const entry = parseEntry(item)
    if (entry) {
      result.entries.push(entry)
    } else {
      const id =
        isRecord(item) && isNonEmptyString(item['id']) ? item['id'] : undefined
      result.invalid.push({
        ...(id === undefined ? {} : { id }),
        reason: 'entry does not match the agent schema',
      })
    }
  }
  return result
}
