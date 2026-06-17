# @acpjs/core

## 0.3.1

### Patch Changes

- 214cae3: docs: sync package READMEs with the 0.3.0 public surface — document `AcpSession.onEvent` (the typed session event-stream tap with `fromSeq` replay) and the new `@acpjs/client` re-exports, the agent snapshot's `authMethods`, and `ToolCallState.extensions`. No API or behavior change; republished so the npm package pages match the shipped surface.
- Updated dependencies [214cae3]
  - @acpjs/protocol@0.3.1

## 0.3.0

### Minor Changes

- 5c85002: Complete the protocol-faithful surface for UI integrators (all additive, non-breaking):

  - **protocol** — `ToolCallState.extensions` now carries a tool call's `_meta`/extensions through `reduce()`, so agent-emitted structural metadata (e.g. `subagent_session_info`) is reachable. acpjs carries the bag verbatim; it interprets no keys.
  - **protocol/core** — expose the agent's `authMethods` (from the `initialize` response) on `AgentSnapshotWire`, and re-export `AuthMethod`. acpjs still performs no `authenticate` flow — this surfaces the data integrators need to drive out-of-band login.
  - **client** — `AcpSession.onEvent(listener, { fromSeq? })`: a read-only tap on the session's normalized `AcpSessionEvent` stream (with replay-from-seq), so integrators can build projections the single reduced `SessionState` can't express (plan history, per-turn grouping). `reduce`, `createInitialSessionState`, `AcpSessionEvent`, and `SessionState` are now re-exported from `@acpjs/client`.

  See `docs/recipes.md` for integrator recipes and the new "Stability policy" section in `docs/design-philosophy.md` for the `AcpSessionEvent` versioning contract.

### Patch Changes

- Updated dependencies [5c85002]
  - @acpjs/protocol@0.3.0

## 0.2.0

### Minor Changes

- d581617: Headless ACP client toolkit with a strict mechanism-not-decision design.

  **BREAKING:** removed the permission auto-approval policy engine. `permissionPolicy` is gone from session params and the `PermissionPolicyRule` / `PermissionPolicyAction` types are removed. Every `session/request_permission` now floats up as a pending request and is resolved via `respond` — auto-approve in your own app with your own rules (see the README recipe).

  - **core:** the default fs handler rejects non-absolute paths; invalid reverse-request input (bad path / unknown terminal) maps to JSON-RPC `invalidParams` (-32602).
  - **client / react:** new `diagnostics` subscription channel on `AcpClient` and a `useDiagnostics` hook, surfacing agent stderr / spawn / restart diagnostics that were previously dropped.

### Patch Changes

- Updated dependencies [d581617]
  - @acpjs/protocol@0.2.0
