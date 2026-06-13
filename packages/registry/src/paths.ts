import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export function defaultCacheDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'acpjs')
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA']
    if (localAppData) return join(localAppData, 'acpjs', 'Cache')
    return join(homedir(), 'AppData', 'Local', 'acpjs', 'Cache')
  }
  const xdgCacheHome = process.env['XDG_CACHE_HOME']
  if (xdgCacheHome) return join(xdgCacheHome, 'acpjs')
  return join(homedir(), '.cache', 'acpjs')
}

export async function probeExecutableOnPath(
  candidates: string[],
): Promise<string | undefined> {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']
  for (const candidate of candidates) {
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        const candidatePath = join(dir, candidate + suffix)
        try {
          await access(candidatePath, constants.X_OK)
          return candidatePath
        } catch {
          continue
        }
      }
    }
  }
  return undefined
}
