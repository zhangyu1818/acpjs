# @acpjs/client

Typed facade and reducer-driven client-side store for acpjs. Environment-neutral (no Node built-ins) and connected to any host purely through the Transport contract (in-process, Electron renderer, …). It replays the normalized event stream on the client side with the pure reducer from `@acpjs/protocol` into `SessionState`, exposed through a snapshot + subscribe surface. The only runtime dependency is `@acpjs/protocol`; `@acpjs/core` is consumed only through transport contract types.

## Installation

```sh
pnpm add @acpjs/client
```

ESM-only, requires `node >= 24` (also usable in browser / renderer environments).

## Minimal usage (in-process Node)

```ts
import {
  AcpClientError,
  createAcpClient,
  createInProcessTransport,
} from '@acpjs/client'
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
session.subscribe(() => render(session.getSnapshot()))

client.permissions.subscribe((requests) => {
  for (const request of requests) {
    // Under multi-client races, a respond rejected with acpjs/already-answered
    // is the normal path (the pending list has already converged) — ignore it.
    request
      .respond({
        outcome: 'selected',
        optionId: request.options[0]?.optionId ?? '',
      })
      .catch((error) => {
        if (
          error instanceof AcpClientError &&
          error.code === 'acpjs/already-answered'
        )
          return
        throw error
      })
  }
})

await session.prompt([{ type: 'text', text: 'hello' }])
session.getSnapshot() // cached immutable SessionState reference

// In-process: the host lifecycle is independent of the client. client.dispose()
// only closes the transport; you must separately await host.dispose() or the
// agent child processes will leak.
await client.dispose()
await host.dispose()
```

## Public API (closed surface)

The export surface is exactly three values: `createAcpClient`, `createInProcessTransport`, and `AcpClientError` (pinned by an API snapshot test). There is no raw RPC send, no raw protocol notification subscription, and no store selector parameter.

- `createAcpClient({ transport })` → `AcpClient`
  - `client.agents.spawn(definition)` → `Promise<AcpAgent>`. `definition` is an `AgentDefinition` (`id`, `command`, `args?`, `env?`, `cwd?`, `meta?`). The returned handle carries `agentId` plus `capabilities?` / `authMethods?` passed through from initialize.
  - `client.agents.get(agentId)` → `AcpAgent | undefined`: look up a known handle by id (same reference returned by spawn / attach).
  - `client.agents.getSnapshot()` → `readonly AcpAgent[]`: cached immutable snapshot of the handle set — a new reference is produced only when the set changes (`useSyncExternalStore` compatible).
  - `client.agents.subscribe(() => ...)`: notification when the agent handle set changes (no immediate callback; read the initial value via `getSnapshot`).
  - `client.agents.list()` → `Promise<readonly AgentSnapshot[]>`: a one-shot RPC query of every agent known to the host (`agentId` / `status` / `restartCount` / `reason?` / `exit?` / `capabilities?` / `authMethods?` / `authRequired?`), non-reactive.
  - `client.agents.attach(agentId)` → `Promise<AcpAgent>`: hydrate an agent that already exists on the host into a handle (internally calls `list()` to verify existence). An unknown id rejects with `acpjs/agent-exited`; an existing handle is reused.
  - `client.sessions.get(sessionId)` → `AcpSession | undefined`: look up a known session handle by id. create / load / resume / attach for the same sessionId share one frozen handle.
  - `client.sessions.getSnapshot()` → `readonly AcpSession[]`: cached immutable snapshot of the session handle set.
  - `client.sessions.subscribe(() => ...)`: notification when the session handle set changes.
  - `client.sessions.list()` → `Promise<readonly SessionSnapshot[]>`: a one-shot RPC query of every session known to the host (`sessionId` / `status` / `agentId?` / `cwd?` / `agentDefinitionId?`), non-reactive.
  - `client.sessions.attach(sessionId)` → `Promise<AcpSession>`: re-attach to an existing session **without an agent handle** (internally calls `list()`; if present it subscribes and rebuilds state via replay from `fromSeq: 0`). An unknown id rejects with `acpjs/session-closed`.
  - `client.sessions.restore()` → `Promise<readonly SessionSnapshot[]>`: after a host restart, rebuild `disconnected` sessions from storage and return their snapshots.
  - `client.permissions.getSnapshot()` → `readonly PermissionRequest[]`: cached immutable reference of the pending permission-request list — a new reference is produced only when the set changes.
  - `client.permissions.subscribe((requests) => ...)`: notification with the latest snapshot on any add/remove of the pending set (new request, respond, other-client answer / superseded); no immediate callback (read the initial value via `getSnapshot`). Each `request` carries `requestId` / `sessionId` / `toolCall` / `options` (protocol pass-through) and `respond(outcome)`.
  - `client.status.getSnapshot()` → `ConnectionStatusSnapshot` (`{ status: 'connecting' | 'connected' | 'closed', error? }`): cached immutable snapshot of the connection status.
  - `client.status.subscribe(() => ...)`: notification when the connection status changes (no immediate callback; read the initial value via `getSnapshot`).
  - `client.dispose()`: close the transport; afterwards every call rejects with `acpjs/transport-closed`.
- `AcpAgent`
  - `agent.agentId`, `agent.capabilities?`, `agent.authMethods?`: readonly handle properties.
  - `agent.getSnapshot()` → `AgentSnapshot`: cached immutable snapshot of this agent's runtime state (`status` / `restartCount` / `reason?` / `exit?` / `capabilities?` / `authMethods?` / `authRequired?`). `restartCount` is driven by live `agent-status-change` events; `authRequired` / `authMethods` reflect the waiting-for-auth dimension driven by host-level `auth-required` events.
  - `agent.subscribe(() => ...)`: notification when the runtime state changes (no immediate callback; read the initial value via `getSnapshot`).
  - `agent.sessions.create({ cwd, mcpServers? })` / `load(sessionId, { cwd, mcpServers? })` / `list({ cursor?, cwd? })` / `resume(sessionId)` / `delete(sessionId)`.
  - `agent.authenticate(methodId)` / `agent.logout()`.
- `AcpSession`
  - `session.sessionId`: readonly id.
  - `session.getSnapshot()` → `SessionState`: cached immutable reference — a new reference is produced only when a new event arrives (`useSyncExternalStore` compatible).
  - `session.subscribe((state) => ...)`: notification when state changes (the current value is not replayed; read the initial value via `getSnapshot`).
  - `session.prompt(ContentBlock[])` → `Promise<PromptFinishedPayload>`: protocol content blocks passed through with no rewriting. Also `cancel()`, `close()`, `setMode(modeId)`, `setConfigOption(configId, value)`.
- Slash commands are not a separate API: `SessionState.availableCommands` only enumerates available commands for autocompletion UI. To invoke a command, write a `/`-prefixed text block in the prompt, which may be mixed with other blocks — `session.prompt([{ type: 'text', text: '/web query' }])`. There is no `invokeCommand`-style method.
- Every error is an `AcpClientError` (an `ErrorObject` shape: `code` (acpjs/\*), `message`, `data?`, `retryable`). A capability-gated method whose capability was not declared rejects with `acpjs/capability-unsupported` (core semantics passed through); a second answer to a permission rejects with `acpjs/already-answered`.

## State construction

The only client-side state-construction path: the transport receives an `AcpEvent` → the `reduce` function from `@acpjs/protocol` replays it in `seq` order. Subscriptions carry `fromSeq`; a late subscriber / reconnection is backfilled by replay and ends up deeply equal to a full-duration subscriber (INV-2). A duplicate event whose `seq` was already applied is ignored.

## Transport

The client consumes the Transport contract from `@acpjs/protocol` (`connect` / `request` / `subscribe` / `respondInbound` / `close`, with lifecycle `connecting → connected → closed` plus an error termination path). The built-in `createInProcessTransport(endpoint)` connects to `@acpjs/core`'s `createHostEndpoint(host)` (the client only sees contract types and has zero dependency on core). Reconnection is not a transport obligation; a new connection backfills via `fromSeq`.

## Implementation-defined decisions

- **RPC id format**: `rpc-<n>` (monotonic counter within a client instance).
- **RPC method names**: sourced from `@acpjs/protocol`'s `ACP_RPC_METHODS` (`agents/spawn|authenticate|logout|list`, `sessions/create|load|list|resume|delete|prompt|cancel|close|setMode|setConfigOption|getAll|restore`), the same constant table consumed by core's `createHostEndpoint` (pinned by protocol and end-to-end tests).
- **auth-required facade shape (create-time)**: `sessions.create` does not return a union type; instead it rejects with an `AcpClientError` (`code: 'acpjs/auth-required'`, `retryable: true`, `data.authMethods` is the protocol original). After `authenticate`, the consumer retries create. In parallel the agent's runtime snapshot becomes observable as waiting-for-auth (`authRequired: true` + `authMethods`), driven by the host-level `auth-required` event.
- **store subscription timing**: one store per sessionId; on first acquiring a session handle (create / load / resume / attach) it subscribes from `fromSeq: 0`. Within one client the same sessionId reuses the same store, the same frozen handle, and the same subscription.
- **subscribe does not call back immediately**: consistent with external-store conventions (session state, agent/session registries, connection status, and the permission list all behave this way); read the initial value via `getSnapshot` / `get`.
- **connection status store**: `client.status` maintains a single `ConnectionStatusSnapshot`, advancing `connecting → connected → closed` with the transport lifecycle (termination may carry an `error`); entering `closed` also clears the pending permission snapshot. No duplicate notification when neither status nor error changes.
- **sessions.attach semantics**: does not go through an agent handle — it uses `sessions.list()` to verify the sessionId is still known to the host; if present it creates a store and rebuilds state by replaying from `fromSeq: 0`; an unknown id rejects with `acpjs/session-closed`. Suitable for re-attaching to an existing session across windows / after a page reload.
- **agents/sessions list/restore are one-shot RPC queries**: `agents.list()` / `sessions.list()` / `sessions.restore()` are non-reactive request/response snapshots (for enumeration and hydration), returning wire-level `AgentSnapshot` / `SessionSnapshot` without subscribing to subsequent changes; for reactive observation use the corresponding `getSnapshot` / `subscribe`.
- **permission-request exit**: a request leaves the pending set (and subscribers are notified with a new snapshot) when respond succeeds, when respond is rejected with `acpjs/already-answered` (someone else already answered), or when the owning session's event stream emits `permission-request-resolved` (other-client answer / superseded). A late consumer reading `getSnapshot` only sees still-pending requests. Under multi-client races, a respond rejected with `acpjs/already-answered` is the normal path — the pending list has converged and consumers should ignore that code rather than treat it as an error. Inbound requests whose kind is not `permission` are ignored (forward compatibility).
- **dispose semantics**: mark closed → unsubscribe all store subscriptions → clear permission subscribers and the pending permission set → `transport.close()`; idempotent.
- **in-process direct-call mechanism**: `createInProcessTransport(endpoint)` implements the Transport contract via direct function calls — `request` / `subscribe` / `respondInbound` forward straight to `@acpjs/core`'s `EnvelopeEndpoint` (provided by `createHostEndpoint(host)`), with no JSON serialization and no transport boundary. `connect` wires up inbound requests via `endpoint.onInboundRequest` and advances the lifecycle to `connected`; inbound requests (such as permissions) are handed to the client as-is. Payloads remain structured-clone safe (INV-3, asserted by end-to-end tests). After close, `request` responds with an `acpjs/transport-closed` error, `respondInbound` rejects, and `subscribe` throws an `AcpClientError` (surfacing misuse early); a repeated `connect` throws `acpjs/config-invalid`; `close` is idempotent and unsubscribes all active subscriptions. Reconnection is not part of the contract obligation; a new connection backfills state via `fromSeq`.
- **listener-callback exceptions**: session-state listeners and permission listeners that throw are isolated (swallowed, without interrupting dispatch to the rest of the batch; there is no client-side diagnostic channel).
- **connect failure**: every facade call rejects with the lifecycle error (or `acpjs/transport-closed`).

```

```
