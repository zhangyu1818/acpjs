---
'@acpjs/protocol': minor
'@acpjs/core': minor
'@acpjs/client': minor
---

Complete the protocol-faithful surface for UI integrators (all additive, non-breaking):

- **protocol** — `ToolCallState.extensions` now carries a tool call's `_meta`/extensions through `reduce()`, so agent-emitted structural metadata (e.g. `subagent_session_info`) is reachable. acpjs carries the bag verbatim; it interprets no keys.
- **protocol/core** — expose the agent's `authMethods` (from the `initialize` response) on `AgentSnapshotWire`, and re-export `AuthMethod`. acpjs still performs no `authenticate` flow — this surfaces the data integrators need to drive out-of-band login.
- **client** — `AcpSession.onEvent(listener, { fromSeq? })`: a read-only tap on the session's normalized `AcpSessionEvent` stream (with replay-from-seq), so integrators can build projections the single reduced `SessionState` can't express (plan history, per-turn grouping). `reduce`, `createInitialSessionState`, `AcpSessionEvent`, and `SessionState` are now re-exported from `@acpjs/client`.

See `docs/recipes.md` for integrator recipes and the new "Stability policy" section in `docs/design-philosophy.md` for the `AcpSessionEvent` versioning contract.
