import type { ClientCapabilities } from '@agentclientprotocol/sdk'

import type { FsHandler, TerminalHandler } from './options.ts'

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

export function deriveClientCapabilities(
  fs: FsHandler,
  terminal: TerminalHandler,
): ClientCapabilities {
  const fsCaps = {
    ...(isFunction(fs.readTextFile) ? { readTextFile: true } : {}),
    ...(isFunction(fs.writeTextFile) ? { writeTextFile: true } : {}),
  }
  const terminalComplete = Boolean(
    isFunction(terminal.createTerminal) &&
    isFunction(terminal.terminalOutput) &&
    isFunction(terminal.waitForTerminalExit) &&
    isFunction(terminal.killTerminal) &&
    isFunction(terminal.releaseTerminal) &&
    isFunction(terminal.cleanupSession),
  )
  return {
    ...(Object.keys(fsCaps).length !== 0 ? { fs: fsCaps } : {}),
    ...(terminalComplete ? { terminal: true } : {}),
  }
}
