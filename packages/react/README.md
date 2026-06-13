# @acpjs/react

React hooks and Provider for acpjs, built on `@acpjs/client` (headless, environment-neutral, no state-library dependency, ships no UI components).

## Installation

```sh
pnpm add @acpjs/react @acpjs/client
```

ESM-only, requires `node >= 24`. React is a peer dependency (`react >= 19`). `@acpjs/client` is the runtime you wire into the Provider.

## Minimal usage

A `sessionId` comes from a session-creation flow (see [Creating a session](#creating-a-session)). Once `AcpProvider` injects the client, any component in the subtree can subscribe to that session with `useSession(sessionId)`.

```tsx
import { AcpClientError } from '@acpjs/client'
import { AcpProvider, usePermissionRequests, useSession } from '@acpjs/react'

import { client } from './acp-client.ts'

function App({ sessionId }: { sessionId: string }) {
  return (
    <AcpProvider client={client}>
      <Chat sessionId={sessionId} />
    </AcpProvider>
  )
}

function Chat({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId)
  const permissions = usePermissionRequests()
  if (!session) return null
  return (
    <div>
      {session.state.messages.map((message, index) => (
        <p key={index}>{JSON.stringify(message.content)}</p>
      ))}
      {permissions.map((request) => (
        <button
          key={request.requestId}
          onClick={() =>
            void request
              .respond({
                outcome: 'selected',
                optionId: request.options[0]?.optionId ?? '',
              })
              .catch((error) => {
                if (
                  error instanceof AcpClientError &&
                  error.code === 'acpjs/already-answered'
                )
                  return
                throw error
              })
          }
        >
          Allow
        </button>
      ))}
      <button
        onClick={() => void session.prompt([{ type: 'text', text: 'hi' }])}
      >
        Send
      </button>
    </div>
  )
}
```

Under multi-endpoint concurrency a permission request may be answered by another endpoint before your local `respond` lands. In that case `respond` rejects with `acpjs/already-answered`, which is a normal path (the list has already converged). Consumers should ignore that code and rethrow everything else.

## Where the client comes from

The client injected into `AcpProvider` is created by `createAcpClient` from `@acpjs/client`. The transport depends on the runtime environment:

- **Browser / Electron renderer**: use `electronTransport()` from `@acpjs/electron/renderer` (pure `MessagePort`, environment-neutral; handshake details in the `@acpjs/electron` README).
- **Node, same process**: use `createInProcessTransport(createHostEndpoint(host))` to connect directly to an in-process `AcpHost` (see the `@acpjs/client` / `@acpjs/core` READMEs).

Create the client **once at module scope**, not inside a component. React StrictMode double-invokes component bodies, so creating the client inside a component would open duplicate connections. Put the client in its own module and export it:

```ts
// acp-client.ts (renderer / browser)
import { createAcpClient } from '@acpjs/client'
import { electronTransport } from '@acpjs/electron/renderer'

export const client = createAcpClient({ transport: electronTransport() })
```

```ts
// acp-client.ts (Node, same process)
import { createAcpClient, createInProcessTransport } from '@acpjs/client'
import { createAcpHost, createHostEndpoint } from '@acpjs/core'

export const host = createAcpHost()
export const client = createAcpClient({
  transport: createInProcessTransport(createHostEndpoint(host)),
})
```

Call `await client.dispose()` on application exit to close the transport. **The in-process case additionally needs `await host.dispose()`**: the host lifecycle is independent of the client, and `client.dispose()` only closes the transport — it does not dispose the host. Skipping `host.dispose()` leaks agent child processes (see the dispose chain in the `@acpjs/client` / `@acpjs/core` READMEs).

## Creating a session

Sessions are created from an agent handle. Take the `sessionId` from the returned `AcpSession` and feed it to `useSession`. `agent.sessions.create({ cwd })` resolves to an `AcpSession`; store `created.sessionId` in state. `useSession` subscribes through the session registry and converges from `undefined` to the live result once the handle appears.

**Signature note**: `useSession(sessionId: string)` does not accept `undefined`. While no session exists yet, pass an empty string as a placeholder (`client.sessions.get('')` safely returns `undefined`), or conditionally render in the parent component.

```tsx
import { useState } from 'react'

import { useSession } from '@acpjs/react'

import type { AcpAgent } from '@acpjs/client'

function NewSession({ agent }: { agent: AcpAgent }) {
  const [sessionId, setSessionId] = useState('')
  const session = useSession(sessionId)
  return (
    <div>
      <button
        onClick={async () => {
          const created = await agent.sessions.create({
            cwd: '/path/to/project',
          })
          setSessionId(created.sessionId)
        }}
      >
        New session
      </button>
      {session ? <Chat sessionId={sessionId} /> : null}
    </div>
  )
}
```

`cwd` is the session's working directory and should come from a project directory the user selects — a renderer has no `process.cwd()`, so it must be passed explicitly. If your `sessionId` is a nullable type, call `useSession(sessionId ?? '')` at the call site.

## Handling auth-required

An agent that requires login does not return a union type from `agent.sessions.create`. Instead it rejects with an `AcpClientError` (`code: 'acpjs/auth-required'`, `retryable: true`). After catching it, read the available auth methods either from `error.data` (typed `unknown`; assert `{ authMethods: AuthMethod[] }` manually) or from `agent.authMethods`, render them for the user to choose, then call `await agent.authenticate(methodId)` and retry the create:

```tsx
import { AcpClientError } from '@acpjs/client'

import type { AuthMethod } from '@acpjs/protocol'

try {
  const session = await agent.sessions.create({ cwd })
} catch (error) {
  if (error instanceof AcpClientError && error.code === 'acpjs/auth-required') {
    const methods = (error.data as { authMethods: AuthMethod[] }).authMethods
    // Render methods for the user to choose -> await agent.authenticate(methodId) -> retry create
  } else {
    throw error
  }
}
```

A missing-auth condition on the `load` / `resume` paths is observed reactively through `useSession`: when `session.state.connection.status === 'auth-required'`, read the methods from `session.state.connection.authMethods` and render the same selection UI.

The agent handle also exposes the pending-auth state directly. `agent.getSnapshot()` carries `authRequired?: boolean` and `authMethods?: AuthMethod[]`, and both update live as host events arrive — `useAgent` / `useAgents` re-render when they change. Use these to gate the agent's UI before any session create is attempted.

## Public API (sealed surface)

The export surface is exactly nine values (pinned by an API snapshot test): `AcpProvider`, `useAcpClient`, `useAgent`, `useAgents`, `useConnectionStatus`, `usePermissionRequests`, `useSession`, `useSessions`, and the `shallowEqual` helper. Every read hook accepts an optional pure-projection `(selector, isEqual?)` (see [Selecting a slice](#selecting-a-slice)), but there is still no raw subscription, no raw protocol-notification subscribe, no raw event/event-log handle, and no raw RPC. A selector is a pure projection of already-public snapshot data — it is not an escape hatch.

- `<AcpProvider client={client}>`: injects the `AcpClient` into the subtree. Using any hook outside the Provider throws a clear error pointing back to `AcpProvider`.
- `useAcpClient(): AcpClient`: returns the client injected by the Provider.
- `useAgent(agentId: string): AcpAgent | undefined`: `undefined` until spawn completes, then the same handle reference as the `client.agents.spawn` result (carrying `capabilities?` / `authMethods?` / `sessions`). Changes in agent runtime state (host-ordered agent status events) trigger a re-render; read `status` / `reason?` / `exit?` / `restartCount` / `authRequired?` / `authMethods?` via `agent.getSnapshot()`.
- `useAgents(): readonly AcpAgent[]`: enumerates the agent handles held by this client, updating reactively on spawn / attach and on agent status changes. Good for rendering an agent picker or sidebar.
- `useSessions(): readonly AcpSession[]`: enumerates the session handles held by this client, updating reactively on create / load / resume / attach and on host session announcements. Good for rendering a session-list sidebar.
- `useConnectionStatus(): ConnectionStatusSnapshot`: the transport connection status (`connecting` / `connected` / `closed`, with an optional `error`). Good for rendering a connection banner or offline notice.
- `useSession(sessionId: string): UseSessionResult | undefined`: `undefined` while the client does not yet know the session; once known, returns `{ sessionId, state, prompt, cancel, close, setMode, setConfigOption }`, where `state` is the `SessionState` from `@acpjs/protocol`.
- `usePermissionRequests(): readonly PermissionRequest[]`: the list of pending permission requests across all sessions. Each element carries `respond(outcome)`; the list converges after a `respond` (local or from another endpoint).
- `shallowEqual(a, b): boolean`: a one-level structural comparison (objects compared by own-key set + `Object.is` per value; arrays by index + length). Pair it with a derived/composite selector so a fresh-but-shallow-equal projection does not re-render (see below).

## Selecting a slice

Every read hook — `useAgents`, `useSessions`, `useConnectionStatus`, `usePermissionRequests`, `useAgent`, `useSession` — accepts an optional `(selector, isEqual?)`. With no selector the hook returns the full snapshot exactly as before, so this is fully backward compatible. With a selector the hook returns the projection and re-renders only when the projected value changes by the equality function.

- `useAgents`, `useSessions`, `useConnectionStatus`, `usePermissionRequests` project their snapshot directly into the hook's return value.
- `useAgent(agentId, selector?)`'s selector projects the agent **snapshot** (`AgentSnapshot | undefined`). With no selector the hook still returns the `AcpAgent` handle (the unchanged contract).
- `useSession(sessionId, selector?)`'s selector projects the `SessionState`; the projection becomes the `.state` field of the returned `UseSessionResult` (the action methods are unchanged). The hook is still `undefined` until the session is known, and the selector never runs over a missing state.

Default equality is `Object.is`. Selecting a whole top-level slice or a bare primitive needs no `isEqual`. Selector identity does not need to be stable — an inline arrow is safe; the underlying React shim (`useSyncExternalStoreWithSelector`) re-derives on selector-identity change but returns the previous reference when the equality function holds, so there is no infinite render loop and no need to `useMemo` the selector.

**Structural sharing means whole-slice selection is free.** The session reducer rebuilds only the slice an event touches and carries every sibling slice by reference via `...state`, so top-level `SessionState` slices (`messages`, `toolCalls`, `plan`, `connection`, `terminals`, …) are reference-stable across unrelated updates. `useSession('s', s => s.toolCalls)` therefore re-renders only when tool calls change — no `isEqual` required.

**Pass `shallowEqual` the moment a selector composes or derives.** A selector that builds a fresh object (`s => ({ status: s.connection.status, plan: s.plan })`) or derives via `filter` / `map` / `Object.values` / `Object.entries` / `Object.keys` / `slice` returns a brand-new reference every call, so the default `Object.is` treats every render as a change. Pass `shallowEqual` (exported from `@acpjs/react`) as the second argument to suppress re-renders when the projection is shallow-equal.

```ts
// primitive / whole-slice — Object.is is enough
const status = useConnectionStatus((s) => s.status)
const toolCalls = useSession('s', (s) => s.toolCalls)?.state

// derived array — needs shallowEqual
import { shallowEqual } from '@acpjs/react'

const agentMsgs = useSession(
  's',
  (s) => s.messages.filter((m) => m.kind === 'agent'),
  shallowEqual,
)?.state
```

## Behavioral guarantees

- Every subscription goes through `useSyncExternalStore` onto a client store. Under StrictMode double-invocation and concurrent features (`startTransition`) there is no tearing and no duplicate subscription (pinned by tests).
- Reference stability: with no new event, a re-render returns the same object reference. Snapshots reuse the client store's cached immutable references directly, so multiple hooks observing the same session get a reference-equal `state`.
- Unmount unsubscribes from all store subscriptions.
- A `usePermissionRequests` element's `respond` may reject with `acpjs/already-answered` under a multi-endpoint race (another endpoint already answered and the list has converged). Consumers must catch and ignore that code.

## Implementation-defined decisions

- **`useSession` result shape**: a single `useMemo`-cached result object. `SessionState` (or, with a selector, the projected value) is nested under `.state`, and the methods reuse the stable function references from the session handle.
- **Unknown ids**: `useSession` / `useAgent` return `undefined` for an id the client does not yet hold. The value appears automatically through a registry subscription once the handle exists (create / load / resume / spawn completes).
- **Missing Provider**: throws a plain `Error` (message contains `AcpProvider`), not an `AcpClientError` — this is a usage error, not a protocol failure.
- **No SSR support**: no `getServerSnapshot` is provided; the hooks target client rendering only. The dist entry already carries a `'use client'` directive (see the build config). Under the Next.js App Router you still must place components that use the hooks (including `AcpProvider`) in a `'use client'` module, otherwise you hit an RSC error or `useSyncExternalStore`'s `Missing getServerSnapshot`.
