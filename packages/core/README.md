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
  permissionPolicy: [{ kind: 'read', action: 'allow' }],
})

const agent = await host.spawnAgent({
  id: 'my-agent',
  command: 'npx',
  args: ['some-acp-agent'],
})

const created = await host.createSession(agent.agentId, { cwd: process.cwd() })

if (created.status === 'auth-required') {
  await host.authenticate(agent.agentId, created.authMethods[0]?.id ?? '')
  // re-run createSession after authenticating
}

if (created.status === 'active') {
  const { sessionId } = created

  // Subscribe from seq 0 to receive the full backlog plus live events.
  const unsubscribe = host.subscribe(sessionId, 0, (event) => {
    console.log(event.seq, event.type)
  })

  const result = await host.prompt(sessionId, [{ type: 'text', text: 'hello' }])
  // result.stopReason is e.g. 'end_turn'

  unsubscribe()
  await host.closeSession(sessionId)
}

await host.dispose()
```

`createSession` resolves to a discriminated result rather than throwing on
missing auth:

- `{ status: 'active', sessionId }`
- `{ status: 'auth-required', authMethods }` — no session is registered and no
  `sessionId` is fabricated. A host-level `auth-required` event is also
  broadcast (see below).

## Public API

`createAcpHost(options?)` returns an `AcpHost`. The `AcpHost` class is also
exported directly.

- Agents: `spawnAgent(definition)`, `authenticate(agentId, methodId)`,
  `logout(agentId)`, `getAgent(agentId)`, `getAgents()`
- Sessions: `createSession(agentId, { cwd, mcpServers? })`,
  `prompt(sessionId, ContentBlock[])`, `cancel(sessionId)`,
  `closeSession(sessionId)`, `listSessions(agentId, { cursor?, cwd? })`,
  `resumeSession(sessionId)`, `deleteSession(sessionId)`,
  `loadSession(agentId, sessionId, { cwd?, mcpServers? })`,
  `setMode(sessionId, modeId)`,
  `setConfigOption(sessionId, configId, value)`, `getSession(sessionId)`,
  `getSessions()`
- Events: `subscribe(sessionId | undefined, fromSeq, callback)`. Pass `undefined`
  to subscribe to the host stream (agent status changes, `auth-required`,
  diagnostics).
- Permissions: `respondPermission(requestId, outcome)` where `outcome` is the
  protocol `RequestPermissionOutcome`.
- Persistence: `restoreSessions()` rebuilds `disconnected` sessions from storage
  after a host restart and returns their snapshots.
- `dispose()`.

Configuration pipeline (exported for inspection/pre-validation):
`resolveHostOptions`, `resolveAgentDefinition`. Validation failures throw
`AcpError` with code `acpjs/config-invalid` synchronously; the resolved product
is frozen.

Storage adapters: `createMemoryStorage()` (the default) and
`createJsonlStorage(file)`.

Default handlers: `createDefaultFsHandler()`, `createDefaultTerminalHandler()`.
Capability derivation: `deriveClientCapabilities(fs, terminal)` (INV-6) reports
to the agent only the methods a handler actually implements.

Normalization: `normalizeSessionUpdate(update)` maps the 13 `SessionUpdate`
variants to event `type` / `payload` / `extensions`; unmodeled variants
degrade to `unrecognized-update` (INV-4).

Errors: `AcpError` carries a `code` drawn from the closed `ACP_ERROR_CODES`
namespace in `@acpjs/protocol` (`acpjs/config-invalid`,
`acpjs/prompt-in-flight`, `acpjs/already-answered`, `acpjs/session-closed`,
`acpjs/agent-exited`, `acpjs/capability-unsupported`, `acpjs/auth-required`,
`acpjs/agent-error`, `acpjs/transport-closed`).

Envelope adapter: `createHostEndpoint(host)` returns an `EnvelopeEndpoint`
(Transport contract shape). RPC method names come from `ACP_RPC_METHODS` in
`@acpjs/protocol` (`agents/spawn|authenticate|logout|list`,
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

| Field              | Default                                        | Notes                                                                                                   |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `restart`          | `'never'`                                      | With `'on-crash'`, only a `crashed` exit triggers a restart.                                            |
| `restartLimit`     | `3`                                            | Max consecutive restarts; any `ready` resets the counter.                                               |
| `restartBackoff`   | `{ initialMs: 1000, factor: 2, maxMs: 30000 }` | Exponential backoff.                                                                                    |
| `permissionPolicy` | `[]` (everything is escalated)                 | Rules `{ kind?, action: 'allow' \| 'reject' \| 'ask' }`, matched in order.                              |
| `storage`          | in-memory                                      | `StorageAdapter`.                                                                                       |
| `fs` / `terminal`  | built-in Node implementations                  | Replaced wholesale when injected; the injected surface drives the initialize capability report (INV-6). |
| `killTimeoutMs`    | `5000`                                         | dispose graceful-shutdown timeout; SIGKILL after it elapses.                                            |

`HostOptions` is immutable (frozen) once constructed; rebuild the host to change
it.

## Snapshots

`getAgent` / `getAgents` return `AgentSnapshot`:
`{ agentId, status, restartCount, reason?, exit?, capabilities?, authMethods? }`.

`getSession` / `getSessions` return `SessionSnapshot`:
`{ sessionId, status, agentId?, cwd?, agentDefinitionId? }`.

## Host stream and diagnostics

The host stream (subscribed with `subscribe(undefined, fromSeq, cb)`) carries:

- `agent-status-change` — payload `{ status, restartCount, reason?, exit? }`
  (`reason` / `exit` only on `exited`).
- `auth-required` — payload `{ agentId, authMethods }`, emitted when
  `createSession` hits a `-32000` auth error.
- `session-created` / `session-closed` lifecycle announcements.
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
- **auth-required API shape**: `createSession` does not express missing auth as
  an error; it resolves to `{ status: 'auth-required', authMethods }`
  (authMethods come from the cached initialize response) and broadcasts a
  host-level `auth-required` event. No session is registered and no `sessionId`
  is fabricated. A `-32000` during `prompt` moves the session to the
  `auth-required` state and emits a `session-status-change` event carrying
  authMethods. Detection criterion: JSON-RPC `error.code === -32000`.
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
- **resume dedup mechanism**: during `session/load` (auto recovery and explicit
  `loadSession`) a per-session suppression flag is set, so every `session/update`
  the agent replays produces no new event; modes / configOptions from the load
  response synthesize an incremental `session-config-init` event only when
  non-empty (the reducer's full-replace semantics guarantee G2).
- **pre-ready failure inside a restart cycle**: during a restart cycle
  (`restartCount > 0`) spawn/initialize failures keep consuming restart budget
  and retry, making `restart-exhausted` reachable; the first (non-cyclic)
  spawn/initialize failure is not retried.
- **capability gating**: `session/list|resume|close|delete` check
  `sessionCapabilities.<x> != null`; `logout` checks `auth.logout != null`;
  `loadSession` checks the top-level boolean; `set_mode` / `set_config_option`
  check whether the session has ever seen modes / configOptions (in a
  new/load/resume response).
- **permission auto-policy option matching**: `allow` prefers `allow_once` then
  `allow_always`; `reject` likewise. When a rule matches but the request options
  lack the corresponding kind, it falls back to escalation. A rule with no
  `kind` matches anything; a request whose `toolCall.kind` is absent is matched
  only by rules without a `kind`.
- **storage semantics**: `appendEvent` is called synchronously and both sync
  exceptions and async rejections are captured (each becomes a
  `storage/write-failed` diagnostic, which is itself not written to storage, to
  prevent recursion). The memory implementation keeps session events only; the
  JSONL implementation appends to a single file (writes are serialized in a
  queue; one failed write does not block the rest) and scans the whole file for
  `listSessions` / `loadEvents`. `restoreSessions` skips (and diagnoses) stored
  events that are not structured-clone safe; restored sessions are marked
  `disconnected` (no duplicate emit when the trailing event is already
  disconnected).
- **dispose semantics**: all agents are marked `disposed` (terminal reason
  `disposed`), their sessions broadcast `disconnected`, and pending permissions
  are `superseded`.
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
  to the other handlers. Permission push-back — the endpoint subscribes to the
  event streams of the sessions it creates/loads/restores;
  `permission-request-created` is forwarded to all inbound handlers after a
  microtask (those already resolved by auto policy are not forwarded, but the
  event audit trail is retained); still-pending requests are re-sent to
  late-registering handlers; `InboundRequest.id` equals `requestId`;
  `respondInbound` is `respondPermission`, and a second answer is rejected with
  `acpjs/already-answered`.
- **terminal output broadcast boundary**: only the default terminal handler
  (`createDefaultTerminalHandler`) broadcasts a `terminal-output` session event
  via `bus.emitSession` on stdout/stderr data; a custom handler injected through
  `HostOptions.terminal` does not. The delta is a per-chunk raw UTF-8 decode,
  unaffected by the handler-side `outputByteLimit`. The reduce side imposes an
  independent cumulative hard cap of **1 MiB** on
  `SessionState.terminals[id].output`; on overflow it drops from the oldest end
  (the head of the string) along UTF-8 character boundaries (via the protocol's
  `truncateUtf8Tail`) and sets `truncated: true`, keeping the newest tail. Under
  high throughput or multibyte streams the handler view (`terminalOutput` RPC)
  and the reduce view (`state.terminals`) may briefly disagree. The default
  handler's own per-terminal `outputByteLimit` truncation also uses
  `truncateUtf8Tail`, so character boundaries are preserved there too.
- **SessionMeta persistence**: after a successful `createSession`,
  `storage.appendMeta` writes one `{ sessionId, agentDefinitionId, cwd }` record
  (`agentDefinitionId` / `cwd` keys omitted when absent); `restoreSessions`
  reads meta from `storage.listSessions()` and backfills `cwd` /
  `agentDefinitionId` into the rebuilt session, so consumers need not maintain
  their own sessionId-to-cwd/agent mapping. Meta records MUST NOT be returned by
  `loadEvents` as events and do not participate in event replay.
