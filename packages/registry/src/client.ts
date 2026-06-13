import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { makeDefinition } from './definition.ts'
import { installBinary, installPaths } from './installer.ts'
import { parseIndex } from './parse.ts'
import { defaultCacheDir, probeExecutableOnPath } from './paths.ts'
import { platformKeyFor } from './platform.ts'
import {
  RegistryError,
  type AgentDefinition,
  type InstallArtifact,
  type RegistryEntry,
  type RegistryIndex,
} from './types.ts'

import type {
  DiagnosticEvent,
  DiagnosticPayload,
  InstallProgressEvent,
  InstallProgressPayload,
} from '@acpjs/protocol'

export type RegistryEvent = InstallProgressEvent | DiagnosticEvent

export type RegistryEventListener = (event: RegistryEvent) => void

export const DEFAULT_INDEX_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

export const DEFAULT_INDEX_TTL_MS = 3_600_000

export type FetchLike = (url: string) => Promise<Response>

export type PathProbe = (candidates: string[]) => Promise<string | undefined>

export interface RegistryClientOptions {
  cacheDir?: string
  fetch?: FetchLike
  indexUrl?: string
  indexTtlMs?: number
  now?: () => number
  platform?: string
  arch?: string
  pathProbe?: PathProbe
}

export interface EnsureInstalledOptions {
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface RegistryClient {
  getIndex(): Promise<RegistryIndex>
  getEntry(agentId: string): Promise<RegistryEntry | undefined>
  ensureInstalled(
    agentId: string,
    options?: EnsureInstalledOptions,
  ): Promise<AgentDefinition>
  getInstallArtifact(agentId: string): Promise<InstallArtifact | undefined>
  subscribe(listener: RegistryEventListener): () => void
}

interface CachedIndex {
  fetchedAt: number
  raw: unknown
}

export function createRegistryClient(
  options: RegistryClientOptions = {},
): RegistryClient {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const indexUrl = options.indexUrl ?? DEFAULT_INDEX_URL
  const indexTtlMs = options.indexTtlMs ?? DEFAULT_INDEX_TTL_MS
  const now = options.now ?? Date.now
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const indexCachePath = join(cacheDir, 'registry-index.json')
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const pathProbe = options.pathProbe ?? probeExecutableOnPath

  const listeners = new Set<RegistryEventListener>()
  let nextSeq = 1

  function subscribe(listener: RegistryEventListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function dispatch(event: RegistryEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        continue
      }
    }
  }

  function emitDiagnostic(payload: DiagnosticPayload): void {
    dispatch({ seq: nextSeq++, ts: now(), type: 'diagnostic', payload })
  }

  function emitProgress(
    agentId: string,
    payload: InstallProgressPayload,
  ): void {
    dispatch({
      agentId,
      seq: nextSeq++,
      ts: now(),
      type: 'install-progress',
      payload,
    })
  }

  async function readIndexCache(): Promise<CachedIndex | undefined> {
    try {
      const cached: unknown = JSON.parse(await readFile(indexCachePath, 'utf8'))
      if (
        typeof cached === 'object' &&
        cached !== null &&
        typeof (cached as CachedIndex).fetchedAt === 'number'
      ) {
        return cached as CachedIndex
      }
      return undefined
    } catch {
      return undefined
    }
  }

  async function writeIndexCache(raw: unknown): Promise<void> {
    await mkdir(cacheDir, { recursive: true })
    const cached: CachedIndex = { fetchedAt: now(), raw }
    await writeFile(indexCachePath, JSON.stringify(cached))
  }

  function toIndex(raw: unknown): RegistryIndex {
    const parsed = parseIndex(raw)
    for (const invalid of parsed.invalid) {
      emitDiagnostic({
        level: 'warn',
        code: 'registry/entry-invalid',
        message: `skipped unparseable registry entry ${invalid.id ?? '(unknown id)'}: ${invalid.reason}`,
        ...(invalid.id === undefined ? {} : { data: { id: invalid.id } }),
      })
    }
    return {
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
      entries: parsed.entries,
    }
  }

  async function getIndex(): Promise<RegistryIndex> {
    const cached = await readIndexCache()
    if (cached && now() - cached.fetchedAt < indexTtlMs) {
      return toIndex(cached.raw)
    }
    let failure: string
    try {
      const response = await fetchImpl(indexUrl)
      if (response.ok) {
        const raw: unknown = await response.json()
        const index = toIndex(raw)
        await writeIndexCache(raw)
        return index
      }
      failure = `registry index fetch failed with status ${response.status}`
    } catch (error) {
      failure = `registry index fetch failed: ${error instanceof Error ? error.message : String(error)}`
    }
    if (cached) {
      emitDiagnostic({
        level: 'warn',
        code: 'registry/index-stale-fallback',
        message: `${failure}; serving stale cached index`,
      })
      return toIndex(cached.raw)
    }
    throw new RegistryError('registry/index-unavailable', failure)
  }

  async function getEntry(agentId: string): Promise<RegistryEntry | undefined> {
    const index = await getIndex()
    return index.entries.find((entry) => entry.id === agentId)
  }

  async function ensureInstalled(
    agentId: string,
    installOptions: EnsureInstalledOptions = {},
  ): Promise<AgentDefinition> {
    emitProgress(agentId, { stage: 'resolving' })
    try {
      if (installOptions.command !== undefined) {
        const definition = makeDefinition(
          agentId,
          installOptions.command,
          installOptions.args ?? [],
          installOptions.env,
        )
        emitProgress(agentId, { stage: 'installed' })
        return definition
      }

      const entry = await getEntry(agentId)
      if (!entry) {
        throw new RegistryError(
          'registry/agent-not-found',
          `agent ${agentId} not found in the registry index`,
        )
      }

      const key = platformKeyFor(platform, arch)
      const binaryTarget = key ? entry.distribution.binary?.[key] : undefined
      const packageTarget = entry.distribution.npx ?? entry.distribution.uvx

      const candidates = [
        ...new Set(
          [
            binaryTarget ? basename(binaryTarget.cmd) : undefined,
            entry.id,
          ].filter((candidate): candidate is string => candidate !== undefined),
        ),
      ]
      const onPath = await pathProbe(candidates)
      if (onPath !== undefined) {
        const source = binaryTarget ?? packageTarget
        const definition = makeDefinition(
          agentId,
          onPath,
          source?.args ?? [],
          source?.env,
          entry,
        )
        emitProgress(agentId, { stage: 'installed' })
        return definition
      }

      const runner = entry.distribution.npx
        ? ('npx' as const)
        : entry.distribution.uvx
          ? ('uvx' as const)
          : undefined
      if (runner && packageTarget) {
        const definition = makeDefinition(
          agentId,
          runner,
          [packageTarget.package, ...(packageTarget.args ?? [])],
          packageTarget.env,
          entry,
        )
        emitProgress(agentId, { stage: 'installed' })
        return definition
      }

      if (entry.distribution.binary) {
        if (!key || !binaryTarget) {
          throw new RegistryError(
            'registry/platform-unsupported',
            `agent ${agentId} has no binary for platform ${platform}/${arch}`,
          )
        }
        return await installBinary(
          { cacheDir, fetchImpl, now, emitProgress },
          agentId,
          entry,
          key,
          binaryTarget,
        )
      }

      throw new RegistryError(
        'registry/no-distribution',
        `agent ${agentId} has no usable distribution`,
      )
    } catch (error) {
      emitProgress(agentId, {
        stage: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async function getInstallArtifact(
    agentId: string,
  ): Promise<InstallArtifact | undefined> {
    const entry = await getEntry(agentId)
    const key = platformKeyFor(platform, arch)
    if (!entry || !key) return undefined
    try {
      const { artifactPath } = installPaths(
        cacheDir,
        agentId,
        entry.version,
        key,
      )
      return JSON.parse(await readFile(artifactPath, 'utf8')) as InstallArtifact
    } catch {
      return undefined
    }
  }

  return { getIndex, getEntry, ensureInstalled, getInstallArtifact, subscribe }
}
