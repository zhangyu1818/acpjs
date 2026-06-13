import type { ChangeListener } from './types.ts'

export type RpcCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>

export function notifyChange(listeners: ReadonlySet<ChangeListener>): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {}
  }
}
