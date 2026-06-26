---
'@acpjs/protocol': minor
'@acpjs/core': minor
---

Expose the agent's `agentInfo` (ACP `Implementation`: name/title/version) on `AgentSnapshot`, and bump `@agentclientprotocol/sdk` to `^1.0.0`.

- **`AgentSnapshot.agentInfo?`** (`@acpjs/protocol`) now surfaces the agent's `Implementation` metadata captured from the `initialize` response, alongside the existing `capabilities` / `authMethods`. The field is optional and omitted until the handshake completes. `@acpjs/core` captures it during initialization and includes it in `agentSnapshot()`; downstream `@acpjs/client` / `@acpjs/react` / `@acpjs/electron` receive it automatically via re-exported `AgentSnapshot`.
- **SDK bump `^0.29.0 → ^1.0.0`**: a purely additive upgrade (no breaking changes). The only schema change is the optional, UNSTABLE `session.configOptions.boolean` client capability and its `ClientSessionCapabilities` / `SessionConfigOptionsCapabilities` / `BooleanConfigOptionCapabilities` types. No other code changes were required.
