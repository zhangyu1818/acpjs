# acpjs Recipes

acpjs packages the ACP protocol as **mechanism**; the **decisions** belong to you (see
[design-philosophy.md](./design-philosophy.md)). The patterns below are the canonical way to fold
the public surface into common product features. They are **documented recipes, not baked-in code** —
every line is integrator-side TypeScript over the shipped API, so you own them, adapt them, and drop
the ones you do not need.

All recipes build on the per-session event stream (`session.onEvent`) and the reducer-derived
`SessionState` (`session.getSnapshot()` / `session.subscribe`). Both are public, versioned contracts.

Two semantics that every recipe depends on:

- **`seq` is per-session and per-LOAD-EPOCH.** It is a dense, monotonic ordering key starting at `1`
  within one load, and it **resets** on `session/load`. Each load opens a fresh epoch led by a
  `session-reset { reason: 'load' }` event. Do not treat `seq` as a durable cross-load cursor, and do
  not key any of your own buckets on raw `seq` — pair it with the load boundary.
- **Tolerate the unknown.** New/UNSTABLE ACP updates arrive as the `unrecognized-update` variant.
  A `switch` over `event.type` should always have a default that ignores what it does not model.

`onEvent` replays then streams. `session.onEvent(listener, { fromSeq: 0 })` first replays the full
current-epoch log in `seq` order, then delivers live events with no gap and no duplicate. Calling
`session.onEvent(listener)` with no options is live-only (events after subscribe). Both return an
unsubscribe function and run independently of `subscribe()` / `getSnapshot()`.

## 1. Plan history

ACP emits the **full plan snapshot** on every plan update (`plan_update` / `plan_removed` are UNSTABLE
and unmodeled), so each `plan` event payload is a complete `Plan` for the current epoch. The reducer
keeps only the latest snapshot in `state.plan`; if you want the running history of snapshots, append
each one yourself. You **must** reset the array on `session-reset`, otherwise a load splices the
pre-load and post-load timelines together and desyncs your history from `reduce()`.

```ts
import type { AcpSession } from '@acpjs/client'
import type { Plan } from '@agentclientprotocol/sdk'

export function trackPlanHistory(session: AcpSession): {
  history: Plan[]
  stop: () => void
} {
  let history: Plan[] = []
  const stop = session.onEvent(
    (event) => {
      if (event.type === 'session-reset') {
        history = []
      } else if (event.type === 'plan') {
        history.push(event.payload)
      }
    },
    { fromSeq: 0 },
  )
  return {
    get history() {
      return history
    },
    stop,
  }
}
```

Per-event append IS the complete history of the current epoch: because every `plan` event is a full
snapshot, the array is the ordered sequence of plan states the agent has published since the last load.

## 2. Per-turn grouping

A turn is the span of events that ends with a `prompt-finished` event; its `payload.stopReason` is the
turn's terminal reason (and `payload.error`, if present, is the agent's structured error — see
recipe 3). Fold the stream into buckets, closing the open bucket on each `prompt-finished`, and
reset/close all buckets on `session-reset` (a load starts a new epoch). Do **not** key buckets on raw
`seq` — it resets on load.

```ts
import type { AcpSession } from '@acpjs/client'
import type { AcpSessionEvent } from '@acpjs/client'
import type { StopReason } from '@agentclientprotocol/sdk'

interface Turn {
  events: AcpSessionEvent[]
  stopReason: StopReason | null
}

export function groupByTurn(session: AcpSession): {
  turns: Turn[]
  stop: () => void
} {
  let turns: Turn[] = []
  let open: Turn = { events: [], stopReason: null }
  const stop = session.onEvent(
    (event) => {
      if (event.type === 'session-reset') {
        turns = []
        open = { events: [], stopReason: null }
        return
      }
      open.events.push(event)
      if (event.type === 'prompt-finished') {
        open.stopReason = event.payload.stopReason
        turns.push(open)
        open = { events: [], stopReason: null }
      }
    },
    { fromSeq: 0 },
  )
  return {
    get turns() {
      return turns
    },
    stop,
  }
}
```

If you want each turn's projection to be **field-for-field consistent** with the built-in session
projection, replay the re-exported `reduce()` over the bucket. `@acpjs/client` re-exports
`reduce`, `createInitialSessionState`, and the `SessionState` type from `@acpjs/protocol`:

```ts
import { createInitialSessionState, reduce } from '@acpjs/client'

function projectTurn(sessionId: string, turn: Turn) {
  return turn.events.reduce(reduce, createInitialSessionState(sessionId))
}
```

This is exactly the function acpjs runs internally, so the per-turn `SessionState` you derive matches
what `session.getSnapshot()` would have produced for that span.

## 3. Discriminate auth (and other agent) errors without regex

acpjs preserves the agent's **structured JSON-RPC error code** — you never have to match on message
text. ACP signals "authentication required" with code `-32000` (`auth_required`). There are two
surfaces, depending on how the error arrived, and they wrap differently:

**Prompt errors land in state, unwrapped.** `session.prompt()` does not throw on an agent protocol
error during the turn; it resolves with the `PromptFinishedPayload`, and the reducer records the raw
agent error info on `state.lastPromptError` (`{ code, message, data? }`). The code is the agent's own
`-32000`, not an acpjs wrapper:

```ts
import type { SessionState } from '@acpjs/client'

const ACP_AUTH_REQUIRED = -32000

export function promptNeedsAuth(state: SessionState): boolean {
  return state.lastPromptError?.code === ACP_AUTH_REQUIRED
}
```

**Imperative calls throw, wrapped.** Errors thrown by `agent.sessions.create` / `load` / `resume`,
`prompt` setup, etc. surface as an `AcpClientError` whose `code` is the acpjs sentinel
`'acpjs/agent-error'`; the **original** agent error is preserved in `error.data` as
`{ code, message, data? }`. So you check the inner code, not the outer one:

```ts
const ACP_AUTH_REQUIRED = -32000

function isAuthRequired(error: unknown): boolean {
  const data = (error as { data?: { code?: number } }).data
  return data?.code === ACP_AUTH_REQUIRED
}

try {
  await agent.sessions.create({
    cwd,
    mcpServers: [],
    additionalDirectories: [],
  })
} catch (error) {
  if (isAuthRequired(error)) {
    presentLogin(agent.getSnapshot().authMethods ?? [])
  } else {
    throw error
  }
}
```

The same `error.data?.code` check generalizes to any structured agent error code, not just auth.

**Rendering the login picker.** acpjs implements no `authenticate` flow by design — auth is handled
out of band. What it surfaces is the agent's advertised `authMethods` on the agent snapshot
(`agent.getSnapshot().authMethods`, also pushed via `agent.subscribe`). Each `AuthMethod` carries an
`id`, a human-readable `name`, and an optional `description`; render those as the choices in your
out-of-band login UI, run the login the agent expects, then retry the call.

## 4. Join a pending permission to its tool call

ACP's `ToolCallStatus` is exactly `pending | in_progress | completed | failed` — there is **no**
`waiting_for_confirmation` status. "This tool call is waiting for the user to confirm" is a UI-layer
derivation you compose from the parts acpjs surfaces: a tool call in `state.toolCalls`, plus a pending
permission request in `state.pendingPermissionRequests`. acpjs floats up the parts; you do the join.

A pending permission request carries the `ToolCallUpdate` it is gating, whose `toolCallId` is the join
key:

```ts
import type { SessionState } from '@acpjs/client'

export function pendingPermissionFor(state: SessionState, toolCallId: string) {
  return state.pendingPermissionRequests.find(
    (request) => request.toolCall.toolCallId === toolCallId,
  )
}

export function awaitingConfirmation(
  state: SessionState,
  toolCallId: string,
): boolean {
  return pendingPermissionFor(state, toolCallId) !== undefined
}
```

From there your renderer composes the merged status however it likes, e.g. show the tool call's raw
`status` until `awaitingConfirmation` is true, then render a "waiting for confirmation" affordance with
the request's `options` as the buttons. The decision — what to show, and whether/how to auto-answer —
stays yours; respond through the pending request as in the
[auto-approving permissions recipe](../README.md#auto-approving-permissions-in-your-app).
