import type { PermissionListener, PermissionRequest } from './types.ts'

export interface PermissionRegistry {
  getSnapshot: () => readonly PermissionRequest[]
  subscribe: (listener: PermissionListener) => () => void
  add: (request: PermissionRequest) => void
  prune: (requestId: string) => void
  reset: () => void
  clear: () => void
}

export function createPermissionRegistry(): PermissionRegistry {
  const pending = new Map<string, PermissionRequest>()
  const listeners = new Set<PermissionListener>()
  let snapshot: readonly PermissionRequest[] = Object.freeze([])

  function publish(): void {
    snapshot = Object.freeze([...pending.values()])
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {}
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    add(request) {
      pending.set(request.requestId, request)
      publish()
    },
    prune(requestId) {
      if (pending.delete(requestId)) publish()
    },
    reset() {
      if (pending.size === 0) return
      pending.clear()
      publish()
    },
    clear() {
      pending.clear()
      publish()
      listeners.clear()
    },
  }
}
