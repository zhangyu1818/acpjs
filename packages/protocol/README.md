# @acpjs/protocol

acpjs foundation: normalized `AcpjsEvent` model, `SessionState` model, pure `reduce` reducer, and acpjs host transport contract types. Types + pure functions only — no Node built-ins, type-only SDK dependency, runs unchanged in Node/browser/jsdom.

## Install

```sh
pnpm add @acpjs/protocol
```

ESM-only, `node >= 24`.

## Usage

`reduce(state, event)` is pure. Fold events in `seq` order from `createInitialSessionState(sessionId)`; identical sequences yield field-for-field identical state.

```ts
import {
  createInitialSessionState,
  reduce,
  type AcpjsEvent,
} from '@acpjs/protocol'

const events: AcpjsEvent[] = [
  {
    sessionId: 's',
    seq: 1,
    ts: 0,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'Hel' }, messageId: 'm1' },
  },
  {
    sessionId: 's',
    seq: 2,
    ts: 0,
    type: 'agent-message-chunk',
    payload: { content: { type: 'text', text: 'lo' }, messageId: 'm1' },
  },
]

let state = createInitialSessionState('s')
for (const e of events) state = reduce(state, e)
// state.messages[0].content === [{ type: 'text', text: 'Hello' }]
```

## Exports

### Reducer & state

- `createInitialSessionState(sessionId): SessionState`
- `reduce(state, event): SessionState` — returns a new state (or same reference for events it does not reduce); never mutates input.

### Event model

- `AcpjsEvent` = `AcpjsSessionEvent | AcpjsHostEvent` (19 session + 6 host).
- Session event members: `user-message-chunk`, `agent-message-chunk`, `agent-thought-chunk`, `tool-call`, `tool-call-update`, `plan`, `available-commands-update`, `current-mode-update`, `session-config-init`, `config-options-update`, `session-info-update`, `usage-update`, `prompt-finished`, `session-status-change`, `session-reset`, `permission-request-created`, `permission-request-resolved`, `terminal-output`, `unrecognized-update`.
- Host projection members: `agent-updated`, `agent-removed`, `session-updated`, `permission-updated`. Host telemetry: `install-progress`, `diagnostic`.
- Per-event interfaces (`*Event`), payload types (`*Payload`), and enums: `SessionStatus`, `AgentStatus`, `AgentExitReason`, `InstallStage`, `DiagnosticLevel`, `AcpjsEventExtensions`, `AcpjsHostProjectionEvent`, `AcpjsHostTelemetryEvent`.

### State model

- `SessionState`, `SessionMessage`, `MessageKind`, `ToolCallState`, `TerminalOutputState`, `SessionUsageState`, `SessionConnectionState`, `PendingPermissionRequest`, `ResolvedPermissionRequest`.

### Terminal output helper

- `truncateUtf8Tail(output, limitBytes): { output, truncated }` — tail-preserving UTF-8-byte-bounded truncation.

### Host envelopes & error codes

- `HostRequest`, `HostResponse`, `InboundRequest` (`kind: 'permission' | (string & {})`), `InboundResponse`, `ErrorObject`.
- `ACPJS_ERROR_CODES` — frozen `acpjs/*` codes: `config-invalid`, `prompt-in-flight`, `already-answered`, `session-closed`, `agent-exited`, `capability-unsupported`, `agent-error`, `transport-closed`. Plus `AcpjsErrorCode`, `isAcpjsErrorCode(value)`.

### Host transport contract

- `HostClientTransport` — `connect(handlers)`, `request(request)`, `subscribe(params, onEvent)`, `respondInbound(response)`, `close()`.
- `HostClientTransportHandlers` — `onInboundRequest`, `onLifecycle`, optional `onSubscriptionError(params, error)`.
- `HostClientTransportLifecycleEvent` — `connecting → connected → closed` (optional terminal `error`).
- `HostClientTransportSubscribeParams` — optional `sessionId`, required `fromSeq`.
- `EnvelopeEndpoint` — host-side contract endpoint (no connection lifecycle).

### Host/client method contract

- `ACPJS_HOST_METHODS` — frozen acpjs control-plane method ids: `agents/spawn|list|dispose|authenticate|logout`, `sessions/create|load|list|resume|delete|prompt|cancel|close|setMode|setConfigOption|getAll|restore`. These are acpjs adapter ids, **not** ACP agent method names. Plus `AcpjsHostMethod`.
- Payload shapes: `AgentDefinition`, `SessionConfigValue`, `CreateOrLoadSessionParams`, `ResumeSessionParams`, `CreateSessionResult`, `AgentCapabilitiesSnapshot`, `AgentSnapshot`, `SessionSnapshot`.

### SDK protocol re-exports (type-only)

`AgentCapabilities`, `AuthMethod`, `AvailableCommand`, `ContentBlock`, `Cost`, `ListSessionsResponse`, `McpServer`, `PermissionOption`, `Plan`, `RequestPermissionOutcome`, `SessionConfigOption`, `SessionModeState`, `StopReason`, `ToolCallContent`, `ToolCallLocation`, `ToolCallStatus`, `ToolKind`, `Usage`.

## Key semantics

- Events use kebab-case `type`; payloads reuse SDK types as `Omit<…, '_meta'>` (top-level `_meta` moves to envelope `extensions`; nested `_meta` is preserved).
- `SessionState` is derived; absent values are explicit `null` (enables cross-environment deep equality).
- Message chunk merging: non-null `messageId` merges by `(kind, messageId)` scanning from the tail; null `messageId` merges only with an immediately preceding message of the same kind. Consecutive plain text blocks (no `annotations`/`_meta`) within a message coalesce into one.
- `tool-call-update`: `null`/absent keys mean "no change"; `content`/`locations` replace wholesale; updates to an unknown `toolCallId` leave state unchanged.
- `session-info-update`: absent key = no change, explicit `null` = clear, string = replace.
- `prompt-finished`: does not change connection status; absent `usage` clears `lastTurnUsage`.
- `session-status-change`: `resumed` flag is sticky until `disconnected`/`closed`/`deleted`.
- Terminal accumulation cap: hard **1 MiB** per terminal; overflow discards from the head via `truncateUtf8Tail`, preserving the newest tail.
- Resolved permissions cap: **100** most recent records (FIFO).
- The reducer returns the same reference for `unrecognized-update`, `diagnostic`, and all host events.
