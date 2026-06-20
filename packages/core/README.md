# @acpjs/core

The `AcpHost` runtime for acpjs (Node / Electron). It spawns arbitrary ACP agent
subprocesses, establishes the official SDK connection, normalizes protocol
notifications into numbered `@acpjs/protocol` events with a replayable log, and
provides catch-up subscriptions, permission routing, reverse fs/terminal
capabilities, crash recovery with restart policy, and `StorageAdapter`
scheduling.

## Install

```sh
pnpm add @acpjs/core
```

ESM-only. Requires `node >= 24`. Runtime dependencies: `@acpjs/protocol`,
`@agentclientprotocol/sdk`, and `zod` (an SDK peer).

## Quick start

End to end: spawn an agent, create a session, subscribe, and send a prompt.

```ts
import { createAcpHost } from '@acpjs/core'

const host = createAcpHost({
  restart: 'on-crash',
})

const agent = await host.spawnAgent({
  id: 'my-agent',
  command: 'npx',
  args: ['some-acp-agent'],
})

const created = await host.createSession(agent.agentId, {
  cwd: process.cwd(),
  mcpServers: [],
  additionalDirectories: [],
})

const { sessionId } = created

// Subscribe from seq 0 to receive the full backlog plus live events.
const unsubscribe = host.subscribe(sessionId, 0, (event) => {
  console.log(event.seq, event.type)
})

const result = await host.prompt(sessionId, [{ type: 'text', text: 'hello' }])
// result.stopReason is e.g. 'end_turn'

unsubscribe()
await host.closeSession(sessionId)

await host.dispose()
```

`createSession` resolves to the created `SessionSnapshotWire`. Agent-side
JSON-RPC errors, including authentication-related errors, are propagated to the
caller; acpjs does not model login state.

## Public API

`createAcpHost(options?)` returns an `AcpHost`. The `AcpHost` class is also
exported directly.

- Agents: `spawnAgent(definition)`, `getAgent(agentId)`, `getAgents()`,
  `disposeAgent(agentId)`
- Sessions: `createSession(agentId, { cwd, mcpServers, additionalDirectories })`,
  `prompt(sessionId, ContentBlock[])`, `cancel(sessionId)`,
  `closeSession(sessionId)`, `listSessions(agentId, { cursor?, cwd? })`,
  `resumeSession(agentId, sessionId, { cwd, mcpServers?, additionalDirectories })`,
  `deleteSession(agentId, sessionId)`,
  `loadSession(agentId, sessionId, { cwd, mcpServers, additionalDirectories })`,
  `setMode(sessionId, modeId)`,
  `setConfigOption(sessionId, configId, value)`, `getSession(sessionId)`,
  `getSessions()`
- Events: `subscribe(sessionId | undefined, fromSeq, callback)`. Pass
  `undefined` to subscribe to the host stream (agent/session/permission
  projections and diagnostics).
- Permissions: `respondPermission(requestId, outcome)` where `outcome` is the
  protocol `RequestPermissionOutcome`.
- Persistence: `restoreSessions()` rebuilds `disconnected` sessions from storage
  after a host restart and returns their snapshots.
- `disposeAgent(agentId)`: gracefully tear down a single agent — the per-agent
  counterpart of `dispose()`. Idempotent (a no-op for an unknown or already-gone
  id). The agent's sessions transition to `disconnected` (chat history is
  preserved, **not** closed or deleted), the agent is then removed from
  `getAgents()`, and an `agent-removed` host event (payload `{ agentId }`) is
  emitted.
- `dispose()`.

Configuration pipeline (exported for inspection/pre-validation):
`resolveHostOptions`, `resolveAgentDefinition`. Validation failures throw
`AcpError` with code `acpjs/config-invalid` synchronously; the resolved product
is frozen.

Storage adapters: `createMemoryStorage()` (the default) and
`createJsonlStorage(file)`.

Default fs handler: `createDefaultFsHandler()`. Terminal support is opt-in:
inject a complete handler, such as `createDefaultTerminalHandler()`, through
`HostOptions.terminal`. Capability derivation:
`deriveClientCapabilities(fs, terminal)` (INV-6) reports to the agent only the
methods a handler actually implements.

Normalization: `normalizeSessionUpdate(update)` maps the 13 `SessionUpdate`
variants to event `type` / `payload` / `extensions`; unmodeled variants
degrade to `unrecognized-update` (INV-4).

Errors: `AcpError` carries a `code` drawn from the closed `ACP_ERROR_CODES`
namespace in `@acpjs/protocol` (`acpjs/config-invalid`,
`acpjs/prompt-in-flight`, `acpjs/already-answered`, `acpjs/session-closed`,
`acpjs/agent-exited`, `acpjs/capability-unsupported`,
`acpjs/agent-error`, `acpjs/transport-closed`).

Envelope adapter: `createHostEndpoint(host)` returns an `EnvelopeEndpoint`
(Transport contract shape). RPC method names come from `ACPJS_HOST_RPC_METHODS` in
`@acpjs/protocol` (`agents/spawn|list|dispose`,
`sessions/create|load|list|resume|delete|prompt|cancel|close|setMode|setConfigOption|getAll|restore`)
and map to the same-named host methods. Missing required parameters are
rejected at the envelope boundary with `acpjs/config-invalid`. Event
subscriptions pass through to `host.subscribe`. Permission requests are pushed
back as `InboundRequest` (kind `permission`) and answered through
`respondInbound`. The `@acpjs/client` in-process transport connects to this
endpoint with zero direct dependency on core.

All public method parameters and return values are structured-clone
serializable (events are `@acpjs/protocol` events), so they can be carried over
the Transport contract directly.

## HostOptions

| Field            | Default                                        | Notes                                                                                                   |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `restart`        | `'never'`                                      | With `'on-crash'`, only a `crashed` exit triggers a restart.                                            |
| `restartLimit`   | `3`                                            | Max consecutive restarts; any `ready` resets the counter.                                               |
| `restartBackoff` | `{ initialMs: 1000, factor: 2, maxMs: 30000 }` | Exponential backoff.                                                                                    |
| `storage`        | in-memory                                      | `StorageAdapter`.                                                                                       |
| `fs`             | built-in Node implementation                   | Replaced wholesale when injected; the injected surface drives the initialize capability report (INV-6). |
| `terminal`       | disabled                                       | No terminal capability unless a complete handler with `cleanupSession` is injected.                     |
| `killTimeoutMs`  | `5000`                                         | dispose graceful-shutdown timeout; SIGKILL after it elapses.                                            |

`HostOptions` is immutable (frozen) once constructed; rebuild the host to change
it.

## Snapshots

`getAgent` / `getAgents` return `AgentSnapshotWire`:
`{ agentId, status, restartCount, reason?, exit?, capabilities?, authMethods? }`.

`authMethods` is the agent's advertised auth methods captured from the
`initialize` response (`AuthMethod[]`, re-exported from `@acpjs/protocol`),
surfaced verbatim and omitted until the handshake completes. acpjs still runs no
authenticate flow; this is the data integrators read to drive out-of-band login.

`getSession` / `getSessions` return `SessionSnapshotWire`:
`{ sessionId, status, agentId?, cwd, mcpServers?, additionalDirectories, agentDefinitionId?, title?, updatedAt? }`.

## Host stream and diagnostics

The host stream (subscribed with `subscribe(undefined, fromSeq, cb)`) carries:

- `agent-updated` — full `AgentSnapshotWire` projection.
- `agent-removed` — payload `{ agentId }`; emitted when `disposeAgent` tears down
  an agent and removes it from `getAgents()`.
- `session-updated` — full `SessionSnapshotWire` projection.
- `permission-updated` — host-level permission pending/answered/superseded
  projection.
- `diagnostic` events with the following `code` values: `agent/spawn`,
  `agent/spawn-failed`, `agent/initialized`, `agent/initialize-failed`,
  `agent/exit` (with code/signal), `agent/process-error`, `agent/stderr`,
  `agent/restart-scheduled`, `agent/restart-suppressed`,
  `agent/restart-exhausted`, `agent/kill`, `session/recovery-skipped`,
  `session/load-failed`, `storage/write-failed`, `event/unserializable`,
  `subscriber/error`.

Diagnostics flow on the host stream and never participate in `SessionState`
reduction. The `agent/spawn` diagnostic records only env key names, never values
(INV-7).

## Implementation-defined decisions

- **agentId / requestId format**: `agent-<n>` and `perm-<n>` — monotonic per
  host lifetime, never reused.
- **cwd default**: `AgentDefinition.cwd` defaults to the host process cwd; all
  cwds are absolutized with `path.resolve` before reaching the protocol.
- **kill timeout**: defaults to 5s (`killTimeoutMs` is injectable); dispose ends
  stdin first (graceful), then sends `SIGKILL` on timeout.
- **auth errors**: acpjs runs no authenticate flow and exposes no login APIs or
  auth state; it only surfaces the agent's advertised `authMethods` (see
  Snapshots) for integrators to act on. Agent-side authentication failures are
  propagated as agent JSON-RPC errors; callers configure/login the agent outside
  acpjs and retry.
- **prompt protocol-error event shape**: the `prompt-finished` event (and the
  `prompt` return value) uses `stopReason: 'end_turn'` as a placeholder and
  carries `error: { code, message, data? }`. `prompt` does not reject, except on
  agent crash, which rejects with `acpjs/agent-exited`.
- **normalization key-omission rule**: payload keys whose value is `null` for an
  OPTIONAL field are omitted, except keys whose explicit `null` is preserved:
  `session_info_update`'s `title` / `updatedAt` (clear semantics) and
  `tool_call(_update)`'s `rawInput` / `rawOutput` (any value passed through).
  A top-level `_meta` lands in `extensions._meta`; other unknown top-level
  fields land in `extensions.<key>`. The `unrecognized-update` payload preserves
  the whole update verbatim (including the `sessionUpdate` discriminator).
- **load/resume lifecycle**: unknown load/resume uses a staging session that is
  invisible to `getSessions()` and host/client projections until the agent RPC
  succeeds. Existing load/resume publishes a `resuming` projection but does not
  clear log/config or write success metadata before the RPC commits. `load`
  buffers replayed `session/update` notifications, then emits `session-reset`,
  replay, config, and active status on success. `resume` rejects replayed
  history and only updates config/status.
- **pre-ready failure inside a restart cycle**: during a restart cycle
  (`restartCount > 0`) spawn/initialize failures keep consuming restart budget
  and retry, making `restart-exhausted` reachable; the first (non-cyclic)
  spawn/initialize failure is not retried.
- **capability gating**: `session/list|resume` check
  `sessionCapabilities.<x> != null`; `loadSession` checks the top-level
  boolean; `set_mode` / `set_config_option` check whether the session has ever
  seen modes / configOptions (in a new/load/resume response). Local
  close/delete lifecycle is always available and remote close/delete is
  best-effort when the agent declares support.
- **storage semantics**: event writes are queued and write failures emit
  `storage/write-failed` diagnostics, which are not recursively persisted.
  Lifecycle tombstones for close/delete are strict commits: if they cannot be
  written, the API rejects and the closed/deleted success state is not
  published. JSONL storage skips malformed lines during restore and rewrites via
  a temporary file followed by rename. `restoreSessions` skips closed/deleted
  metadata and stored events that are not structured-clone safe; restored
  sessions are marked `disconnected`.
- **dispose semantics**: all agents are marked `disposed` (terminal reason
  `disposed`), their sessions broadcast `disconnected`, and pending permissions
  are `superseded`.
- **disposeAgent semantics**: `disposeAgent(agentId)` is the per-agent
  counterpart of `dispose()` — it gracefully tears down exactly one agent. It is
  idempotent: an unknown or already-gone id is a no-op. The agent's sessions
  broadcast `disconnected` (history preserved, not closed/deleted) and pending
  permissions are `superseded`; the agent is then removed from `getAgents()` and
  an `agent-removed` host event (payload `{ agentId }`) is emitted on the host
  stream. This is distinct from an involuntary `exited` tombstone, which stays in
  `getAgents()` carrying its exit reason and may restart under the restart
  policy — see docs/design-philosophy.md "Agent lifecycle".
- **clientInfo**: `{ name: '@acpjs/core', version: '0.0.0' }` (version updated by
  the release pipeline).
- **subscription shape**: `subscribe(sessionId?, fromSeq, callback)`; replay
  (`seq > fromSeq`) and live delivery are stitched in one synchronous critical
  section (no duplicates, gaps, or reordering — INV-2). Subscriber callback
  exceptions are isolated and produce a `subscriber/error` diagnostic (a second
  exception while dispatching that diagnostic is swallowed silently, to prevent
  recursion). Host-stream replay continues by index; host events produced during
  replay (including a `subscriber/error` diagnostic raised by this subscriber)
  are all delivered before joining the live set; exceptions while delivering a
  `subscriber/error` diagnostic do not produce new diagnostics (matching the
  live path, to prevent an infinite replay loop).
- **unserializable-payload rejection**: session and host events that do not pass
  structured clone are rejected and produce an `event/unserializable`
  diagnostic (the host-side diagnostic strips the original payload, keeping only
  type and agentId; an `event/unserializable` diagnostic that is itself rejected
  is dropped silently, to prevent recursion).
- **initialize-failure exit backfill**: an initialize failure such as a protocol
  version mismatch first broadcasts `exited(initialize-failed)` (without exit);
  after the process actually exits, `{ code?, signal? }` is backfilled into the
  AgentRecord (visible via `getAgent`) and an `agent/exit` diagnostic is emitted.
- **AgentDefinition.meta**: validated to be an object and shallow-copied + frozen
  into the resolved definition (no deep validation / deep freeze).
- **protocol version negotiation**: if the `initialize` response's
  `protocolVersion !== PROTOCOL_VERSION`, the process is killed and judged
  `initialize-failed` (no downgrade negotiation).
- **storage write-failure retries**: none (best-effort side channel, INV-5).
- **envelope endpoint (`createHostEndpoint`)**: error mapping — an `AcpError` is
  enveloped as-is; an agent-side JSON-RPC error maps to `acpjs/agent-error`
  (original `{ code, message, data? }` placed in `data`); unknown methods and
  missing required parameters are both rejected with `acpjs/config-invalid`.
  Exceptions thrown by an inbound handler are isolated and reported as a
  `subscriber/error` diagnostic event, without interrupting dispatch
  to the other handlers. Permission push-back subscribes to host-level
  `permission-updated` projections, not per-session event streams. Pending
  requests are forwarded as `InboundRequest` with `id === requestId`;
  answered/superseded projections clear outstanding entries. `respondInbound`
  is `respondPermission`, and a second answer is rejected with
  `acpjs/already-answered`.
- **terminal capability boundary**: host default terminal support is disabled.
  A terminal handler must implement create/output/wait/kill/release plus
  `cleanupSession` before `terminal: true` is declared to the agent. close/delete
  call `cleanupSession(sessionId)`. The exported `createDefaultTerminalHandler`
  can be injected by applications that want Node child-process terminals.
- **terminal↔session ownership**: the host records which `sessionId` created
  each `terminalId` (from the `createTerminal` response) and rejects any
  `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal`
  that references a terminal owned by a different session with
  `acpjs/invalid-params`. This boundary is enforced before the handler runs, so
  a custom `TerminalHandler` cannot accidentally leak terminals across the
  agent's sessions — the same trust-boundary guarantee the host already applies
  to session↔agent ownership.
- **SessionMeta persistence**: after successful `createSession` or
  `resumeSession`, `storage.appendMeta` writes protocol config metadata
  (`sessionId`, `agentDefinitionId?`, `cwd`, `mcpServers?`,
  `additionalDirectories`, `title?`, `updatedAt?`). `restoreSessions` rebuilds
  disconnected sessions from meta and event logs. Meta
  records MUST NOT be returned by `loadEvents` as events and do not participate
  in event replay. Destructive `loadSession` builds a replacement session
  history in memory and calls `storage.replaceSession(sessionId, meta, events)`
  as a strict commit before publishing the replacement events to live
  subscribers. `host.dispose()` waits for queued event and metadata writes.
