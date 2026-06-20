---
'@acpjs/protocol': minor
'@acpjs/core': patch
---

Surface the full reduced-state type vocabulary and enforce terminal↔session ownership at the host boundary.

- **protocol** — re-export the remaining SDK protocol types that `SessionState` / `ToolCallState` already expose: `AvailableCommand`, `Cost`, `PermissionOption`, `Plan`, `SessionModeState`, `StopReason`, `ToolCallContent`, `ToolCallLocation`, `ToolCallStatus`, `ToolKind`, `Usage` (joining the existing `ContentBlock` / `SessionConfigOption` / `AuthMethod` / `McpServer` / etc.). Integrators can now type a reduced session entirely from `@acpjs/protocol` instead of reaching into `@agentclientprotocol/sdk` or maintaining parallel enum copies that drift from the protocol. Additive, non-breaking.
- **core** — the host now records which `sessionId` created each `terminalId` and rejects `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal` calls that reference a terminal owned by a different session (`acpjs/invalid-params`, "terminal belongs to another session"). The check runs before the injected `TerminalHandler`, so a custom handler can no longer accidentally drop this isolation — the same trust-boundary guarantee already applied to session↔agent ownership. Cross-session terminal access was never valid, so this is a hardening fix.
- **core** — `disposeAgent` is now idempotent under concurrent calls, not just sequential ones. The agent is removed from the runtime registry synchronously before awaiting the process teardown, so two overlapping `disposeAgent(sameId)` calls no longer both pass the existence guard — `dispose` runs once and `agent-removed` is emitted at most once. No public API or type change.
