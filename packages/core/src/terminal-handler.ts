import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { truncateUtf8Tail, type TerminalOutputPayload } from '@acpjs/protocol'
import { RequestError } from '@agentclientprotocol/sdk'

import type { TerminalHandler } from './options.ts'

interface TerminalState {
  sessionId: string
  terminalId: string
  proc: ChildProcess
  output: string
  truncated: boolean
  limit: number | undefined
  released: boolean
  exit: { exitCode: number | null; signal: string | null } | undefined
  exited: Promise<{ exitCode: number | null; signal: string | null }>
}

function truncateToLimit(state: TerminalState): void {
  if (state.limit === undefined) return
  const result = truncateUtf8Tail(state.output, state.limit)
  state.output = result.output
  if (result.truncated) state.truncated = true
}

function exitStatus(exit: { exitCode: number | null; signal: string | null }): {
  exitCode?: number
  signal?: string
} {
  return {
    ...(exit.exitCode === null ? {} : { exitCode: exit.exitCode }),
    ...(exit.signal === null ? {} : { signal: exit.signal }),
  }
}

export function createDefaultTerminalHandler(
  emit?: (sessionId: string, payload: TerminalOutputPayload) => void,
): Required<TerminalHandler> {
  const terminals = new Map<string, TerminalState>()

  function requireTerminal(
    sessionId: string,
    terminalId: string,
  ): TerminalState {
    const state = terminals.get(terminalId)
    if (!state) {
      throw RequestError.invalidParams(
        { terminalId },
        `unknown terminal: ${terminalId}`,
      )
    }
    if (state.sessionId !== sessionId) {
      throw RequestError.invalidParams(
        { terminalId, sessionId },
        `terminal ${terminalId} belongs to another session`,
      )
    }
    return state
  }

  return {
    async createTerminal(params) {
      const terminalId = randomUUID()
      const env = { ...process.env }
      for (const variable of params.env ?? []) {
        env[variable.name] = variable.value
      }
      const proc = spawn(params.command, params.args ?? [], {
        ...(params.cwd == null ? {} : { cwd: params.cwd }),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const state: TerminalState = {
        sessionId: params.sessionId,
        terminalId,
        proc,
        output: '',
        truncated: false,
        limit: params.outputByteLimit ?? undefined,
        released: false,
        exit: undefined,
        exited: new Promise((resolvePromise) => {
          proc.once('exit', (exitCode, signal) => {
            state.exit = { exitCode, signal }
            if (!state.released) {
              emit?.(params.sessionId, {
                terminalId,
                exit: exitStatus(state.exit),
              })
            }
            resolvePromise(state.exit)
          })
        }),
      }
      const append = (chunk: Buffer) => {
        state.output += chunk.toString('utf8')
        truncateToLimit(state)
        if (state.released) return
        emit?.(params.sessionId, {
          terminalId,
          delta: chunk.toString('utf8'),
          ...(state.truncated ? { truncated: true } : {}),
        })
      }
      proc.stdout.on('data', append)
      proc.stderr.on('data', append)
      terminals.set(terminalId, state)
      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          proc.once('spawn', () => resolvePromise())
          proc.once('error', rejectPromise)
        })
      } catch (error) {
        terminals.delete(terminalId)
        throw error
      }
      return { terminalId }
    },
    async terminalOutput(params) {
      const state = requireTerminal(params.sessionId, params.terminalId)
      return {
        output: state.output,
        truncated: state.truncated,
        ...(state.exit ? { exitStatus: exitStatus(state.exit) } : {}),
      }
    },
    async waitForTerminalExit(params) {
      const state = requireTerminal(params.sessionId, params.terminalId)
      const exit = await state.exited
      return exitStatus(exit)
    },
    async killTerminal(params) {
      const state = requireTerminal(params.sessionId, params.terminalId)
      if (state.exit === undefined) state.proc.kill('SIGKILL')
      return {}
    },
    async releaseTerminal(params) {
      const state = requireTerminal(params.sessionId, params.terminalId)
      state.released = true
      if (state.exit === undefined) state.proc.kill('SIGKILL')
      terminals.delete(params.terminalId)
      return {}
    },
    cleanupSession(sessionId) {
      for (const [terminalId, state] of terminals) {
        if (state.sessionId !== sessionId) continue
        state.released = true
        if (state.exit === undefined) state.proc.kill('SIGKILL')
        terminals.delete(terminalId)
      }
    },
  }
}
