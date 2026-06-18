---
'@acpjs/protocol': minor
'@acpjs/core': minor
'@acpjs/client': minor
---

Add `AcpHost.disposeAgent` / `client.agents.dispose` for single-agent teardown (agent-removed event, agents/dispose wire); document the core-layer config-options read recipe.

- **core** — `AcpHost.disposeAgent(agentId)` gracefully tears down one agent (the per-agent counterpart of `host.dispose()`). It is idempotent (a no-op for an unknown or already-gone id); the agent's sessions transition to `disconnected` with chat history preserved (not closed/deleted), the agent is then removed from `getAgents()`, and a new `agent-removed` host event (payload `{ agentId }`) is emitted. This is distinct from an involuntary `exited` tombstone, which stays in `getAgents()` and may restart.
- **client** — `client.agents.dispose(agentId)` forwards the teardown across the Transport (`agents/dispose` wire method); the agent leaves `client.agents.getSnapshot()` when the `agent-removed` host event arrives.
- **protocol** — new `AgentRemovedEvent` variant (`type: 'agent-removed'`, payload `{ agentId }`) added to the `AcpEvent` / `AcpHostProjectionEvent` union, and the `agents/dispose` method added to `ACPJS_HOST_RPC_METHODS`. Adding a union variant is non-breaking — consumers already tolerate unknown/new variants.

See `docs/recipes.md` for the new "Read a session's config options / modes (core layer)" recipe and `docs/design-philosophy.md` "Agent lifecycle" for the removal-vs-tombstone distinction.
