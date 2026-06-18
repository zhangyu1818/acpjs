# @acpjs/protocol

The foundation layer of acpjs: a normalized event model, the `SessionState`
model, a pure `reduce` reducer, and Transport envelope types for the Agent
Client Protocol (ACP).

This package is **types + pure functions only**. It is environment-neutral: it
references no Node built-ins and has a type-only dependency on
`@agentclientprotocol/sdk`, so it runs unchanged in Node, browsers, and jsdom.

## Installation

```sh
pnpm add @acpjs/protocol
```

ESM-only. Requires `node >= 24`.

## Quick start

`reduce(state, event)` is a pure function. Starting from
`createInitialSessionState(sessionId)`, fold events in `seq` order; the same
event sequence yields a field-for-field identical `SessionState` in any
environment.

```ts
import {
  type AcpEvent,
  createInitialSessionState,
  reduce,
} from '@acpjs/protocol'

const events: AcpEvent[] = [
  {
    sessionId: 'sess-1',
    seq: 1,
    ts: 0,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'Hel' }, messageId: 'm1' },
  },
  {
    sessionId: 'sess-1',
    seq: 2,
    ts: 0,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'lo' }, messageId: 'm1' },
  },
]

let state = createInitialSessionState('sess-1')
for (const event of events) state = reduce(state, event)

// state.messages === [
//   {
//     kind: 'agent',
//     messageId: 'm1',
//     content: [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }],
//     seq: 1,
//   },
// ]
```

`reduce` never mutates its input; it returns a new `SessionState` (or the same
reference unchanged for events it does not reduce).

## Public API

### Event model

- `AcpEvent` — the closed discriminated union of every event, equal to
  `AcpSessionEvent | AcpHostEvent` (19 session events + 6 host events).
- Member interfaces, e.g. `UserMessageChunkEvent`, `AgentMessageChunkEvent`,
  `AgentThoughtChunkEvent`, `ToolCallEvent`, `ToolCallUpdateEvent`, `PlanEvent`,
  `AvailableCommandsUpdateEvent`, `CurrentModeUpdateEvent`,
  `SessionConfigInitEvent`, `ConfigOptionsUpdateEvent`, `SessionInfoUpdateEvent`,
  `UsageUpdateEvent`, `PromptFinishedEvent`, `SessionStatusChangeEvent`,
  `SessionResetEvent`, `PermissionRequestCreatedEvent`,
  `PermissionRequestResolvedEvent`, `TerminalOutputEvent`,
  `UnrecognizedUpdateEvent`, `AgentUpdatedEvent`, `AgentRemovedEvent`,
  `SessionUpdatedEvent`, `PermissionUpdatedEvent`, `InstallProgressEvent`,
  `DiagnosticEvent`.
- Payload types: `SessionConfigInitPayload`, `PromptFinishedPayload`,
  `SessionStatusChangePayload`, `SessionResetPayload`,
  `PermissionRequestCreatedPayload`, `PermissionRequestResolvedPayload`,
  `HostPermissionSnapshot`, `TerminalOutputPayload`, `InstallProgressPayload`,
  `DiagnosticPayload`, `UnrecognizedUpdatePayload`.
- Enums and aliases: `SessionStatus`, `AgentStatus`, `AgentExitReason`,
  `InstallStage`, `DiagnosticLevel`, `AcpEventExtensions`,
  `AcpHostProjectionEvent`, `AcpHostTelemetryEvent`.

Payloads reuse SDK protocol types. The top-level `_meta` field is removed at the
type level (see implementation-defined notes); it surfaces on the envelope as
`extensions` instead.

### State model

- `SessionState` — the derived per-session state.
- Supporting types: `SessionMessage`, `MessageKind`, `ToolCallState`,
  `TerminalOutputState`, `SessionUsageState`, `SessionConnectionState`,
  `PendingPermissionRequest`, `ResolvedPermissionRequest`, `PromptErrorState`.
- `createInitialSessionState(sessionId)` — builds the empty initial state.
- `reduce(state, event)` — the pure reducer.

### Terminal output helper

- `truncateUtf8Tail(output, limitBytes)` — trims a string to at most
  `limitBytes` bytes from the **tail** along UTF-8 character boundaries,
  returning `{ output, truncated }`. The reducer uses it to bound terminal
  buffers; it is exported for callers that need the same byte-bounded, tail-
  preserving truncation.

### Transport envelopes

- `RpcRequest`, `RpcResponse`, `InboundRequest`, `InboundResponse`, `ErrorObject`.
- `InboundRequest.kind` is an open string with one known member, `'permission'`
  (typed as `'permission' | (string & {})`).
- `ACP_ERROR_CODES` — frozen error-code constants in the `acpjs/*` namespace
  (8 codes: `config-invalid`, `prompt-in-flight`, `already-answered`,
  `session-closed`, `agent-exited`, `capability-unsupported`, `agent-error`,
  `transport-closed`), plus the `AcpErrorCode` type and the
  `isAcpErrorCode(value)` guard.

### Transport contract

- `Transport` — `connect(handlers)`, `request(request)`,
  `subscribe(params, onEvent)`, `respondInbound(response)`, `close()`.
- `TransportHandlers` — `onInboundRequest` + `onLifecycle` +
  optional `onSubscriptionError(params, error)`.
- `TransportLifecycleEvent` — `connecting → connected → closed`, with an
  optional `error` on the terminating path.
- `TransportSubscribeParams` — optional `sessionId` + required `fromSeq`.
- `TransportConnectionStatus`, `TransportUnsubscribe`.
- `EnvelopeEndpoint` — the host-side contract endpoint (request + event
  subscription + reverse request + `respondInbound`), with no connection
  lifecycle.

While `connected`, envelope delivery is order-preserving. Reconnection is not a
transport obligation; a new connection backfills using `fromSeq`.

### Wire contract

Shared by `@acpjs/core` and `@acpjs/client` to avoid duplicated literals.

- `ACPJS_HOST_RPC_METHODS` — frozen RPC method-name constants
  (`agents/spawn|list|dispose`,
  `sessions/create|load|list|resume|delete|prompt|cancel|close|setMode|setConfigOption|getAll|restore`),
  pinned by tests, plus the `AcpRpcMethod` type. `agents/dispose` carries
  `disposeAgent(agentId)` across the envelope (the cross-process counterpart of
  the host method / `client.agents.dispose`).
- Shared payload shapes: `AgentDefinition`, `SessionConfigValue`,
  `CreateOrLoadSessionParams`, `ResumeSessionParams`, `CreateSessionResult`,
  `AgentCapabilitiesWire`, `AgentSnapshotWire`, `SessionSnapshotWire`.

### SDK protocol re-exports

Type-only, for contract consumers: `AgentCapabilities`, `AuthMethod`,
`ContentBlock`, `ListSessionsResponse`, `McpServer`,
`RequestPermissionOutcome`, `SessionConfigOption`.

## Event types (closed union)

Session events carry `sessionId` and an in-session `seq`:
`user-message-chunk`, `agent-message-chunk`, `agent-thought-chunk`,
`tool-call`, `tool-call-update`, `plan`, `available-commands-update`,
`current-mode-update`, `session-config-init`, `config-options-update`,
`session-info-update`, `usage-update`, `prompt-finished`,
`session-status-change`, `session-reset`, `permission-request-created`,
`permission-request-resolved`, `terminal-output`, `unrecognized-update`.

Host events carry a host-level `seq`. `AcpHostProjectionEvent` is the product
state projection subset:

- `agent-updated` — top-level `agentId`; payload is the full
  `AgentSnapshotWire`.
- `agent-removed` — `AgentRemovedEvent`, payload `{ agentId }`; emitted when
  `disposeAgent` tears an agent down and removes it from the host registry
  (distinct from an `exited` tombstone, which stays in the registry). Added as a
  new union variant — a non-breaking addition, since consumers already tolerate
  unknown/new variants.
- `session-updated` — full `SessionSnapshotWire` session projection.
- `permission-updated` — host-level permission pending/answered/superseded
  projection.

`AcpHostTelemetryEvent` is the non-state telemetry subset:

- `install-progress` — top-level `agentId`.
- `diagnostic` — `agentId` optional (registry-scope diagnostics have no owning
  agent).

## Implementation-defined notes

- Event type names use kebab-case; the canonical name `unrecognized-update`
  is preserved verbatim.
- Payloads that reuse SDK protocol types are `Omit<…, '_meta'>`, enforcing at
  the type level the rule that top-level `_meta` moves into the envelope's
  `extensions`. Nested structures (e.g. `ContentBlock`, `PlanEntry`) keep their
  native `_meta`.
- `SessionState` is derived state; absent values are placed explicitly as `null`
  (unlike the "omit absent keys" rule for events/protocol payloads), so cross-
  environment deep equality is assertable.
- Message chunk merging: when `messageId` is non-null, the reducer scans from the
  tail for a message matching `(kind, messageId)` (same id is merged even across
  intervening messages). When `messageId` is absent, a chunk merges only with the
  immediately preceding message if it shares the same `kind` and also has no
  `messageId`.
- `tool-call-update`: `null` and absent keys are both treated as "no change"
  (core normalizes `null` away; the reducer handles it defensively).
  `content`/`locations` are replaced wholesale. Updates to an unknown
  `toolCallId` leave state unchanged.
- `ToolCallState.extensions?: AcpEventExtensions` carries a tool call's
  `_meta`/extensions through `reduce` verbatim (e.g.
  `extensions._meta.subagent_session_info`); acpjs interprets no keys.
- `session-info-update`: tri-state semantics follow the SDK — an absent key means
  no change, an explicit `null` clears the field, a string replaces it.
- `prompt-finished` does not change connection status (returning to `active` is
  expressed separately by core via a `session-status-change` event). When
  `usage` is absent, `lastTurnUsage` is cleared (it reflects only the most recent
  turn).
- `session-status-change`: the `resumed` flag is sticky until the next
  `disconnected`/`closed`/`deleted`, which resets it.
- `AgentCapabilitiesWire` is an explicit stable ACP capability projection used
  by acpjs. It intentionally does not mirror SDK experimental/auth/provider
  fields that are outside the acpjs product contract. The agent's advertised
  auth methods are surfaced separately on the snapshot as
  `AgentSnapshotWire.authMethods` (`AuthMethod[]`, the `initialize` response's
  methods verbatim) — acpjs implements no authenticate flow, so this is the data
  integrators read to drive out-of-band login.
- `current-mode-update` arriving before any mode state synthesizes
  `{ currentModeId, availableModes: [] }`.
- `diagnostic` agent attribution is expressed solely by the envelope `agentId`
  (which may be absent — registry-scope diagnostics have no owning agent; the
  payload does not duplicate it). The payload's `sessionId` provides session
  context.
- `InboundRequest.kind` is an open string with one known member, `'permission'`
  (the only inbound request category today); new kinds may be added as they
  stabilize.
- The reducer returns the input state reference unchanged for
  `unrecognized-update`, `diagnostic`, and all host events (they do not
  participate in reduction and never throw).
- The error-code namespace extends the base error codes with two
  contract-level codes:
  `acpjs/agent-error` (an agent-side JSON-RPC error tunneled across the
  envelope, with the original error in `data`) and `acpjs/transport-closed` (a
  call rejected after the transport closed; `retryable: true`).
- Terminal accumulation cap: `reduce` enforces a hard **1 MiB** byte limit on a
  single terminal's `output`. On overflow it discards from the oldest end (the
  head of the string) along UTF-8 character boundaries via `truncateUtf8Tail`,
  preserving the newest tail and setting `truncated: true`.
- `resolvedPermissionRequests` cap: `reduce` keeps at most the **100** most
  recent resolved-permission records (FIFO); on overflow it drops the oldest
  entries.
