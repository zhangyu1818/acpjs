import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAcpHost } from '@acpjs/core'
import { attachAcpBridge } from '@acpjs/electron/main'
import { app, BrowserWindow, ipcMain } from 'electron'

console.error('[e2e-main] boot')

const dir = path.dirname(fileURLToPath(import.meta.url))
const roles = ['a', 'b', 'c']
const reports = {}
const signals = new Map()
const waiters = new Map()
let host

function finish(code) {
  const payload = JSON.stringify(reports)
  const done = () => {
    process.stdout.write(`ACP_E2E_RESULT:${payload}\n`, () => app.exit(code))
  }
  if (host) host.dispose().then(done, done)
  else done()
}

ipcMain.on('e2e:signal', (_event, message) => {
  signals.set(message.name, message.data ?? null)
  const pending = waiters.get(message.name) ?? []
  waiters.delete(message.name)
  for (const resolve of pending) resolve(message.data ?? null)
})

ipcMain.handle('e2e:wait', (_event, name) => {
  if (signals.has(name)) return signals.get(name)
  return new Promise((resolve) => {
    const pending = waiters.get(name) ?? []
    pending.push(resolve)
    waiters.set(name, pending)
  })
})

ipcMain.handle('e2e:destroyedListeners', (event) =>
  event.sender.listenerCount('destroyed'),
)

ipcMain.handle('e2e:config', () => ({
  nodeBin: process.env.ACP_E2E_NODE_BIN,
  cliPath: process.env.ACP_E2E_FIXTURE_CLI,
  scenarioPath: process.env.ACP_E2E_SCENARIO,
  cwd: process.env.ACP_E2E_CWD,
}))

ipcMain.on('e2e:report', (_event, message) => {
  reports[message.role] = message.data
  if (roles.every((role) => role in reports)) finish(0)
})

process.on('uncaughtException', (error) => {
  reports.main = { error: String((error && error.stack) || error) }
  finish(1)
})

function createWindow(role, contextIsolation) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(dir, 'preload.mjs'),
      contextIsolation,
      sandbox: false,
      nodeIntegration: false,
    },
  })
  void win.loadFile(path.join(dir, 'index.html'), { query: { role } })
}

void app.whenReady().then(() => {
  console.error('[e2e-main] ready')
  host = createAcpHost()
  attachAcpBridge(host)
  createWindow('a', true)
  createWindow('b', true)
  createWindow('c', false)
  console.error('[e2e-main] windows created')
  setTimeout(() => {
    reports.timeout = { missing: roles.filter((role) => !(role in reports)) }
    finish(1)
  }, 60_000)
})
