import type { PlatformKey } from './types.ts'

const OS_MAP: Record<string, string> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
}

const ARCH_MAP: Record<string, string> = {
  arm64: 'aarch64',
  x64: 'x86_64',
}

export function platformKeyFor(
  platform: string,
  arch: string,
): PlatformKey | undefined {
  const os = OS_MAP[platform]
  const cpu = ARCH_MAP[arch]
  if (os === undefined || cpu === undefined) return undefined
  return `${os}-${cpu}` as PlatformKey
}
