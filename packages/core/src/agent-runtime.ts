import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import { ACP_ERROR_CODES, type AgentExitReason } from '@acpjs/protocol'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ClientCapabilities,
} from '@agentclientprotocol/sdk'

import { AcpError } from './errors.ts'
import {
  requireReadyAgent,
  trackAgentPromise,
  type AgentHandle,
} from './internal.ts'

import type { EventBus } from './event-bus.ts'
import type { ResolvedAgentDefinition, ResolvedHostOptions } from './options.ts'

export interface AgentRuntimeDeps {
  options: ResolvedHostOptions
  bus: EventBus
  clientCapabilities: ClientCapabilities
  createClient: (handle: AgentHandle) => Client
  onAgentDown: (handle: AgentHandle) => void
  onAgentReady: (handle: AgentHandle) => void
  isHostDisposed: () => boolean
}

export class AgentRuntime {
  readonly agents = new Map<string, AgentHandle>()
  #deps: AgentRuntimeDeps
  #counter = 0

  constructor(deps: AgentRuntimeDeps) {
    this.#deps = deps
  }

  register(definition: ResolvedAgentDefinition): AgentHandle {
    this.#counter += 1
    const handle: AgentHandle = {
      agentId: `agent-${this.#counter}`,
      definition,
      status: 'spawning',
      restartCount: 0,
      exit: undefined,
      capabilities: undefined,
      authMethods: undefined,
      proc: undefined,
      conn: undefined,
      pendingRejects: new Set(),
      restartTimer: undefined,
      disposed: false,
    }
    this.agents.set(handle.agentId, handle)
    return handle
  }

  requireReady(agentId: string | undefined): {
    handle: AgentHandle
    conn: ClientSideConnection
  } {
    return requireReadyAgent(this.agents, agentId)
  }

  async track<T>(handle: AgentHandle, promise: Promise<T>): Promise<T> {
    return trackAgentPromise(handle, promise)
  }

  async start(handle: AgentHandle): Promise<void> {
    const { bus } = this.#deps
    this.#deps.bus.setAgentStatus(handle, 'spawning')
    const definition = handle.definition
    let proc: ChildProcess
    try {
      proc = spawn(definition.command, definition.args, {
        cwd: definition.cwd,
        env: { ...process.env, ...definition.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      await new Promise<void>((resolvePromise, rejectPromise) => {
        proc.once('spawn', () => resolvePromise())
        proc.once('error', rejectPromise)
      })
    } catch (error) {
      bus.diagnostic('error', 'agent/spawn-failed', {
        message: error instanceof Error ? error.message : String(error),
        agentId: handle.agentId,
      })
      this.#down(handle, 'spawn-failed')
      throw new AcpError(
        ACP_ERROR_CODES.agentExited,
        `agent ${handle.agentId} failed to spawn`,
      )
    }
    handle.proc = proc
    handle.exit = undefined
    bus.diagnostic('info', 'agent/spawn', {
      message: `spawned ${definition.command}`,
      agentId: handle.agentId,
      data: { pid: proc.pid, envKeys: Object.keys(definition.env ?? {}) },
    })
    proc.on('error', (error) => {
      bus.diagnostic('error', 'agent/process-error', {
        message: error.message,
        agentId: handle.agentId,
      })
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      bus.diagnostic('info', 'agent/stderr', {
        message: chunk.toString('utf8'),
        agentId: handle.agentId,
      })
    })
    proc.on('exit', (code, signal) => {
      if (handle.proc === proc) this.#onProcExit(handle, code, signal)
    })
    this.#deps.bus.setAgentStatus(handle, 'initializing')
    await this.#initialize(handle, proc)
    handle.restartCount = 0
    this.#deps.bus.setAgentStatus(handle, 'ready')
    this.#deps.onAgentReady(handle)
  }

  async #initialize(handle: AgentHandle, proc: ChildProcess): Promise<void> {
    const { bus } = this.#deps
    const stdin = proc.stdin
    const stdout = proc.stdout
    if (!stdin || !stdout) {
      proc.kill()
      this.#down(handle, 'initialize-failed')
      throw new AcpError(ACP_ERROR_CODES.agentExited, 'agent stdio unavailable')
    }
    const stream = ndJsonStream(
      Writable.toWeb(stdin),
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    )
    const conn = new ClientSideConnection(
      () => this.#deps.createClient(handle),
      stream,
    )
    handle.conn = conn
    try {
      const init = await this.track(
        handle,
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: '@acpjs/core', version: '0.0.0' },
          clientCapabilities: this.#deps.clientCapabilities,
        }),
      )
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new AcpError(
          ACP_ERROR_CODES.agentExited,
          `unsupported protocol version: ${init.protocolVersion}`,
        )
      }
      handle.capabilities = init.agentCapabilities
      handle.authMethods = init.authMethods
      bus.diagnostic('info', 'agent/initialized', {
        message: 'initialize handshake complete',
        agentId: handle.agentId,
      })
    } catch (error) {
      bus.diagnostic('error', 'agent/initialize-failed', {
        message: error instanceof Error ? error.message : String(error),
        agentId: handle.agentId,
      })
      if (handle.status === 'initializing') {
        proc.kill()
        this.#down(handle, 'initialize-failed')
      }
      throw error instanceof AcpError
        ? error
        : new AcpError(
            ACP_ERROR_CODES.agentExited,
            `agent ${handle.agentId} failed to initialize`,
          )
    }
  }

  #onProcExit(
    handle: AgentHandle,
    code: number | null,
    signal: string | null,
  ): void {
    handle.exit = {
      ...(code === null ? {} : { code }),
      ...(signal === null ? {} : { signal }),
    }
    handle.proc = undefined
    handle.conn = undefined
    this.#deps.bus.diagnostic('info', 'agent/exit', {
      message: 'agent process exited',
      agentId: handle.agentId,
      data: handle.exit,
    })
    for (const reject of handle.pendingRejects) reject()
    handle.pendingRejects.clear()
    if (handle.disposed || this.#deps.isHostDisposed()) {
      this.#deps.onAgentDown(handle)
      if (handle.status !== 'exited') {
        this.#deps.bus.setAgentStatus(handle, 'exited', 'disposed')
      }
      return
    }
    if (handle.status === 'ready') {
      this.#down(handle, 'crashed')
    } else if (handle.status === 'initializing') {
      this.#down(handle, 'initialize-failed')
    } else if (handle.status === 'spawning') {
      this.#down(handle, 'spawn-failed')
    }
  }

  #down(handle: AgentHandle, cause: AgentExitReason): void {
    const { options, bus } = this.#deps
    this.#deps.onAgentDown(handle)
    const inRestartCycle = cause === 'crashed' || handle.restartCount > 0
    if (
      options.restart === 'on-crash' &&
      inRestartCycle &&
      !handle.disposed &&
      !this.#deps.isHostDisposed()
    ) {
      if (handle.restartCount >= options.restartLimit) {
        bus.diagnostic('warn', 'agent/restart-exhausted', {
          message: `restart limit ${options.restartLimit} reached`,
          agentId: handle.agentId,
        })
        this.#deps.bus.setAgentStatus(handle, 'exited', 'restart-exhausted')
        return
      }
      const backoff = options.restartBackoff
      const delay = Math.min(
        backoff.initialMs * backoff.factor ** handle.restartCount,
        backoff.maxMs,
      )
      handle.restartCount += 1
      bus.diagnostic('info', 'agent/restart-scheduled', {
        message: `restart attempt ${handle.restartCount} in ${delay}ms`,
        agentId: handle.agentId,
        data: { attempt: handle.restartCount, delayMs: delay },
      })
      this.#deps.bus.setAgentStatus(handle, 'restarting')
      handle.restartTimer = setTimeout(() => {
        handle.restartTimer = undefined
        void this.start(handle).catch(() => undefined)
      }, delay)
      return
    }
    if (cause === 'crashed' && options.restart === 'never') {
      bus.diagnostic('info', 'agent/restart-suppressed', {
        message: 'restart policy is never',
        agentId: handle.agentId,
      })
    }
    this.#deps.bus.setAgentStatus(handle, 'exited', cause)
  }

  async dispose(handle: AgentHandle): Promise<void> {
    handle.disposed = true
    if (handle.restartTimer) {
      clearTimeout(handle.restartTimer)
      handle.restartTimer = undefined
    }
    const proc = handle.proc
    if (!proc) {
      if (handle.status !== 'exited') {
        this.#deps.onAgentDown(handle)
        this.#deps.bus.setAgentStatus(handle, 'exited', 'disposed')
      }
      return
    }
    const exited = new Promise<void>((resolvePromise) => {
      proc.once('exit', () => resolvePromise())
      if (proc.exitCode !== null || proc.signalCode !== null) resolvePromise()
    })
    proc.stdin?.end()
    const timedOut = await new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(
        () => resolvePromise(true),
        this.#deps.options.killTimeoutMs,
      )
      void exited.then(() => {
        clearTimeout(timer)
        resolvePromise(false)
      })
    })
    if (timedOut) {
      this.#deps.bus.diagnostic('warn', 'agent/kill', {
        message: 'kill timeout exceeded, sending SIGKILL',
        agentId: handle.agentId,
      })
      proc.kill('SIGKILL')
      await Promise.race([
        exited,
        new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, this.#deps.options.killTimeoutMs),
        ),
      ])
    }
  }
}
