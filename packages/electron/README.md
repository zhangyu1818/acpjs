# @acpjs/electron

The Electron bridge for acpjs. It ships three subpath entries that never import each other's runtime code:

- `@acpjs/electron/main` — runs in the main process, attaches an `AcpHost`, and answers the handshake.
- `@acpjs/electron/preload` — exposes a minimal handshake surface over `contextBridge`.
- `@acpjs/electron/renderer` — produces a `Transport` that satisfies the `@acpjs/protocol` Transport contract.

This package only moves envelopes (`RpcRequest`/`RpcResponse`, `AcpEvent`, `InboundRequest`/`InboundResponse`); it carries no protocol knowledge.

## Installation

```sh
pnpm add @acpjs/electron @acpjs/core @acpjs/client @acpjs/registry
```

`@acpjs/core` and `@acpjs/registry` are used only in the main process; `@acpjs/client` only in the renderer. `@acpjs/electron` is ESM-only and requires `node >= 24`; `electron >= 30` is a peer dependency.

A runtime `import 'electron'` happens only in the `/main` and `/preload` entries. The `/renderer` entry is environment-neutral (plain `MessagePort` plus the global `message` event) and bundles for the browser without any Electron dependency.

## Architecture

The host stack (`@acpjs/core` host, `@acpjs/registry`) is Node-only and can be wired only in the main process. The main process spawns agents, attaches the bridge, and answers handshakes; the renderer consumes everything through the transport.

The handshake is one `ipcRenderer.invoke`, after which traffic flows over a `MessageChannel` port:

1. The renderer transport calls `window.acp.connect()`, which invokes the handshake channel.
2. The main process verifies `contextIsolation`, creates a fresh `MessageChannelMain`, keeps `port1` bridged to the host endpoint, and transfers `port2` to that window's `webContents`.
3. The preload script receives the transferred port over IPC and re-posts it into the main world with `window.postMessage`, because a `MessagePort` cannot cross `contextBridge` directly.
4. The renderer transport receives the port and implements the full Transport contract on top of it.

Each window (each handshake) gets its own independent port; windows never affect each other.

## Usage

### Main process

```ts
import { app, BrowserWindow } from 'electron'
import { createAcpHost } from '@acpjs/core'
import { createRegistryClient } from '@acpjs/registry'
import { attachAcpBridge } from '@acpjs/electron/main'

const host = createAcpHost({ restart: 'on-crash' })
const registry = createRegistryClient()
let detach: (() => void) | undefined

app.whenReady().then(async () => {
  const definition = await registry.ensureInstalled('claude-acp')
  await host.spawnAgent(definition)
  detach = attachAcpBridge(host)

  const window = new BrowserWindow({
    webPreferences: { preload, contextIsolation: true },
  })
  await window.loadFile('index.html')
})

app.on('before-quit', async () => {
  detach?.()
  await host.dispose()
})
```

`attachAcpBridge(host)` registers a single `ipcMain.handle` and has no ordering dependency on window creation — you may register it before `whenReady` (`ipcMain.handle` does not require app ready). Placing it after `spawnAgent` here only ensures the first window can `agents.list()` an already-ready agent on its first handshake. `spawnAgent` returns an `AgentSnapshot` (with `agentId`); the main process keeps no handle, because the renderer hydrates one via `attach` (see below).

On shutdown, always call `detach()` before `await host.dispose()`. `detach()` sends `closed` to every renderer (each page transport enters the `closed` lifecycle), removes the handler, and closes every port; only then does `host.dispose()` reclaim the agent child processes. Reversing the order would deliver the close signal to renderers after the child processes are already killed.

Internally, `attachAcpBridge(host)` builds a host endpoint with `@acpjs/core`'s `createHostEndpoint(host)` and registers a single `ipcMain.handle` to answer the handshake. Each handshake creates one `MessageChannelMain`: `port1` stays on the main side bridged to the endpoint, and `port2` is transferred to the requesting window via `webContents.postMessage`. When the window is destroyed (`webContents` `destroyed`), the bridge tears down that port and all of its subscriptions. The handshake requires `contextIsolation: true`; otherwise it throws synchronously so the `invoke` rejects. The returned `detach` removes the handler, sends `closed` to every renderer, and closes every port.

### Preload

```ts
import { exposeAcp } from '@acpjs/electron/preload'

exposeAcp()
```

`exposeAcp()` exposes the minimal handshake surface — a single `connect()` that triggers the handshake — via `contextBridge.exposeInMainWorld('acp', { connect })`. It does not expose `ipcRenderer` or the Node API surface. Because a `MessagePort` cannot cross `contextBridge` directly, `exposeAcp` also registers an `ipcRenderer.on` listener that receives the transferred port from the main process and, following the official Electron pattern, re-posts it into the main world with `window.postMessage(message, '*', ports)`.

#### Bundling the preload

This package ships **ESM only** (`./preload` → `dist/preload.js`, first line `import 'electron'`), but the format a preload can use depends on the window's `sandbox` setting:

- **`sandbox: true` (Electron default):** the preload must be a **single CJS file** and cannot load this package's ESM entry directly. Use a bundler to compile `import { exposeAcp } from '@acpjs/electron/preload'` into one CJS file, and mark `electron` as **external** (Electron supplies `require('electron')` at preload runtime; it must not be bundled). The default preload configs of electron-vite and Electron Forge produce exactly this, so consumers usually need no extra configuration.
- **`sandbox: false`:** the preload runs in a Node-enabled context and can load the ESM entry directly via `.mjs`. This package's own E2E fixture (`test-app/preload.mjs`, which imports `../dist/preload.js`) uses this form, but it is **a test fixture only and not a reference for consumers**. Production preloads should keep `sandbox: true` and use a CJS bundle.

The renderer entry (`@acpjs/electron/renderer`) is pure ESM with no Node dependency and is environment-neutral. Under Vite a bare `import { electronTransport } from '@acpjs/electron/renderer'` works with no external/bundle handling.

### Renderer (page)

```ts
import { createAcpClient } from '@acpjs/client'
import { electronTransport } from '@acpjs/electron/renderer'

const client = createAcpClient({ transport: electronTransport() })
```

By default `electronTransport()` triggers the handshake through `window.acp.connect()`, waits for the port-transfer message to obtain a `MessagePort`, and implements the full Transport contract on it: `connect` (lifecycle `connecting → connected → closed`, with the error-terminated path), `request` (paired by envelope `id`), `subscribe(fromSeq)`, the reverse `InboundRequest` / `respondInbound`, and `close`. All payloads cross the port via structured clone (INV-3); the port is a FIFO channel, so delivery is ordered. For tests or custom handshakes, inject a port factory with `electronTransport({ requestPort })`.

#### Recommended renderer shape

`AgentDefinition` can only be produced in the main process (registry/host are Node-only), so the renderer **should not** smuggle a definition over a side IPC channel and call `spawn`. Instead, hydrate an already-ready agent through the client's enumeration/attach surface:

```ts
const [agentSnapshot] = await client.agents.list()
const agent = await client.agents.attach(agentSnapshot.agentId)
const session = await agent.sessions.create({ cwd })
```

`client.agents.list()` queries every agent snapshot on the host once; `client.agents.attach(agentId)` hydrates a handle (an unknown id rejects with `acpjs/agent-exited`). `cwd` must be supplied explicitly by the renderer (there is no `process.cwd()` in the renderer), typically from a user-selected working directory.

To share a session across windows, or to re-attach an existing session after a page reload, use the session surface (**no agent handle needed**):

```ts
const snapshots = await client.sessions.list()
const session = await client.sessions.attach(snapshots[0].sessionId)
```

`client.sessions.attach(sessionId)` validates existence via `list()`, then subscribes and rebuilds that session's state (an unknown id rejects with `acpjs/session-closed`).

### Reload and reconnection

On page navigation/reload the `webContents` is **not** `destroyed`, so the main side reclaims the port through the `MessagePortMain` `'close'` event rather than `'destroyed'`: the old `MessagePort` closes with the page, and the main-side endpoint bridge tears down with it. After reload the page re-runs the preload and scripts, issues a new handshake, and obtains a brand-new port.

The renderer transport is **single-use**: after `close` (which includes a main-side `detach`, window destruction, or a peer port close), `connect` rejects permanently with `acpjs/transport-closed`. So after a reload you **must rebuild the whole `electronTransport()` + `createAcpClient`** — the old client cannot be reused. The new connection replays state by `fromSeq` when subscribing (handled by the `@acpjs/client` store on `subscribe({ fromSeq })`); reconnection is not a transport responsibility — a new connection catches up via `fromSeq`.

After rebuilding the client, combine it with `client.sessions.attach(sessionId)` to re-attach the pre-reload session on the new page (the `sessionId` can be persisted across reloads by the application layer, e.g. in `sessionStorage`):

```ts
const client = createAcpClient({ transport: electronTransport() })
const session = await client.sessions.attach(previousSessionId)
```

This package provides no automatic reconnection or transport reuse for reload; rebuild and re-attach are driven by the consumer.

## Testing

- **Unit / contract:** the renderer transport is tested against a fake endpoint over a plain web `MessageChannel` (available as a Node global): RPC round-trips, subscription `fromSeq` and ordering, reverse requests and error acknowledgements, and the `close` lifecycle.
- **Real Electron E2E:** `test-app/` is a minimal test application fixture; vitest spawns a real Electron binary and drives three windows (two isolated windows plus one `contextIsolation: false` window). It covers: each window owning its own port while reporting field-for-field identical session state, a single permission answer across windows (INV-8 — a second `respond` yields `acpjs/already-answered`), handshake failure when isolation is missing, and full-chain state construction for a normal prompt.

## Implementation-defined decisions

- **Handshake carrier:** a single `ipcMain.handle('acpjs:handshake')`. The port transfer travels over the `'acpjs:port'` channel; the main-world transfer message has `data` equal to the string `'acpjs:port'` and the port in `event.ports[0]`.
- **How `contextIsolation` is verified:** Electron has removed `webContents.getLastWebPreferences()`, so verification relies on the preload (trusted code) faithfully reporting `process.contextIsolated` in the handshake payload; the main side rejects the handshake when it is not `true`. In a non-isolated context, `exposeAcp` degrades to attaching `window.acp` directly (`contextBridge` is unavailable there) so the handshake failure is observable to the page. Trust boundary: a window misconfigured with `nodeIntegration: true` could have page code call `ipcRenderer.invoke` directly and forge the handshake payload to bypass this check — the check guards against misconfiguration, not a malicious page; the preload is treated as trusted code.
- **Exposed global key:** `window.acp`, shaped strictly as `{ connect(): Promise<void> }`.
- **Wire message protocol** (package-internal, not part of the public contract): renderer→main `rpc | subscribe | unsubscribe | inbound-response | close`; main→renderer `rpc-result | event | sub-error | inbound-request | inbound-ack | closed`. Subscriptions are identified by a transport-local monotonic `sub-<n>`; `respondInbound` is paired by `ack-<n>`, and rejections carry an `ErrorObject` (e.g. `acpjs/already-answered`) passed across the bridge verbatim.
- **Subscription-failure semantics:** an endpoint-side `subscribe` that throws synchronously (e.g. `acpjs/session-closed` for an unknown or deleted `sessionId`) is caught on the main side and reported back as `sub-error`; the renderer releases that subscriber. The blast radius is limited to that subscription — other traffic on the same port and the main process are unaffected. Because the Transport contract's `subscribe` returns an unsubscribe synchronously and cannot throw synchronously across processes, a subscription failure manifests as silently receiving no events.
- **Renderer error shape:** errors thrown/rejected by the transport are `Error` objects carrying `ErrorObject` fields (`code` / `retryable` / `data?`) with `name: 'AcpElectronTransportError'`, which `@acpjs/client`'s error normalization recognizes directly.
- **Close semantics:** aligned with the in-process transport — after close, `request` resolves with an `acpjs/transport-closed` error response, `subscribe` throws, and `respondInbound` rejects; in-flight RPCs/acks settle immediately with the same error code; `close` is idempotent and tells the main side to release all of that port's subscriptions. A main-side `detach`, window destruction, or a peer port close likewise triggers the renderer-side `closed` lifecycle.
- **Multiple transports in one window:** each `connect()` performs an independent handshake with an independent port; concurrent handshakes pair ports in arrival order (all ports are semantically equivalent).
- **Repeated attach:** calling `attachAcpBridge` twice in the same process throws, because `ipcMain.handle` is registered twice; `detach` first, then re-attach.

```

```
