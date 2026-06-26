# @acpjs/electron

Electron bridge for acpjs. Three subpath entries that never import each other's runtime code — they only move acpjs host-client envelopes; ACP protocol handling stays in `@acpjs/core`.

## Install

```sh
pnpm add @acpjs/electron @acpjs/core @acpjs/client @acpjs/registry
```

ESM-only, `node >= 24`. Peer: `electron >= 30`. `import 'electron'` runs only in `/main` and `/preload`; `/renderer` is environment-neutral (plain `MessagePort`).

## Entries

- `@acpjs/electron/main` — `attachAcpBridge(host): () => void`. Builds a host endpoint, registers one `ipcMain.handle('acpjs:handshake')`, creates one `MessageChannelMain` per window (`port1` bridged to the endpoint, `port2` transferred to the window). Requires `contextIsolation: true`. Returns `detach`.
- `@acpjs/electron/preload` — `exposeAcp()`. Exposes `{ connect(): Promise<void> }` via `contextBridge.exposeInMainWorld('acp', …)` and relays the transferred port into the main world.
- `@acpjs/electron/renderer` — `electronTransport(options?): HostClientTransport`. Triggers the handshake via `window.acp.connect()`, then implements the full contract on a `MessagePort`. Inject `{ requestPort }` for a custom handshake.

## Usage

### Main

```ts
import { app, BrowserWindow } from 'electron'
import { createAcpHost } from '@acpjs/core'
import { attachAcpBridge } from '@acpjs/electron/main'

const host = createAcpHost({ restart: 'on-crash' })
let detach: (() => void) | undefined

app.whenReady().then(async () => {
  await host.spawnAgent({ id: 'a', command: 'npx', args: ['some-acp-agent'] })
  detach = attachAcpBridge(host)
  await new BrowserWindow({
    webPreferences: { preload, contextIsolation: true },
  }).loadFile('index.html')
})

app.on('before-quit', async () => {
  detach?.() // send closed to renderers + close ports, BEFORE host.dispose()
  await host.dispose()
})
```

### Preload

```ts
import { exposeAcp } from '@acpjs/electron/preload'
exposeAcp()
```

`sandbox: true` (Electron default): preload must be a **single CJS bundle** with `electron` external. `sandbox: false`: can load the ESM entry directly via `.mjs`.

### Renderer

```ts
import { createAcpClient } from '@acpjs/client'
import { electronTransport } from '@acpjs/electron/renderer'
const client = createAcpClient({ transport: electronTransport() })
```

`AgentDefinition` is main-only — do not smuggle one to the renderer. Hydrate an existing agent/session instead:

```ts
const [snap] = await client.agents.list()
const agent = await client.agents.attach(snap.agentId)
const session = await agent.sessions.create({
  cwd,
  mcpServers: [],
  additionalDirectories: [],
})
```

## Key semantics

- **Shutdown order**: call `detach()` before `host.dispose()` — reversing kills child processes before the close signal reaches renderers.
- **`attachAcpBridge`** has no ordering dependency on window creation (registerable before `whenReady`); calling it twice throws (re-register `ipcMain.handle`) — `detach` first.
- **Renderer transport is single-use**: after `close` (incl. main-side `detach`, window destruction, or peer port close), `connect` rejects permanently with `acpjs/transport-closed`. After a reload you **must rebuild** `electronTransport()` + `createAcpClient`; catch up via `fromSeq` (handled by `@acpjs/client` on `subscribe`). Re-attach a session with `client.sessions.attach(previousSessionId)`.
- **Per-window isolation**: each handshake gets an independent port; windows never affect each other.
- **Port message protocol** (internal): renderer→main `request | subscribe | unsubscribe | inbound-response | close`; main→renderer `response | event | sub-error | inbound-request | inbound-ack | closed`.
- **Subscription failure**: a synchronous endpoint `subscribe` throw (e.g. `acpjs/session-closed`) is reported as `sub-error` → `onSubscriptionError`; blast radius is limited to that subscription.
- **Errors**: transport errors are `Error` with `ErrorObject` fields (`code`/`retryable`/`data?`), `name: 'AcpElectronTransportError'`, recognized by `@acpjs/client`.
- **`contextIsolation` check** relies on the trusted preload reporting `process.contextIsolated`; guards against misconfiguration, not a malicious page.
