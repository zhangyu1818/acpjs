import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  archiveFormatFor,
  extractTar,
  extractZip,
  resolveCommandPath,
} from './archive.ts'
import { makeDefinition } from './definition.ts'
import {
  RegistryError,
  type AgentDefinition,
  type BinaryTarget,
  type InstallArtifact,
  type PlatformKey,
  type RegistryEntry,
} from './types.ts'

import type { InstallProgressPayload } from '@acpjs/protocol'

export interface InstallerDeps {
  cacheDir: string
  fetchImpl: (url: string) => Promise<Response>
  now: () => number
  emitProgress: (agentId: string, payload: InstallProgressPayload) => void
  maxDownloadBytes?: number
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function installPaths(
  cacheDir: string,
  agentId: string,
  version: string,
  key: PlatformKey,
): { installDir: string; contentsDir: string; artifactPath: string } {
  const installDir = join(cacheDir, 'agents', agentId, version, key)
  return {
    installDir,
    contentsDir: join(installDir, 'contents'),
    artifactPath: join(installDir, 'artifact.json'),
  }
}

async function download(
  deps: InstallerDeps,
  archiveUrl: string,
  agentId: string,
  stageMeta: { version: string; platform: PlatformKey },
): Promise<Buffer> {
  let response: Response
  try {
    response = await deps.fetchImpl(archiveUrl)
  } catch (error) {
    throw new RegistryError(
      'registry/download-failed',
      `download failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) {
    throw new RegistryError(
      'registry/download-failed',
      `download failed with status ${response.status}`,
    )
  }
  const maxBytes = deps.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
  const totalRaw = Number(response.headers.get('content-length'))
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : undefined
  const body = response.body
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      throw new RegistryError(
        'registry/download-failed',
        `download exceeds maximum size of ${maxBytes} bytes`,
      )
    }
    return buffer
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value.length === 0) continue
    chunks.push(value)
    received += value.length
    if (received > maxBytes) {
      await reader.cancel()
      throw new RegistryError(
        'registry/download-failed',
        `download exceeds maximum size of ${maxBytes} bytes`,
      )
    }
    deps.emitProgress(agentId, {
      stage: 'downloading',
      ...stageMeta,
      downloadedBytes: received,
      ...(total === undefined ? {} : { totalBytes: total }),
    })
  }
  return Buffer.concat(chunks)
}

export async function installBinary(
  deps: InstallerDeps,
  agentId: string,
  entry: RegistryEntry,
  key: PlatformKey,
  target: BinaryTarget,
): Promise<AgentDefinition> {
  const stageMeta = { version: entry.version, platform: key }
  const { installDir, contentsDir, artifactPath } = installPaths(
    deps.cacheDir,
    agentId,
    entry.version,
    key,
  )
  const executablePath = resolveCommandPath(contentsDir, target.cmd)
  const definition = makeDefinition(
    agentId,
    executablePath,
    target.args ?? [],
    target.env,
    entry,
  )

  if ((await pathExists(artifactPath)) && (await pathExists(executablePath))) {
    deps.emitProgress(agentId, { stage: 'cache-hit', ...stageMeta })
    deps.emitProgress(agentId, { stage: 'installed', ...stageMeta })
    return definition
  }

  const format = archiveFormatFor(target.archive)
  if (format === 'unsupported') {
    throw new RegistryError(
      'registry/unsupported-archive',
      `archive format is not supported: ${target.archive}`,
    )
  }

  try {
    deps.emitProgress(agentId, { stage: 'downloading', ...stageMeta })
    const buffer = await download(deps, target.archive, agentId, stageMeta)
    await mkdir(contentsDir, { recursive: true })
    if (format === 'raw') {
      await mkdir(dirname(executablePath), { recursive: true })
      await writeFile(executablePath, buffer)
    } else if (format === 'tar') {
      const archivePath = join(installDir, 'download.archive')
      await writeFile(archivePath, buffer)
      deps.emitProgress(agentId, { stage: 'extracting', ...stageMeta })
      await extractTar(archivePath, contentsDir)
      await rm(archivePath, { force: true })
    } else {
      deps.emitProgress(agentId, { stage: 'extracting', ...stageMeta })
      await extractZip(buffer, contentsDir)
    }
    if (!(await pathExists(executablePath))) {
      throw new RegistryError(
        'registry/install-failed',
        `extracted archive does not contain cmd ${target.cmd}`,
      )
    }
    await chmod(executablePath, 0o755)
    const artifact: InstallArtifact = {
      agentId,
      version: entry.version,
      platform: key,
      executablePath,
      installedAt: deps.now(),
    }
    await writeFile(artifactPath, JSON.stringify(artifact))
    deps.emitProgress(agentId, { stage: 'installed', ...stageMeta })
    return definition
  } catch (error) {
    await rm(installDir, { recursive: true, force: true })
    throw error
  }
}
