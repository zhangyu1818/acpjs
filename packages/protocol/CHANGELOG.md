# @acpjs/protocol

## 0.5.0

### Minor Changes

- b6a0f0b: Reopen a `closed` session via `session/load`, coalesce streamed text, and drop the client handle on close so a reopen yields a fresh handle.

  - **protocol** — `reduce` now coalesces consecutive **plain text** blocks within a message into one (`text` concatenated, no separator), so a streamed reply is a single text block instead of one block per delta. "Plain" means the block carries no `annotations` and no `_meta`; if either side carries those fields the blocks are kept separate (and a non-text block always breaks the run) to preserve per-block metadata.
  - **core** — `loadSession` can now **reopen** a `closed` session: it clears the closed tombstone, re-loads the session from the agent, and rebuilds state via replay. A `deleted` session stays permanently rejected (`acpjs/session-closed`).
  - **client** — `applySessionProjection` now drops the session handle for `closed` (previously only `deleted`), so `client.sessions.get(sessionId)` returns `undefined` once a session is closed and a later reopen (load / attach) builds a **new** handle rather than reviving the old one.

- 7ce1084: Surface the full reduced-state type vocabulary and enforce terminal↔session ownership at the host boundary.

  - **protocol** — re-export the remaining SDK protocol types that `SessionState` / `ToolCallState` already expose: `AvailableCommand`, `Cost`, `PermissionOption`, `Plan`, `SessionModeState`, `StopReason`, `ToolCallContent`, `ToolCallLocation`, `ToolCallStatus`, `ToolKind`, `Usage` (joining the existing `ContentBlock` / `SessionConfigOption` / `AuthMethod` / `McpServer` / etc.). Integrators can now type a reduced session entirely from `@acpjs/protocol` instead of reaching into `@agentclientprotocol/sdk` or maintaining parallel enum copies that drift from the protocol. Additive, non-breaking.
  - **core** — the host now records which `sessionId` created each `terminalId` and rejects `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal` calls that reference a terminal owned by a different session (`acpjs/invalid-params`, "terminal belongs to another session"). The check runs before the injected `TerminalHandler`, so a custom handler can no longer accidentally drop this isolation — the same trust-boundary guarantee already applied to session↔agent ownership. Cross-session terminal access was never valid, so this is a hardening fix.
  - **core** — `disposeAgent` is now idempotent under concurrent calls, not just sequential ones. The agent is removed from the runtime registry synchronously before awaiting the process teardown, so two overlapping `disposeAgent(sameId)` calls no longer both pass the existence guard — `dispose` runs once and `agent-removed` is emitted at most once. No public API or type change.

## 0.4.0

### Minor Changes

- 4e438f4: Add `AcpHost.disposeAgent` / `client.agents.dispose` for single-agent teardown (agent-removed event, agents/dispose host adapter method); document the core-layer config-options read recipe.

  - **core** — `AcpHost.disposeAgent(agentId)` gracefully tears down one agent (the per-agent counterpart of `host.dispose()`). It is idempotent (a no-op for an unknown or already-gone id); the agent's sessions transition to `disconnected` with chat history preserved (not closed/deleted), the agent is then removed from `getAgents()`, and a new `agent-removed` host event (payload `{ agentId }`) is emitted. This is distinct from an involuntary `exited` tombstone, which stays in `getAgents()` and may restart.
  - **client** — `client.agents.dispose(agentId)` forwards the teardown across the HostClientTransport (`agents/dispose` host adapter method); the agent leaves `client.agents.getSnapshot()` when the `agent-removed` host event arrives.
  - **protocol** — new `AgentRemovedEvent` variant (`type: 'agent-removed'`, payload `{ agentId }`) added to the `AcpjsEvent` / `AcpjsHostProjectionEvent` union, and the `agents/dispose` method added to `ACPJS_HOST_METHODS`. Adding a union variant is non-breaking — consumers already tolerate unknown/new variants.

  See `docs/recipes.md` for the new "Read a session's config options / modes (core layer)" recipe and `docs/design-philosophy.md` "Agent lifecycle" for the removal-vs-tombstone distinction.

## 0.3.1

### Patch Changes

- 214cae3: docs: sync package READMEs with the 0.3.0 public surface — document `AcpSession.onEvent` (the typed session event-stream tap with `fromSeq` replay) and the new `@acpjs/client` re-exports, the agent snapshot's `authMethods`, and `ToolCallState.extensions`. No API or behavior change; republished so the npm package pages match the shipped surface.

## 0.3.0

### Minor Changes

- 5c85002: Complete the protocol-faithful surface for UI integrators (all additive, non-breaking):

  - **protocol** — `ToolCallState.extensions` now carries a tool call's `_meta`/extensions through `reduce()`, so agent-emitted structural metadata (e.g. `subagent_session_info`) is reachable. acpjs carries the bag verbatim; it interprets no keys.
  - **protocol/core** — expose the agent's `authMethods` (from the `initialize` response) on `AgentSnapshot`, and re-export `AuthMethod`. acpjs still performs no `authenticate` flow — this surfaces the data integrators need to drive out-of-band login.
  - **client** — `AcpSession.onEvent(listener, { fromSeq? })`: a read-only tap on the session's normalized `AcpjsSessionEvent` stream (with replay-from-seq), so integrators can build projections the single reduced `SessionState` can't express (plan history, per-turn grouping). `reduce`, `createInitialSessionState`, `AcpjsSessionEvent`, and `SessionState` are now re-exported from `@acpjs/client`.

  See `docs/recipes.md` for integrator recipes and the new "Stability policy" section in `docs/design-philosophy.md` for the `AcpjsSessionEvent` versioning contract.

## 0.2.0

### Minor Changes

- d581617: Headless ACP client toolkit with a strict mechanism-not-decision design.

  **BREAKING:** removed the permission auto-approval policy engine. `permissionPolicy` is gone from session params and the `PermissionPolicyRule` / `PermissionPolicyAction` types are removed. Every `session/request_permission` now floats up as a pending request and is resolved via `respond` — auto-approve in your own app with your own rules (see the README recipe).

  - **core:** the default fs handler rejects non-absolute paths; invalid reverse-request input (bad path / unknown terminal) maps to JSON-RPC `invalidParams` (-32602).
  - **client / react:** new `diagnostics` subscription channel on `AcpClient` and a `useDiagnostics` hook, surfacing agent stderr / spawn / restart diagnostics that were previously dropped.
