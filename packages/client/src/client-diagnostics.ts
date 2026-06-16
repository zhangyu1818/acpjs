import type { DiagnosticEvent } from '@acpjs/protocol'

import type { ChangeListener } from './types.ts'

export const MAX_DIAGNOSTICS = 200

export interface DiagnosticsLog {
  getSnapshot: () => readonly DiagnosticEvent[]
  subscribe: (listener: ChangeListener) => () => void
  push: (event: DiagnosticEvent) => void
  clear: () => void
}

export function createDiagnosticsLog(): DiagnosticsLog {
  const entries: DiagnosticEvent[] = []
  const listeners = new Set<ChangeListener>()
  let snapshot: readonly DiagnosticEvent[] = Object.freeze([])

  function publish(): void {
    snapshot = Object.freeze([...entries])
    for (const listener of listeners) {
      try {
        listener()
      } catch {}
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    push(event) {
      entries.push(event)
      if (entries.length > MAX_DIAGNOSTICS) {
        entries.splice(0, entries.length - MAX_DIAGNOSTICS)
      }
      publish()
    },
    clear() {
      entries.length = 0
      publish()
      listeners.clear()
    },
  }
}
