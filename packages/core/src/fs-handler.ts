import { readFile, writeFile } from 'node:fs/promises'

import type { FsHandler } from './options.ts'

export function createDefaultFsHandler(): Required<FsHandler> {
  return {
    async readTextFile(params) {
      const text = await readFile(params.path, 'utf8')
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
      await writeFile(params.path, params.content, 'utf8')
      return {}
    },
  }
}
