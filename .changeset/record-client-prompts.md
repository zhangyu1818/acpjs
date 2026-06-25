---
'@acpjs/core': minor
---

Record client-originated prompts in the session history.

When the host calls `prompt()`, each prompt content block is now emitted to the session bus as a `user-message-chunk` update (tagged `meta.acpjs.source: 'client-prompt'`) before the agent's prompt turn starts, so the client's own prompt appears in the session projection and replay alongside agent-direction updates. The matching `user-message-chunk` echoes that some agents send back are de-duplicated against the recorded prompt so the message is not stored twice.

This is mechanism only — acpjs records what the client sent; it does not decide how integrators render or group those entries.
