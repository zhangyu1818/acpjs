---
'@acpjs/protocol': minor
'@acpjs/core': minor
'@acpjs/client': patch
---

Reopen a `closed` session via `session/load`, coalesce streamed text, and drop the client handle on close so a reopen yields a fresh handle.

- **protocol** — `reduce` now coalesces consecutive **plain text** blocks within a message into one (`text` concatenated, no separator), so a streamed reply is a single text block instead of one block per delta. "Plain" means the block carries no `annotations` and no `_meta`; if either side carries those fields the blocks are kept separate (and a non-text block always breaks the run) to preserve per-block metadata.
- **core** — `loadSession` can now **reopen** a `closed` session: it clears the closed tombstone, re-loads the session from the agent, and rebuilds state via replay. A `deleted` session stays permanently rejected (`acpjs/session-closed`).
- **client** — `applySessionProjection` now drops the session handle for `closed` (previously only `deleted`), so `client.sessions.get(sessionId)` returns `undefined` once a session is closed and a later reopen (load / attach) builds a **new** handle rather than reviving the old one.
