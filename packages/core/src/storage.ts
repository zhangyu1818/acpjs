import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AcpjsEvent, AcpjsSessionEvent } from '@acpjs/protocol'
import type { McpServer } from '@agentclientprotocol/sdk'

export interface SessionMeta {
  sessionId: string
  agentDefinitionId?: string
  cwd: string
  mcpServers?: McpServer[]
  additionalDirectories: string[]
  title?: string | null
  updatedAt?: string | null
  lifecycle?: 'open' | 'closed' | 'deleted'
}

export interface StorageAdapter {
  appendEvent(event: AcpjsEvent): void | Promise<void>
  appendMeta(meta: SessionMeta): void | Promise<void>
  listSessions(): SessionMeta[] | Promise<SessionMeta[]>
  loadEvents(
    sessionId: string,
    fromSeq?: number,
  ): AcpjsSessionEvent[] | Promise<AcpjsSessionEvent[]>
  replaceSession(
    sessionId: string,
    meta: SessionMeta,
    events: AcpjsSessionEvent[],
  ): void | Promise<void>
}

function emptyMeta(sessionId: string): SessionMeta {
  return { sessionId, cwd: '', additionalDirectories: [], lifecycle: 'open' }
}

function isSessionEvent(event: unknown): event is AcpjsSessionEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof (event as { sessionId?: unknown }).sessionId === 'string'
  )
}

export function createMemoryStorage(): StorageAdapter {
  const logs = new Map<string, AcpjsSessionEvent[]>()
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
        (sessionId) => metas.get(sessionId) ?? emptyMeta(sessionId),
      )
    },
    loadEvents(sessionId, fromSeq = 0) {
      return (logs.get(sessionId) ?? []).filter((event) => event.seq > fromSeq)
    },
    replaceSession(sessionId, meta, events) {
      metas.set(sessionId, meta)
      logs.set(sessionId, [...events])
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
    const lines: unknown[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        lines.push(JSON.parse(line) as unknown)
      } catch {}
    }
    return lines
  }

  async function readEvents(): Promise<AcpjsEvent[]> {
    const lines = await readLines()
    return lines.filter((line): line is AcpjsEvent => !isMetaLine(line))
  }

  function enqueue(line: string): Promise<void> {
    const write = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const handle = await open(file, 'a')
      try {
        await handle.writeFile(line, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    queue = write.catch(() => undefined)
    return write
  }

  function enqueueReplaceSession(
    sessionId: string,
    meta: SessionMeta,
    events: AcpjsSessionEvent[],
  ): Promise<void> {
    const write = queue.then(async () => {
      const lines = await readLines()
      const kept = lines.filter(
        (line) =>
          !(isSessionEvent(line) && line.sessionId === sessionId) &&
          !(isMetaLine(line) && line.sessionId === sessionId),
      )
      const next = [
        ...kept,
        { kind: 'session-meta' as const, ...meta },
        ...events,
      ]
      const text = next.map((line) => JSON.stringify(line)).join('\n')
      await mkdir(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      const handle = await open(temp, 'w')
      try {
        await handle.writeFile(text.length === 0 ? '' : `${text}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temp, file)
      } catch (error) {
        await rm(temp, { force: true })
        throw error
      }
    })
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
      return [...seen].map(
        (sessionId) => metas.get(sessionId) ?? emptyMeta(sessionId),
      )
    },
    async loadEvents(sessionId, fromSeq = 0) {
      const events = await readEvents()
      return events.filter(
        (event): event is AcpjsSessionEvent =>
          isSessionEvent(event) &&
          event.sessionId === sessionId &&
          event.seq > fromSeq,
      )
    },
    replaceSession(sessionId, meta, events) {
      return enqueueReplaceSession(sessionId, meta, events)
    },
  }
}
