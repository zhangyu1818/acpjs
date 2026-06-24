import {
  methods,
  RequestError,
  type AgentContext,
} from '@agentclientprotocol/sdk'

import type { FixtureStep } from './scenario.ts'

export interface FixtureStepIo {
  disconnect: () => void
  exit: (code: number) => never
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

export async function performFixtureStep(
  client: AgentContext,
  step: FixtureStep,
  sessionId: string,
  signal: AbortSignal,
  io: FixtureStepIo,
): Promise<unknown> {
  switch (step.kind) {
    case 'update': {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: step.update,
      })
      return undefined
    }
    case 'permission': {
      const response = await client.request(
        methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: step.toolCall,
          options: step.options,
        },
      )
      return response.outcome
    }
    case 'exit': {
      return io.exit(step.code)
    }
    case 'sleep': {
      await sleep(step.ms, signal)
      return undefined
    }
    case 'disconnect': {
      io.disconnect()
      return undefined
    }
    case 'readTextFile': {
      await client.request(methods.client.fs.readTextFile, {
        sessionId,
        path: step.path,
        ...(step.line === undefined ? {} : { line: step.line }),
        ...(step.limit === undefined ? {} : { limit: step.limit }),
      })
      return undefined
    }
    case 'writeTextFile': {
      await client.request(methods.client.fs.writeTextFile, {
        sessionId,
        path: step.path,
        content: step.content,
      })
      return undefined
    }
    case 'terminal': {
      const terminal = await client.request(methods.client.terminal.create, {
        sessionId,
        command: step.command,
        ...(step.args ? { args: step.args } : {}),
        ...(step.env ? { env: step.env } : {}),
        ...(step.cwd ? { cwd: step.cwd } : {}),
        ...(step.outputByteLimit === undefined
          ? {}
          : { outputByteLimit: step.outputByteLimit }),
      })
      for (const action of step.actions ?? []) {
        if (action === 'output') {
          await client.request(methods.client.terminal.output, {
            sessionId,
            terminalId: terminal.terminalId,
          })
        } else if (action === 'waitForExit') {
          await client.request(methods.client.terminal.waitForExit, {
            sessionId,
            terminalId: terminal.terminalId,
          })
        } else if (action === 'kill') {
          await client.request(methods.client.terminal.kill, {
            sessionId,
            terminalId: terminal.terminalId,
          })
        } else {
          await client.request(methods.client.terminal.release, {
            sessionId,
            terminalId: terminal.terminalId,
          })
        }
      }
      return undefined
    }
    default: {
      throw RequestError.internalError({
        unsupportedStep: step.kind,
      })
    }
  }
}
