# acpjs Design Philosophy

acpjs is a headless, layered TypeScript toolkit that plays the **Client role** of the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). It drives official ACP traffic
through the SDK and packages the resulting updates into acpjs projections and adapters —
it does not define a parallel protocol or build a product on top of it.

## The one rule: mechanism, not decision

Before adding any capability, ask whether it is **mechanism** or **decision**.

- **Mechanism — acpjs owns it.** Faithfully drive ACP through the SDK and expose a clean,
  serializable, replayable surface:
  - spawn and manage agent processes, drive the JSON-RPC connection, normalize the event stream
  - one pure reducer producing field-for-field consistent `SessionState` for every subscriber
  - surface reverse requests (permission / fs / terminal) as data, track pending, route responses back
  - replay/persist the event log, supersede on cancel, carry everything across a serializable
    HostClientTransport boundary (in-process or cross-process)
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

- **Authentication** — acpjs surfaces the `authenticate`/`logout` RPCs as typed mechanism but stores
  no credentials and tracks no login state; an agent's authentication error still propagates through
  to the integrator. The agent's advertised `authMethods` (from `initialize`) are surfaced verbatim
  on the agent snapshot — sending the RPC is mechanism; choosing the method and when to authenticate
  is the integrator's decision.
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
- The host/client boundary is the **acpjs HostClientTransport contract** (request/response + event push + reverse requests);
  all payloads are structured-clone safe, so the same client works in-process or across a process boundary.
- **Closed, typed surface** — every stable protocol capability has a typed entry point; there is no
  raw ACP-method escape hatch. When the protocol grows, the toolkit grows with it.

## Stability policy

`AcpjsSessionEvent` and the per-session stream it travels on (surfaced via `onEvent`) are a **public,
versioned contract**: the variant set, each variant's payload shape, and the `seq`/ordering
semantics are guaranteed surface, not internal detail.

- **Forward-compat valve.** UNSTABLE or unknown ACP session updates surface as the
  `unrecognized-update` variant — never as a new typed variant smuggled in. The union absorbs
  protocol growth through this one variant, so consumers don't break when the agent speaks ahead of
  us. **Integrators MUST tolerate unknown/unrecognized events** (and unknown `extensions`); treat
  the union as open at the `unrecognized-update` seam.
- **`seq` is per-session and per-LOAD-EPOCH.** Within one load it is a dense, monotonic ordering key
  starting at `1`. It **resets** on `session/load` (each load opens a fresh epoch, led by
  `session-reset { reason: 'load' }`). It is **not** a durable cross-load cursor — do not persist it
  as a resume token across loads; pair it with the load boundary if you need stable identity.
- **Non-breaking (minor).** Adding a new variant to the union, or adding a new optional field to an
  existing payload. Consumers already tolerating `unrecognized-update` and unknown fields absorb
  these without change. The new `agent-removed` host event variant (emitted by `disposeAgent`) is
  exactly this kind of addition — a minor, additive change, since consumers already tolerate
  unknown/new variants.
- **Breaking (major).** Renaming/removing a variant, changing or removing a payload field (or
  narrowing its type), or changing ordering / `seq` semantics.
- **UNSTABLE stays unmodeled.** Protocol bits still UNSTABLE in ACP (e.g. incremental `plan_update` /
  `plan_removed`) are not given typed variants until they stabilize; until then they arrive as
  `unrecognized-update`. Consistent with the non-goals above — the toolkit grows only with the
  stable protocol.

### Agent lifecycle: removal vs. tombstone

acpjs distinguishes a **voluntary teardown** from an **involuntary exit**, and expresses the distinction
purely through which host event fires — there is no flag to interpret:

- **Explicit `disposeAgent(agentId)` REMOVES the agent.** It gracefully tears down one agent (the
  per-agent counterpart of `host.dispose()`), then emits `agent-removed` and drops the agent from
  `getAgents()`. It is idempotent: a no-op for an unknown or already-gone id. The agent's sessions
  transition to `disconnected` — their chat history is **preserved, not closed or deleted** — so the
  data survives even though hot recovery is lost; cold-recover by spawning the agent again and calling
  `loadSession`.
- **Involuntary crash / exit keeps the agent as an `exited` tombstone.** The agent stays in
  `getAgents()` carrying its exit reason and may restart under the restart policy; it is not removed and
  no `agent-removed` fires. The tombstone is how callers see why an agent went away and whether it can
  come back.

So `agent-removed` means "the integrator chose to remove this agent"; an `exited` status means "the agent
went away on its own." Surfacing both states is mechanism; deciding when to dispose is the integrator's.

See the [root README](../README.md) for the architecture diagram, packages, and usage.
