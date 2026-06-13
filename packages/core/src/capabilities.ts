import type { ClientCapabilities } from '@agentclientprotocol/sdk'

import type { FsHandler, TerminalHandler } from './options.ts'

export function deriveClientCapabilities(
  fs: FsHandler,
  terminal: TerminalHandler,
): ClientCapabilities {
  const fsCaps = {
    ...(fs.readTextFile ? { readTextFile: true } : {}),
    ...(fs.writeTextFile ? { writeTextFile: true } : {}),
  }
  const terminalComplete = Boolean(
    terminal.createTerminal &&
    terminal.terminalOutput &&
    terminal.waitForTerminalExit &&
    terminal.killTerminal &&
    terminal.releaseTerminal,
  )
  return {
    ...(Object.keys(fsCaps).length !== 0 ? { fs: fsCaps } : {}),
    ...(terminalComplete ? { terminal: true } : {}),
  }
}
