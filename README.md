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

| Package                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                  | Docs                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `@acpjs/protocol`      | The normalized `AcpEvent` model, the `SessionState` model, the pure `reduce` reducer, and the Transport contract types. Environment-neutral: types and pure functions only.                                                                                                                                                                                                                                                           | [README](./packages/protocol/README.md)      |
| `@acpjs/core`          | The Node runtime `AcpHost`: spawns agents, drives the ACP Client connection, normalizes and numbers events, replays the log for late subscribers, routes permissions, provides default fs handling, supports injected terminal handling, and runs the restart and storage scheduling.                                                                                                                                                 | [README](./packages/core/README.md)          |
| `@acpjs/client`        | A typed facade over a reducer-driven snapshot/subscribe store that talks to a host through the Transport contract, plus the built-in in-process transport. Beyond reduced state it exposes a read-only `AcpSession.onEvent` tap on the normalized event stream (with `fromSeq` replay) for projections the single reduced state can't express, and re-exports `reduce` / `createInitialSessionState` for building them in one import. | [README](./packages/client/README.md)        |
| `@acpjs/react`         | A `<AcpProvider>` and fine-grained hooks (`useSession`, `useAgent`, `useAgents`, `usePermissionRequests`, `useConnectionStatus`, `useDiagnostics`, …) built on `useSyncExternalStore`. No state-library dependency.                                                                                                                                                                                                                   | [README](./packages/react/README.md)         |
| `@acpjs/electron`      | An Electron bridge with three non-cross-importing entries — `/main`, `/preload`, `/renderer` — that hand off to a `MessageChannelMain` port after a one-shot handshake.                                                                                                                                                                                                                                                               | [README](./packages/electron/README.md)      |
| `@acpjs/registry`      | ACP registry index fetch/cache, `AgentDefinition` resolution, and `ensureInstalled` with a four-tier resolution strategy.                                                                                                                                                                                                                                                                                                             | [README](./packages/registry/README.md)      |
| `@acpjs/fixture-agent` | Private, never published. A scripted protocol-replay agent used as a test fixture for real-stdio integration tests.                                                                                                                                                                                                                                                                                                                   | [README](./packages/fixture-agent/README.md) |

### Which package do I need?

- **Building a Node app or CLI** that drives agents in the same process → `@acpjs/core` + `@acpjs/client`.
- **Building a React UI** → `@acpjs/react` (it pulls in `@acpjs/client`).
- **Building an Electron app** → `@acpjs/electron` on top of `@acpjs/core` (main) and `@acpjs/client`/`@acpjs/react` (renderer).
- **Resolving and installing agents from the ACP registry** → `@acpjs/registry`, which produces an `AgentDefinition` for `@acpjs/core`.
- **Implementing a custom transport or your own consumer layer** → `@acpjs/protocol` for the contract types and reducer.

## Boundaries: what acpjs does NOT do

acpjs deliberately stays a typed entry point to **stable** protocol capabilities — no raw RPC escape hatch, no business or glue layer. The following are intentional non-goals, owned by the integrator, not gaps:

- **Authentication.** acpjs does not implement the ACP `authenticate` RPC. Any auth requirement — including MCP auth — propagates upward as the agent's authentication error; the integrator handles it out of band on their own client side (the agent logs in itself). The agent's advertised `authMethods` from `initialize` are surfaced verbatim on the agent snapshot as the data the integrator drives that out-of-band login from — surfacing the methods is mechanism; choosing and performing a login is the integrator's decision.
- **Permission decisions.** acpjs floats up every `session/request_permission` as a pending request and feeds your response back to the agent — that is the mechanism. Whether to approve, which option to pick, and any auto-approval rules are the integrator's decision, made by calling `respond`. acpjs ships no built-in policy engine; see "Auto-approving permissions in your app" below.
- **Project / workspace abstraction.** ACP has no project concept, only a per-session `cwd` plus `additionalDirectories`. Grouping sessions into a project, project-level configuration, and persistent indexing are app-layer concerns.
- **Automation & orchestration.** Batching, queues, retries, and scheduling live above the toolkit. acpjs provides imperative `prompt` plus a subscribable event stream; the integrator composes the orchestration.
- **Persistence by default.** The default storage is in-memory — no side effects, nothing written to disk. For durable history, inject the JSONL storage or a custom `StorageAdapter`.
- **Input validation pass-through.** Prompt content types, `mcpServers` transport types, and similar inputs are not pre-validated on the client side; they are forwarded as-is for the agent to validate, so the toolkit never duplicates the agent's business logic.
- **Incremental plan updates.** `plan_update` / `plan_removed` are currently UNSTABLE/experimental ACP capabilities. Per the "stable protocol surface only" principle, acpjs supports the full plan snapshot but not incremental plan mutation; support follows once they land in the stable spec.

### Auto-approving permissions in your app

Because acpjs only floats requests up, auto-approval is a few lines you own. Subscribe to pending requests and call `respond` with your own rule:

```ts
client.permissions.subscribe((requests) => {
  for (const request of requests) {
    const allow = request.options.find((option) => option.kind === 'allow_once')
    if (request.toolCall.kind === 'read' && allow) {
      void request.respond({ outcome: 'selected', optionId: allow.optionId })
    }
  }
})
```

At the core layer the same pattern uses a host subscription plus `host.respondPermission(requestId, outcome)`. Anything you do not auto-answer simply stays pending until a human decides.

### Recipes

The integrator-owned patterns — plan history, per-turn grouping, discriminating auth (and other agent) errors by structured code, joining a pending permission to its tool call, and [reading a session's config options / modes at the core layer](./docs/recipes.md#5-read-a-sessions-config-options--modes-core-layer) — are written up as a few lines of integrator-side TypeScript over the public surface in [docs/recipes.md](./docs/recipes.md). They are documented conveniences, not code baked into the toolkit.

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

const session = await agent.sessions.create({
  cwd: process.cwd(),
  mcpServers: [],
  additionalDirectories: [],
})
session.subscribe((state) => render(state))

await session.prompt([{ type: 'text', text: 'hello' }])
session.getSnapshot() // cached, immutable SessionState reference

await client.dispose() // closes the transport only
await host.dispose() // in-process host lifetime is independent of the client
```

In-process, the host and client lifetimes are independent: `client.dispose()` only closes the transport, it does not dispose the host. You **must** also `await host.dispose()` to reclaim agent child processes, otherwise they leak.

### React

`<AcpProvider>` injects the client; `useSession` reads a session's state and methods; `usePermissionRequests` reads pending permission requests across sessions. Every subscription goes through `useSyncExternalStore`, so references stay stable when nothing changes. The `client` comes from an in-process or Electron renderer transport, and `sessionId` comes from `session.sessionId` after `agent.sessions.create({ cwd, mcpServers, additionalDirectories })` — see the [@acpjs/client](./packages/client/README.md) and [@acpjs/react](./packages/react/README.md) READMEs for the full wiring.

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
