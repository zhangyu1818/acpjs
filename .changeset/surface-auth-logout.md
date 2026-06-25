---
'@acpjs/protocol': minor
'@acpjs/core': minor
'@acpjs/client': minor
'@acpjs/react': minor
'@acpjs/electron': minor
---

Surface the ACP `authenticate` and `logout` agent-direction RPCs as typed mechanism, and project the stable `auth` capability.

acpjs now sends these calls — it does not pick an auth method, store credentials, or track login state; choosing the `methodId` and when to authenticate remains the integrator's decision (the agent's advertised `authMethods` are still surfaced verbatim on the agent snapshot).

- `@acpjs/core`: `AcpHost.authenticate(agentId, methodId)` sends `authenticate`; `AcpHost.logout(agentId)` sends `logout`, gated on the agent's advertised `auth.logout` capability (rejects with `acpjs/capability-unsupported` otherwise).
- `@acpjs/client` / `@acpjs/react`: `AcpAgent.authenticate(methodId)` and `AcpAgent.logout()` on the agent facade.
- `@acpjs/protocol`: added `agents/authenticate` and `agents/logout` to `ACPJS_HOST_METHODS`; `AgentCapabilitiesSnapshot` now mirrors the stable `auth` capability (`AgentAuthCapabilities`, whose `logout` gates `logout`). The experimental `providers` field stays unmodeled per the stable-surface-only policy.
- `@acpjs/electron`: the renderer client reaches `authenticate` / `logout` through the existing transport with no bridge changes.
