# acpjs Design Philosophy

acpjs is a headless, layered TypeScript toolkit that plays the **Client role** of the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). It **packages the protocol** —
it does not build a product on top of it.

## The one rule: mechanism, not decision

Before adding any capability, ask whether it is **mechanism** or **decision**.

- **Mechanism — acpjs owns it.** Faithfully package the protocol and expose a clean,
  serializable, replayable surface:
  - spawn and manage agent processes, drive the JSON-RPC connection, normalize the event stream
  - one pure reducer producing field-for-field consistent `SessionState` for every subscriber
  - surface reverse requests (permission / fs / terminal) as data, track pending, route responses back
  - replay/persist the event log, supersede on cancel, carry everything across a serializable
    Transport boundary (in-process or cross-process)
  - provide a sane, **replaceable** default fs handler; terminal handling is injected (ACP requires
    the client to perform the fs/terminal work it advertises)

- **Decision — the integrator owns it.** Anything ACP leaves to the client is surfaced,
  never decided inside acpjs:
  - whether to approve a permission and which option to pick
  - how to group sessions into projects / workspaces
  - retries, batching, scheduling, unattended automation
  - authentication (the agent logs in out of band)
  - which content types / MCP transports to send

"No business logic" does not mean "give the integrator less." It means **never decide on their
behalf** — and make delegation cheap by keeping the surface complete and serializable. Convenience
patterns (e.g. auto-approving permissions) are **documented recipes built on the public surface**,
not code baked into the toolkit.

## Intentional non-goals (owned by the integrator, not gaps)

- **Authentication** — acpjs implements no `authenticate` flow; an agent's authentication error
  propagates through to the integrator, who handles login out of band.
- **Project / workspace** — ACP has only per-session `cwd` + `additionalDirectories`; grouping and
  indexing are app-layer concerns.
- **Permission decisions** — every `session/request_permission` floats up; the integrator decides
  via `respond`. There is no policy engine.
- **Automation & orchestration** — imperative `prompt` + a subscribable event stream; the integrator
  composes the rest.
- **Persistence by default** — in-memory (no side effects); inject JSONL or a custom `StorageAdapter`
  for durable history.
- **Input validation** — prompt content types and MCP transports pass through for the agent to validate.
- **Incremental plan updates** — `plan_update` / `plan_removed` are UNSTABLE in ACP; only the full
  plan snapshot is supported until they stabilize.

## Shape

- **One-directional layering**: `protocol` ← `core` / `client` / `registry`; `react` → `client`;
  `electron(main)` → `core`.
- The only boundary is the **Transport contract** (request/response + event push + reverse requests);
  all payloads are structured-clone safe, so the same client works in-process or across a process boundary.
- **Closed, typed surface** — every stable protocol capability has a typed entry point; there is no
  raw-RPC escape hatch. When the protocol grows, the toolkit grows with it.

See the [root README](../README.md) for the architecture diagram, packages, and usage.
