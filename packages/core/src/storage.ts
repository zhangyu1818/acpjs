import { appendFile, readFile } from 'node:fs/promises'

import type { AcpEvent, AcpSessionEvent } from '@acpjs/protocol'

export interface SessionMeta {
  sessionId: string
  agentDefinitionId?: string
  cwd?: string
}

export interface StorageAdapter {
  appendEvent(event: AcpEvent): void | Promise<void>
  appendMeta(meta: SessionMeta): void | Promise<void>
  listSessions(): SessionMeta[] | Promise<SessionMeta[]>
  loadEvents(
    sessionId: string,
    fromSeq?: number,
  ): AcpEvent[] | Promise<AcpEvent[]>
}

function isSessionEvent(event: unknown): event is AcpSessionEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof (event as { sessionId?: unknown }).sessionId === 'string'
  )
}

export function createMemoryStorage(): StorageAdapter {
  const logs = new Map<string, AcpSessionEvent[]>()
  const metas = new Map<string, SessionMeta>()
  return {
    appendEvent(event) {
      if (!isSessionEvent(event)) return
      const log = logs.get(event.sessionId)
      if (log) {
        log.push(event)
      } else {
        logs.set(event.sessionId, [event])
      }
    },
    appendMeta(meta) {
      metas.set(meta.sessionId, meta)
    },
    listSessions() {
      const sessionIds = new Set([...logs.keys(), ...metas.keys()])
      return [...sessionIds].map(
        (sessionId) => metas.get(sessionId) ?? { sessionId },
      )
    },
    loadEvents(sessionId, fromSeq = 0) {
      return (logs.get(sessionId) ?? []).filter((event) => event.seq > fromSeq)
    },
  }
}

interface MetaLine extends SessionMeta {
  kind: 'session-meta'
}

function isMetaLine(line: unknown): line is MetaLine {
  return (
    typeof line === 'object' &&
    line !== null &&
    'kind' in line &&
    line.kind === 'session-meta'
  )
}

export function createJsonlStorage(file: string): StorageAdapter {
  let queue: Promise<unknown> = Promise.resolve()

  async function readLines(): Promise<unknown[]> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return text
      .split('\n')
      .filter((line) => line.length !== 0)
      .map((line) => JSON.parse(line) as unknown)
  }

  async function readEvents(): Promise<AcpEvent[]> {
    const lines = await readLines()
    return lines.filter((line): line is AcpEvent => !isMetaLine(line))
  }

  function enqueue(line: string): Promise<void> {
    const write = queue.then(() => appendFile(file, line))
    queue = write.catch(() => undefined)
    return write
  }

  return {
    appendEvent(event) {
      return enqueue(`${JSON.stringify(event)}\n`)
    },
    appendMeta(meta) {
      return enqueue(`${JSON.stringify({ kind: 'session-meta', ...meta })}\n`)
    },
    async listSessions() {
      const metas = new Map<string, SessionMeta>()
      const seen = new Set<string>()
      for (const line of await readLines()) {
        if (isMetaLine(line)) {
          const { kind: _kind, ...meta } = line
          metas.set(meta.sessionId, meta)
          seen.add(meta.sessionId)
        } else if (isSessionEvent(line)) {
          seen.add(line.sessionId)
        }
      }
      return [...seen].map((sessionId) => metas.get(sessionId) ?? { sessionId })
    },
    async loadEvents(sessionId, fromSeq = 0) {
      const events = await readEvents()
      return events.filter(
        (event) =>
          isSessionEvent(event) &&
          event.sessionId === sessionId &&
          event.seq > fromSeq,
      )
    },
  }
}
