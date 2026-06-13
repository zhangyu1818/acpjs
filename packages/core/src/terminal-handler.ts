import { spawn, type ChildProcess } from 'node:child_process'

import { truncateUtf8Tail, type TerminalOutputPayload } from '@acpjs/protocol'

import type { TerminalHandler } from './options.ts'

interface TerminalState {
  proc: ChildProcess
  output: string
  truncated: boolean
  limit: number | undefined
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
  let counter = 0

  function requireTerminal(terminalId: string): TerminalState {
    const state = terminals.get(terminalId)
    if (!state) throw new Error(`unknown terminal: ${terminalId}`)
    return state
  }

  return {
    async createTerminal(params) {
      counter += 1
      const terminalId = `term-${counter}`
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
        proc,
        output: '',
        truncated: false,
        limit: params.outputByteLimit ?? undefined,
        exit: undefined,
        exited: new Promise((resolvePromise) => {
          proc.once('error', () => {
            state.exit = { exitCode: -1, signal: null }
            emit?.(params.sessionId, {
              terminalId,
              exit: exitStatus(state.exit),
            })
            resolvePromise(state.exit)
          })
          proc.once('exit', (exitCode, signal) => {
            state.exit = { exitCode, signal }
            emit?.(params.sessionId, {
              terminalId,
              exit: exitStatus(state.exit),
            })
            resolvePromise(state.exit)
          })
        }),
      }
      const append = (chunk: Buffer) => {
        state.output += chunk.toString('utf8')
        truncateToLimit(state)
        emit?.(params.sessionId, {
          terminalId,
          delta: chunk.toString('utf8'),
          ...(state.truncated ? { truncated: true } : {}),
        })
      }
      proc.stdout.on('data', append)
      proc.stderr.on('data', append)
      terminals.set(terminalId, state)
      return { terminalId }
    },
    async terminalOutput(params) {
      const state = requireTerminal(params.terminalId)
      return {
        output: state.output,
        truncated: state.truncated,
        ...(state.exit ? { exitStatus: exitStatus(state.exit) } : {}),
      }
    },
    async waitForTerminalExit(params) {
      const state = requireTerminal(params.terminalId)
      const exit = await state.exited
      return exitStatus(exit)
    },
    async killTerminal(params) {
      const state = requireTerminal(params.terminalId)
      if (state.exit === undefined) state.proc.kill('SIGKILL')
      return {}
    },
    async releaseTerminal(params) {
      const state = requireTerminal(params.terminalId)
      if (state.exit === undefined) state.proc.kill('SIGKILL')
      terminals.delete(params.terminalId)
      return {}
    },
  }
}
