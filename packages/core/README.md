# @acpjs/core

Node `AcpHost` runtime. Spawns ACP agent subprocesses over the official SDK, normalizes protocol notifications into numbered `@acpjs/protocol` events, replays the log for late subscribers, routes permissions, provides default fs, opt-in terminal handling, crash recovery, and `StorageAdapter` scheduling.

## Install

```sh
pnpm add @acpjs/core
```

ESM-only, `node >= 24`. Runtime deps: `@acpjs/protocol`, `@agentclientprotocol/sdk`, `zod`.

## Usage

```ts
import { createAcpHost } from '@acpjs/core'

const host = createAcpHost({ restart: 'on-crash' })

const agent = await host.spawnAgent({
  id: 'my-agent',
  command: 'npx',
  args: ['some-acp-agent'],
})
const { sessionId } = await host.createSession(agent.agentId, {
  cwd: process.cwd(),
  mcpServers: [],
  additionalDirectories: [],
})

const unsubscribe = host.subscribe(sessionId, 0, (event) =>
  console.log(event.seq, event.type),
)
const result = await host.prompt(sessionId, [{ type: 'text', text: 'hello' }])

unsubscribe()
await host.closeSession(sessionId)
await host.dispose()
```

## Exports

- `createAcpHost(options?): AcpHost` (the `AcpHost` class is also exported)
- `createHostEndpoint(host): EnvelopeEndpoint` — wraps a host as the HostClientTransport endpoint for `@acpjs/client`.
- `AcpError` — carries a host-boundary `code` from `ACPJS_ERROR_CODES` (`acpjs/*`).
- `resolveHostOptions(options)`, `resolveAgentDefinition(definition)` — config pipeline; validation failures throw `AcpError` (`acpjs/config-invalid`); resolved products are frozen.
- `deriveClientCapabilities(fs, terminal)` — reports only the methods a handler implements.
- `normalizeSessionUpdate(update): NormalizedUpdate` — maps the 13 `SessionUpdate` variants to event type/payload/extensions; unmodeled → `unrecognized-update`.
- `createMemoryStorage()`, `createJsonlStorage(file)` — built-in `StorageAdapter`s.
- `createDefaultFsHandler()`, `createDefaultTerminalHandler()`.
- Types: `HostOptions`, `ResolvedHostOptions`, `AgentDefinition`, `ResolvedAgentDefinition`, `FsHandler`, `TerminalHandler`, `RestartBackoff`, `AgentSnapshot`, `SessionSnapshot`, `CreateOrLoadSessionParams`, `ResumeSessionParams`, `CreateSessionResult`, `SessionConfigValue`, `PromptResult`, `EventSubscriber`, `StorageAdapter`, `SessionMeta`, `NormalizedUpdate`.

### `AcpHost` methods

- Agents: `spawnAgent(definition)`, `getAgent(agentId)`, `getAgents()`, `disposeAgent(agentId)`
- Auth: `authenticate(agentId, methodId)` sends the `authenticate` RPC; `logout(agentId)` gated on `auth.logout` capability (else `acpjs/capability-unsupported`). Sends RPC only — does not pick method, store credentials, or track login state.
- Sessions: `createSession(agentId, { cwd, mcpServers, additionalDirectories })`, `loadSession(...)`, `resumeSession(...)`, `listSessions(agentId, { cursor?, cwd? })`, `deleteSession(agentId, sessionId)`, `prompt(sessionId, ContentBlock[])`, `cancel(sessionId)`, `closeSession(sessionId)`, `setMode(sessionId, modeId)`, `setConfigOption(sessionId, configId, value)`, `getSession(sessionId)`, `getSessions()`
- Events: `subscribe(sessionId | undefined, fromSeq, callback)` — pass `undefined` for the host stream (agent/session/permission projections + diagnostics).
- Permissions: `respondPermission(requestId, outcome)`
- Recovery: `restoreSessions()` — rebuilds `disconnected` sessions from storage.
- `dispose()`, `disposeAgent(agentId)` (idempotent; sessions → `disconnected`, agent removed from registry, emits `agent-removed`).

## HostOptions

| Field            | Default                                        | Notes                                                                      |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `restart`        | `'never'`                                      | `'on-crash'` restarts only on a `crashed` exit.                            |
| `restartLimit`   | `3`                                            | Max consecutive restarts; `ready` resets the counter.                      |
| `restartBackoff` | `{ initialMs: 1000, factor: 2, maxMs: 30000 }` | Exponential backoff.                                                       |
| `storage`        | in-memory                                      | `StorageAdapter`.                                                          |
| `fs`             | built-in Node fs                               | Replaced wholesale when injected; drives the initialize capability report. |
| `terminal`       | disabled                                       | Requires a complete handler with `cleanupSession`.                         |
| `killTimeoutMs`  | `5000`                                         | dispose graceful-shutdown timeout; SIGKILL after.                          |

Frozen once constructed; rebuild the host to change it.

## Snapshots

- `AgentSnapshot`: `{ agentId, status, restartCount, reason?, exit?, capabilities?, authMethods? }`. `authMethods` = advertised methods from `initialize` (read this to pick a `methodId` for `authenticate`). `capabilities.auth.logout` gates `logout`.
- `SessionSnapshot`: `{ sessionId, status, agentId?, cwd, mcpServers?, additionalDirectories, agentDefinitionId?, title?, updatedAt? }`.

## Host stream diagnostics (`code` values)

`agent/spawn`, `agent/spawn-failed`, `agent/initialized`, `agent/initialize-failed`, `agent/exit`, `agent/process-error`, `agent/stderr`, `agent/restart-scheduled`, `agent/restart-suppressed`, `agent/restart-exhausted`, `agent/kill`, `session/recovery-skipped`, `session/load-failed`, `storage/write-failed`, `event/unserializable`, `subscriber/error`. Diagnostics never participate in `SessionState` reduction. `agent/spawn` records env key names only, never values.

## Key semantics

- **agentId / requestId**: `agent-<n>` / `perm-<n>`, monotonic per host lifetime, never reused.
- **cwd**: `AgentDefinition.cwd` defaults to host process cwd; absolutized via `path.resolve`.
- **prompt protocol errors**: `prompt` rejects on agent JSON-RPC errors (does not fabricate a `StopReason`); envelope callers receive `acpjs/agent-error` with the original error in `data`.
- **normalization key-omission**: `null` optional fields are omitted, except `session_info_update` `title`/`updatedAt` (clear) and `tool_call(_update)` `rawInput`/`rawOutput` (passthrough). Top-level `_meta` → `extensions._meta`; other unknown fields → `extensions.<key>`.
- **capability gating**: `session/list|resume` check `sessionCapabilities.<x> != null`; `loadSession` checks the top-level boolean; `set_mode`/`set_config_option` check whether modes/configOptions were ever seen. Local close/delete always available; remote close/delete is best-effort and resolves on the local tombstone (does not wait for ACP ACK).
- **load/resume staging**: unknown load/resume is invisible until the RPC succeeds. `load` buffers replayed updates, then emits `session-reset` + replay + config + active; `resume` rejects replayed history.
- **restart pre-ready failures**: during a restart cycle, spawn/initialize failures keep consuming restart budget; the first (non-cyclic) failure is not retried.
- **storage**: event writes are queued; failures emit `storage/write-failed` (not retried). Close/delete tombstones are strict commits — if unwritable, the API rejects. `restoreSessions` skips closed/deleted and non-clone-safe events; restored sessions are `disconnected`.
- **terminal ownership**: the host records the owning `sessionId` per `terminalId` and rejects cross-session terminal ops with `acpjs/invalid-params`.
- **protocol version**: `initialize` response `protocolVersion !== PROTOCOL_VERSION` → process killed, judged `initialize-failed` (no downgrade).
- **unserializable payloads**: events failing structured clone are rejected → `event/unserializable` diagnostic.
