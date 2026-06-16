import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import { RequestError } from '@agentclientprotocol/sdk'

import type { FsHandler } from './options.ts'

type RootResolver = (sessionId: string) => readonly string[] | undefined

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function realRoots(
  roots: readonly string[] | undefined,
): Promise<string[]> {
  if (roots === undefined) throw new Error('unknown session roots')
  return Promise.all(roots.map((root) => realpath(resolve(root))))
}

function requireRealPathInRoots(path: string, roots: readonly string[]): void {
  if (!roots.some((root) => isInsideRoot(path, root))) {
    throw RequestError.invalidParams(
      { path },
      `path outside session roots: ${path}`,
    )
  }
}

async function requireReadablePath(
  path: string,
  roots: readonly string[] | undefined,
): Promise<string> {
  if (!isAbsolute(path)) {
    throw RequestError.invalidParams(
      { path },
      `fs path must be absolute: ${path}`,
    )
  }
  const resolved = await realpath(resolve(path))
  requireRealPathInRoots(resolved, await realRoots(roots))
  return resolved
}

async function requireWritablePath(
  path: string,
  roots: readonly string[] | undefined,
): Promise<string> {
  if (!isAbsolute(path)) {
    throw RequestError.invalidParams(
      { path },
      `fs path must be absolute: ${path}`,
    )
  }
  const allowedRoots = await realRoots(roots)
  try {
    const resolved = await realpath(resolve(path))
    requireRealPathInRoots(resolved, allowedRoots)
    return resolved
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = await realpath(dirname(resolve(path)))
  const resolved = resolve(parent, basename(path))
  requireRealPathInRoots(resolved, allowedRoots)
  return resolved
}

export function createDefaultFsHandler(
  rootsForSession: RootResolver = () => undefined,
): Required<FsHandler> {
  return {
    async readTextFile(params) {
      const path = await requireReadablePath(
        params.path,
        rootsForSession(params.sessionId),
      )
      const text = await readFile(path, 'utf8')
      if (params.line == null && params.limit == null) {
        return { content: text }
      }
      const lines = text.split('\n')
      const start = (params.line ?? 1) - 1
      const selected =
        params.limit == null
          ? lines.slice(start)
          : lines.slice(start, start + params.limit)
      return { content: selected.join('\n') }
    },
    async writeTextFile(params) {
      const path = await requireWritablePath(
        params.path,
        rootsForSession(params.sessionId),
      )
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW,
        0o666,
      )
      try {
        await handle.writeFile(params.content, 'utf8')
      } finally {
        await handle.close()
      }
      return {}
    },
  }
}
