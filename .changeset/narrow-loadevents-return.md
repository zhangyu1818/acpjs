---
'@acpjs/core': minor
---

Narrow `StorageAdapter.loadEvents` return type from `AcpjsEvent[]` to `AcpjsSessionEvent[]`.

`loadEvents` is always called with a `sessionId` and every storage implementation only persists/returns session-scoped events, so the signature now reflects that. Callers no longer need to downcast the result, and the internal `session-recovery` cast is removed. Custom `StorageAdapter` implementations must return `AcpjsSessionEvent[]` (the bundled memory/jsonl adapters already do).
