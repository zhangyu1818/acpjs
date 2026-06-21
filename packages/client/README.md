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

const session = await agent.sessions.create({
  cwd: process.cwd(),
  mcpServers: [],
  additionalDirectories: [],
})
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

The facade export surface is exactly three values: `createAcpClient`, `createInProcessTransport`, and `AcpClientError` (pinned by an API snapshot test). There is no raw RPC send, no raw protocol notification subscription, and no store selector parameter. For one-import client-side projections, two pure `@acpjs/protocol` values are re-exported alongside them — `reduce` and `createInitialSessionState` — together with the types `AcpSessionEvent`, `SessionState`, and `SessionEventOptions` (so a projection over `session.onEvent` needs no second import).

- `createAcpClient({ transport })` → `AcpClient`
  - `client.agents.spawn(definition)` → `Promise<AcpAgent>`. `definition` is an `AgentDefinition` (`id`, `command`, `args?`, `env?`, `cwd?`, `meta?`). Read runtime capabilities from `agent.getSnapshot().capabilities`; this projection exposes only acpjs-supported stable ACP capabilities and excludes auth/provider configuration surfaces (the agent's advertised auth methods are surfaced separately as `agent.getSnapshot().authMethods`).
  - `client.agents.get(agentId)` → `AcpAgent | undefined`: look up a known handle by id (same reference returned by spawn / attach).
  - `client.agents.getSnapshot()` → `readonly AcpAgent[]`: cached immutable snapshot of the handle set — a new reference is produced only when the set changes (`useSyncExternalStore` compatible).
  - `client.agents.subscribe(() => ...)`: notification when the agent handle set changes (no immediate callback; read the initial value via `getSnapshot`).
  - `client.agents.list()` → `Promise<readonly AgentSnapshotWire[]>`: a one-shot RPC query of every agent known to the host (`agentId` / `status` / `restartCount` / `reason?` / `exit?` / `capabilities?`), non-reactive.
  - `client.agents.attach(agentId)` → `Promise<AcpAgent>`: hydrate an agent that already exists on the host into a handle (internally calls `list()` to verify existence). An unknown id rejects with `acpjs/agent-exited`; an existing handle is reused.
  - `client.agents.dispose(agentId)` → `Promise<void>`: gracefully tear down a single agent (the per-agent counterpart of disposing the whole host). Idempotent — an unknown or already-gone id resolves as a no-op. The agent's sessions transition to `disconnected` (chat history preserved, not closed/deleted), the agent is removed from the host (it leaves `client.agents.getSnapshot()` when the `agent-removed` host event arrives), forwarded over the `agents/dispose` wire method.
  - `client.sessions.get(sessionId)` → `AcpSession | undefined`: look up a known session handle by id. While a session is live, create / load / resume / attach for the same sessionId share one frozen handle. When the session becomes `closed` or `deleted`, its handle is dropped from the client (`get` returns `undefined`); a later reopen (load / attach) builds a **new** handle rather than reviving the old one.
  - `client.sessions.getSnapshot()` → `readonly AcpSession[]`: cached immutable snapshot of the host-projected session handle set.
  - `client.sessions.subscribe(() => ...)`: notification when the session handle set changes.
  - `client.sessions.list()` → `Promise<readonly SessionSnapshotWire[]>`: a one-shot RPC query of every session known to the host (`sessionId` / `status` / `agentId?` / `cwd` / `mcpServers?` / `additionalDirectories` / `agentDefinitionId?`), non-reactive.
  - `client.sessions.attach(sessionId)` → `Promise<AcpSession>`: re-attach to an existing session **without an agent handle** (internally calls `list()`; if present it subscribes and rebuilds state via replay from `fromSeq: 0`). An unknown id rejects with `acpjs/session-closed`. Re-attaching after the old handle was dropped (e.g. a session reopened from `closed`) returns a fresh handle, not the previous reference.
  - `client.sessions.restore()` → `Promise<readonly SessionSnapshotWire[]>`: after a host restart, rebuild `disconnected` sessions from storage and return their snapshots.
  - `client.permissions.getSnapshot()` → `readonly PermissionRequest[]`: cached immutable reference of the pending permission-request list — a new reference is produced only when the set changes.
  - `client.permissions.subscribe((requests) => ...)`: notification with the latest snapshot on any add/remove of the pending set (new request, respond, other-client answer / superseded); no immediate callback (read the initial value via `getSnapshot`). Each `request` carries `requestId` / `sessionId` / `toolCall` / `options` (protocol pass-through) and `respond(outcome)`.
  - `client.diagnostics.getSnapshot()` → `readonly DiagnosticEvent[]`: cached immutable snapshot of the diagnostic log — a bounded buffer of the most recent 200 events (oldest evicted), surfacing agent diagnostics such as `stderr`, `spawn-failed`, `restart-scheduled` (with backoff), and `process-error`.
  - `client.diagnostics.subscribe(() => ...)`: notification when a new diagnostic arrives (no immediate callback; read the initial value via `getSnapshot`).
  - `client.status.getSnapshot()` → `ConnectionStatusSnapshot` (`{ status: 'connecting' | 'connected' | 'closed', error? }`): cached immutable snapshot of the connection status.
  - `client.status.subscribe(() => ...)`: notification when the connection status changes (no immediate callback; read the initial value via `getSnapshot`).
  - `client.dispose()`: close the transport; afterwards every call rejects with `acpjs/transport-closed`.
- `AcpAgent`
  - `agent.agentId`: readonly handle property.
  - `agent.getSnapshot()` → `AgentSnapshotWire`: cached immutable snapshot of this agent's runtime state (`status` / `restartCount` / `reason?` / `exit?` / `capabilities?` / `authMethods?`). It is driven by host-level `agent-updated` projections. `authMethods?` is the agent's advertised auth methods from the `initialize` response, surfaced verbatim — acpjs implements no `authenticate` flow, so this is the data integrators use to drive out-of-band login.
  - `agent.subscribe(() => ...)`: notification when the runtime state changes (no immediate callback; read the initial value via `getSnapshot`).
  - `agent.sessions.create({ cwd, mcpServers, additionalDirectories })` / `load(sessionId, { cwd, mcpServers, additionalDirectories })` / `list({ cursor?, cwd? })` / `resume(sessionId, { cwd, mcpServers?, additionalDirectories })` / `delete(sessionId)`.
- `AcpSession`
  - `session.sessionId`: readonly id.
  - `session.getSnapshot()` → `SessionState`: cached immutable reference — a new reference is produced only when a new event arrives (`useSyncExternalStore` compatible).
  - `session.subscribe((state) => ...)`: notification when state changes (the current value is not replayed; read the initial value via `getSnapshot`).
  - `session.onEvent((event) => ..., options?)` → `() => void`: a read-only tap on this session's normalized `AcpSessionEvent` stream, opening an **independent** subscription (it never perturbs `subscribe` / `getSnapshot`) and returning an unsubscribe fn. `options` is `SessionEventOptions` (`{ readonly fromSeq?: number }`): omitting it is live-only (`fromSeq` defaults to the current `lastSeq`, no historical re-delivery), while `{ fromSeq: 0 }` replays the full current-epoch log in `seq` order and then streams live with no gap and no duplicate. Use it for projections the single reduced `SessionState` cannot express (plan history, per-turn grouping). Caveat: `seq` is per-session and per-load-epoch — it resets on `session-reset` (`loadSession`) and is **not** a durable cross-load cursor (see docs/design-philosophy.md "Stability policy" and docs/recipes.md).
  - `session.prompt(ContentBlock[])` → `Promise<PromptFinishedPayload>`: protocol content blocks passed through with no rewriting. Also `cancel()`, `close()`, `setMode(modeId)`, `setConfigOption(configId, value)`.
- Slash commands are not a separate API: `SessionState.availableCommands` only enumerates available commands for autocompletion UI. To invoke a command, write a `/`-prefixed text block in the prompt, which may be mixed with other blocks — `session.prompt([{ type: 'text', text: '/web query' }])`. There is no `invokeCommand`-style method.
- Every error is an `AcpClientError` (an `ErrorObject` shape: `code` (acpjs/\*), `message`, `data?`, `retryable`). A capability-gated method whose capability was not declared rejects with `acpjs/capability-unsupported` (core semantics passed through); a second answer to a permission rejects with `acpjs/already-answered`.

## State construction

The only client-side state-construction path: the transport receives an `AcpEvent` → the `reduce` function from `@acpjs/protocol` replays it in `seq` order. Subscriptions carry `fromSeq`; a late subscriber / reconnection is backfilled by replay and ends up deeply equal to a full-duration subscriber (INV-2). A duplicate event whose `seq` was already applied is ignored.

## Transport

The client consumes the Transport contract from `@acpjs/protocol` (`connect` / `request` / `subscribe` / `respondInbound` / `close`, with lifecycle `connecting → connected → closed` plus an error termination path). The built-in `createInProcessTransport(endpoint)` connects to `@acpjs/core`'s `createHostEndpoint(host)` (the client only sees contract types and has zero dependency on core). Reconnection is not a transport obligation; a new connection backfills via `fromSeq`.

## Implementation-defined decisions

- **RPC id format**: `rpc-<n>` (monotonic counter within a client instance).
- **RPC method names**: sourced from `@acpjs/protocol`'s `ACPJS_HOST_RPC_METHODS` (`agents/spawn|list|dispose`, `sessions/create|load|list|resume|delete|prompt|cancel|close|setMode|setConfigOption|getAll|restore`), the same constant table consumed by core's `createHostEndpoint` (pinned by protocol and end-to-end tests).
- **auth errors**: acpjs runs no `authenticate` flow and exposes no login APIs or auth state; it only surfaces the agent's advertised `authMethods` (see `agent.getSnapshot().authMethods` above) for the integrator to drive out-of-band login. Agent-side authentication failures during create/load/resume reject as `AcpClientError` with `code: 'acpjs/agent-error'` and the original JSON-RPC error in `data`; prompt-time agent JSON-RPC errors resolve in `PromptFinishedPayload.error`.
- **host projection mirror**: agent/session registries are reactive mirrors of the host stream. A session created by Node/main or another renderer appears in `client.sessions.getSnapshot()` when the client receives `session-updated`; no local create/attach call is required. Symmetrically, an agent disposed on the host (via `disposeAgent`, by this client or another) leaves `client.agents.getSnapshot()` when the client receives the `agent-removed` host event.
- **store subscription timing**: one store per sessionId; on first acquiring a session handle from create / load / resume / attach or from a host `session-updated` projection it subscribes from `fromSeq: 0`. Within one client the same sessionId reuses the same store, the same frozen handle, and the same subscription. Host projections also update the store's connection status/title fields so list UI can reflect status changes before a prompt event arrives.
- **subscribe does not call back immediately**: consistent with external-store conventions (session state, agent/session registries, connection status, and the permission list all behave this way); read the initial value via `getSnapshot` / `get`.
- **connection status store**: `client.status` maintains a single `ConnectionStatusSnapshot`, advancing `connecting → connected → closed` with the transport lifecycle (termination may carry an `error`); entering `closed` also clears the pending permission snapshot. No duplicate notification when neither status nor error changes.
- **sessions.attach semantics**: does not go through an agent handle — it uses `sessions.list()` to verify the sessionId is still known to the host; if present it creates a store and rebuilds state by replaying from `fromSeq: 0`; an unknown id rejects with `acpjs/session-closed`. Suitable for re-attaching to an existing session across windows / after a page reload.
- **agents/sessions list/restore are one-shot RPC queries**: `agents.list()` / `sessions.list()` / `sessions.restore()` are request/response snapshots for enumeration and hydration, returning wire-level `AgentSnapshotWire` / `SessionSnapshotWire`. Reactive observation uses host projections through the corresponding `getSnapshot` / `subscribe` registries.
- **permission-request source and exit**: pending permissions are sourced from host-level `permission-updated` projections. Inbound requests are only the response transport path and are not treated as permission state. A request leaves the pending set (and subscribers are notified with a new snapshot) when respond succeeds, when respond is rejected with `acpjs/already-answered` (someone else already answered), or when the host emits `permission-updated` with answered/superseded. A late consumer reading `getSnapshot` only sees still-pending requests. Under multi-client races, a respond rejected with `acpjs/already-answered` is the normal path — the pending list has converged and consumers should ignore that code rather than treat it as an error.
- **dispose semantics**: mark closed → unsubscribe all store subscriptions → clear permission subscribers and the pending permission set → `transport.close()`; idempotent.
- **in-process direct-call mechanism**: `createInProcessTransport(endpoint)` implements the Transport contract via direct function calls — `request` / `subscribe` / `respondInbound` forward straight to `@acpjs/core`'s `EnvelopeEndpoint` (provided by `createHostEndpoint(host)`), with no JSON serialization and no transport boundary. `connect` wires up inbound requests via `endpoint.onInboundRequest` and advances the lifecycle to `connected`; inbound requests (such as permissions) are handed to the client as-is. Payloads remain structured-clone safe (INV-3, asserted by end-to-end tests). After close, `request` responds with an `acpjs/transport-closed` error, `respondInbound` rejects, and `subscribe` throws an `AcpClientError` (surfacing misuse early); a repeated `connect` throws `acpjs/config-invalid`; `close` is idempotent and unsubscribes all active subscriptions. Reconnection is not part of the contract obligation; a new connection backfills state via `fromSeq`.
- **listener-callback exceptions**: session-state listeners and permission listeners that throw are isolated (swallowed, without interrupting dispatch to the rest of the batch).
- **diagnostics store**: `client.diagnostics` maintains a bounded log (most recent `MAX_DIAGNOSTICS = 200`; oldest evicted) of host-projected `diagnostic` events, surfacing agent stderr, spawn-failed, restart-scheduled (with backoff), and process-error. `getSnapshot` returns a frozen `readonly DiagnosticEvent[]` and `subscribe` notifies on each new event (no immediate callback). Diagnostic-listener exceptions are isolated like the other channels.
- **connect failure**: every facade call rejects with the lifecycle error (or `acpjs/transport-closed`).
