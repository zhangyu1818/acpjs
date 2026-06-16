# acpjs

Headless, layered TypeScript toolkit for the **Client role** of the Agent Client Protocol (ACP).
It packages the protocol; it contains no product or business logic.

## The one rule

**Mechanism, not decision.** acpjs owns the plumbing — spawn, JSON-RPC wire, event normalization,
one pure reducer, surfacing reverse requests, persist/replay, the serializable Transport boundary.
Every decision ACP leaves to the client — permission approval, project grouping, automation, auth,
retries — is **surfaced, not decided**, and belongs to the integrator. Convenience patterns are
documented recipes, not baked-in code.

Before adding any capability, ask: mechanism or decision? If it's a decision, surface it and stop.

- Full philosophy, boundaries, and intentional non-goals → [docs/design-philosophy.md](./docs/design-philosophy.md)
- Architecture, packages, usage → [README.md](./README.md)
