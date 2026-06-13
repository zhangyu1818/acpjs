# acpjs

A layered TypeScript client toolkit for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com). acpjs plays the **Client role** in ACP: it spawns and connects to any ACP-compliant agent process, normalizes the protocol's JSON-RPC event stream into a serializable, replayable, typed event stream and session state, and delivers that state to native Node, React, and Electron consumers that barely have to touch the protocol.

Every package is **headless** — no UI components, styles, or rendering logic anywhere. The value is making it easy for your own UI to consume agent sessions.

## Why acpjs

ACP lets editors and apps talk to coding agents over a uniform JSON-RPC contract. Consuming that protocol directly means tracking session updates, tool calls, plans, permission requests, mode changes, terminals, crashes, and reconnection ordering by hand. acpjs absorbs that work:

- **Protocol-agnostic.** No hardcoded agent knowledge. Agents and their launch parameters come from an ACP registry or from your own config; the two are interchangeable.
- **Typed, closed surface.** Every stable protocol capability has a typed entry point. There is no escape hatch for sending raw RPC — when the protocol grows, the toolkit grows with it.
- **Serializable contract.** The only boundary is the Transport contract (request/response + event push + reverse requests). Payloads are structured-clone safe, so the same client works in-process or across a process boundary, shipping only small normalized event increments.
- **One reducer, consistent state.** All session updates flow through a single pure reducer. Any two subscribers — regardless of environment or when they subscribed — reduce to field-for-field identical session state.

## Architecture

acpjs is a layered monorepo with a strictly one-directional dependency graph:

```
                @acpjs/protocol
   (types + pure reducer + Transport contract; environment-neutral, zero runtime deps)
                  ▲          ▲          ▲
        ┌─────────┘          │          └──────────┐
   @acpjs/core          @acpjs/client         @acpjs/registry
   (Node: AcpHost)      (typed facade +       (agent resolution
                         in-process            & install →
        ▲                transport)            AgentDefinition)
        │                  ▲      ▲
   @acpjs/electron         │      └──────────┐
   (main / preload /  @acpjs/react      (in-process transport
    renderer bridge)  (Provider+hooks)   links client → core)
```

Enforced direction: `react → client → protocol`, `electron(main) → core → protocol`, `registry → protocol`. `@acpjs/core` only ever accepts an `AgentDefinition` (command, args, env, capability metadata); hand-written config and registry output are isomorphic, so the registry is an optional convenience layer, never a required one.

## Packages

| Package                | Role                                                                                                                                                                                                                                                                         | Docs                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `@acpjs/protocol`      | The normalized `AcpEvent` model, the `SessionState` model, the pure `reduce` reducer, and the Transport contract types. Environment-neutral: types and pure functions only.                                                                                                  | [README](./packages/protocol/README.md)      |
| `@acpjs/core`          | The Node runtime `AcpHost`: spawns agents, drives the ACP Client connection, normalizes and numbers events, replays the log for late subscribers, routes permissions, provides default fs/terminal reverse-capability handlers, and runs the restart and storage scheduling. | [README](./packages/core/README.md)          |
| `@acpjs/client`        | A typed facade over a reducer-driven snapshot/subscribe store that talks to a host through the Transport contract, plus the built-in in-process transport.                                                                                                                   | [README](./packages/client/README.md)        |
| `@acpjs/react`         | A `<AcpProvider>` and fine-grained hooks (`useSession`, `useAgent`, `useAgents`, `usePermissionRequests`, `useConnectionStatus`, …) built on `useSyncExternalStore`. No state-library dependency.                                                                            | [README](./packages/react/README.md)         |
| `@acpjs/electron`      | An Electron bridge with three non-cross-importing entries — `/main`, `/preload`, `/renderer` — that hand off to a `MessageChannelMain` port after a one-shot handshake.                                                                                                      | [README](./packages/electron/README.md)      |
| `@acpjs/registry`      | ACP registry index fetch/cache, `AgentDefinition` resolution, and `ensureInstalled` with a four-tier resolution strategy.                                                                                                                                                    | [README](./packages/registry/README.md)      |
| `@acpjs/fixture-agent` | Private, never published. A scripted protocol-replay agent used as a test fixture for real-stdio integration tests.                                                                                                                                                          | [README](./packages/fixture-agent/README.md) |

### Which package do I need?

- **Building a Node app or CLI** that drives agents in the same process → `@acpjs/core` + `@acpjs/client`.
- **Building a React UI** → `@acpjs/react` (it pulls in `@acpjs/client`).
- **Building an Electron app** → `@acpjs/electron` on top of `@acpjs/core` (main) and `@acpjs/client`/`@acpjs/react` (renderer).
- **Resolving and installing agents from the ACP registry** → `@acpjs/registry`, which produces an `AgentDefinition` for `@acpjs/core`.
- **Implementing a custom transport or your own consumer layer** → `@acpjs/protocol` for the contract types and reducer.

## Getting started

### Node, in-process

`createAcpHost` starts a host, `createHostEndpoint` wraps it as a Transport endpoint, and `createInProcessTransport` connects it to `createAcpClient` via direct function calls (no serialization, no transport boundary). From there you `spawn`, `create` a session, `subscribe`, and `prompt`.

```ts
import { createAcpClient, createInProcessTransport } from '@acpjs/client'
import { createAcpHost, createHostEndpoint } from '@acpjs/core'

const host = createAcpHost()
const transport = createInProcessTransport(createHostEndpoint(host))
const client = createAcpClient({ transport })

const agent = await client.agents.spawn({
  id: 'my-agent',
  command: 'npx',
  args: ['some-acp-agent'],
})

const session = await agent.sessions.create({ cwd: process.cwd() })
session.subscribe((state) => render(state))

client.permissions.subscribe((requests) => {
  for (const request of requests) {
    void request.respond({
      outcome: 'selected',
      optionId: request.options[0]?.optionId ?? '',
    })
  }
})

await session.prompt([{ type: 'text', text: 'hello' }])
session.getSnapshot() // cached, immutable SessionState reference

await client.dispose() // closes the transport only
await host.dispose() // in-process host lifetime is independent of the client
```

In-process, the host and client lifetimes are independent: `client.dispose()` only closes the transport, it does not dispose the host. You **must** also `await host.dispose()` to reclaim agent child processes, otherwise they leak.

### React

`<AcpProvider>` injects the client; `useSession` reads a session's state and methods; `usePermissionRequests` reads pending permission requests across sessions. Every subscription goes through `useSyncExternalStore`, so references stay stable when nothing changes. The `client` comes from an in-process or Electron renderer transport, and `sessionId` comes from `session.sessionId` after `agent.sessions.create({ cwd })` — see the [@acpjs/client](./packages/client/README.md) and [@acpjs/react](./packages/react/README.md) READMEs for the full wiring.

```tsx
import { AcpProvider, usePermissionRequests, useSession } from '@acpjs/react'

import type { AcpClient } from '@acpjs/client'

function App({ client, sessionId }: { client: AcpClient; sessionId: string }) {
  return (
    <AcpProvider client={client}>
      <Chat sessionId={sessionId} />
    </AcpProvider>
  )
}

function Chat({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId)
  const permissions = usePermissionRequests()
  if (!session) return null
  return (
    <div>
      {session.state.messages.map((message, index) => (
        <p key={index}>{JSON.stringify(message.content)}</p>
      ))}
      {permissions.map((request) => (
        <button
          key={request.requestId}
          onClick={() =>
            void request.respond({
              outcome: 'selected',
              optionId: request.options[0]?.optionId ?? '',
            })
          }
        >
          Allow
        </button>
      ))}
      <button
        onClick={() => void session.prompt([{ type: 'text', text: 'hi' }])}
      >
        Send
      </button>
    </div>
  )
}
```

### Electron

`@acpjs/electron` exposes three subpath entries that never import each other's runtime code:

- `/main` — `attachAcpBridge(host)` wires up an `AcpHost`, answers the handshake, and opens one `MessageChannelMain` per window.
- `/preload` — `exposeAcp()` exposes a minimal handshake surface over `contextBridge`; requires `contextIsolation: true`.
- `/renderer` — `electronTransport()` produces a Transport-contract transport to pass to `createAcpClient`.

The handshake is a single `ipcRenderer.invoke`; all traffic afterwards flows over a `MessagePort`, naturally isolated per window. See the [@acpjs/electron README](./packages/electron/README.md).

### Registry

`createRegistryClient().ensureInstalled(agentId)` returns an `AgentDefinition` ready to hand to `@acpjs/core`. It resolves with a four-tier priority — explicit command > executable already on `PATH` > package-manager direct run (`npx` / `uvx`) > binary download (per-platform package selection, extraction into a versioned cache, `chmod`, idempotent re-use). Install progress and diagnostics surface as subscribable host events. See the [@acpjs/registry README](./packages/registry/README.md).

## Engineering

- **ESM-only, Node ≥ 24.** `protocol`, `client`, and `react` are environment-neutral (no Node built-ins; usable in browsers and renderer processes); `core`, `registry`, and `electron` are Node/Electron-only.
- **Package management.** pnpm workspace (`pnpm ≥ 10`), `workspace:*` internal references. Builds use `tsdown` (ESM + d.ts).
- **Build orchestration.** turborepo runs the whole monorepo.
- **Lint / format.** oxlint + oxfmt, sharing `@zhangyu1818/oxlint-config`.
- **Testing.** Pure-logic units (reducer, resolution, state machines) plus integration tests that spawn `@acpjs/fixture-agent` — a scripted agent built on the official SDK's `AgentSideConnection` that replays tool calls, permissions, auth-required, crashes, and the rest of the protocol branches — over real stdio. The Electron path is exercised end to end against a minimal `test-app/`, with vitest launching a real Electron instance to verify the MessagePort / contextBridge / preload chain. Real-agent E2E is tagged separately and skipped by default.
- **Release.** Changesets (independent per-package versions); GitHub Actions OIDC trusted publishing with provenance and no stored npm token; `publint` + `arethetypeswrong` guard exports and packaging.

### Common commands

| Command           | Description                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `pnpm build`      | Build all packages (`turbo build`).                                                        |
| `pnpm test`       | Run the full test suite (`turbo test`).                                                    |
| `pnpm test:watch` | Run vitest in watch mode.                                                                  |
| `pnpm typecheck`  | Type-check all packages (`turbo typecheck`).                                               |
| `pnpm lint`       | Lint with oxlint (`pnpm lint:fix` to autofix).                                             |
| `pnpm format`     | Format with oxfmt (`pnpm format:check` to verify only).                                    |
| `pnpm check`      | Run the dependency-direction, browser-neutrality, and publish (`publint` + `attw`) checks. |
| `pnpm clean`      | Remove build outputs and caches.                                                           |

## License

MIT
