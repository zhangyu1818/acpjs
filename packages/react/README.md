# @acpjs/react

React Provider + hooks for acpjs, built on `@acpjs/client`. Headless — no UI components, no state-library dependency. All reads go through `useSyncExternalStore`.

## Install

```sh
pnpm add @acpjs/react @acpjs/client
```

ESM-only, `node >= 24`. Peer: `react >= 19`.

## Usage

```tsx
import { AcpProvider, usePermissionRequests, useSession } from '@acpjs/react'
import { AcpClientError } from '@acpjs/client'
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
    <>
      {session.state.messages.map((m, i) => (
        <p key={i}>{JSON.stringify(m.content)}</p>
      ))}
      <button
        onClick={() => void session.prompt([{ type: 'text', text: 'hi' }])}
      >
        Send
      </button>
      {permissions.map((r) => (
        <button
          key={r.requestId}
          onClick={() =>
            void r
              .respond({
                outcome: 'selected',
                optionId: r.options[0]?.optionId ?? '',
              })
              .catch((e) => {
                if (
                  e instanceof AcpClientError &&
                  e.code === 'acpjs/already-answered'
                )
                  return
                throw e
              })
          }
        >
          Allow
        </button>
      ))}
    </>
  )
}
```

Create the client **once at module scope** (not in a component — StrictMode double-invokes component bodies). In renderer use `electronTransport()`; in-process use `createInProcessTransport(createHostEndpoint(host))`.

## Exports

Sealed surface (10 values, pinned by an API snapshot test):

- `<AcpProvider client={client}>` — injects the client. Using any hook outside throws.
- `useAcpClient(): AcpClient`
- `useAgent(agentId): AcpAgent | undefined`
- `useAgents(): readonly AcpAgent[]`
- `useSessions(): readonly AcpSession[]`
- `useSession(sessionId): UseSessionResult | undefined` — returns `{ sessionId, state, prompt, cancel, close, setMode, setConfigOption }`; `undefined` until the client knows the session.
- `useConnectionStatus(): ConnectionStatusSnapshot`
- `usePermissionRequests(): readonly PermissionRequest[]`
- `useDiagnostics(): readonly DiagnosticEvent[]`
- `shallowEqual(a, b): boolean` — one-level structural compare for derived selectors.
- Types: `AcpProviderProps`, `UseSessionResult`. Re-exported: `SessionState`, `AgentSnapshot`, `SessionSnapshot`, `ConnectionStatusSnapshot`, `PermissionRequest`, `DiagnosticEvent`.

## Selecting a slice

Every read hook accepts an optional `(selector, isEqual?)`. No selector → full snapshot. Default equality is `Object.is`; selector identity need not be stable (inline arrow is safe).

- Whole top-level `SessionState` slices (`messages`, `toolCalls`, `plan`, `connection`, …) are reference-stable across unrelated updates (structural sharing) — selecting one needs no `isEqual`.
- Pass `shallowEqual` the moment a selector derives/composes (`s => ({ … })`, `filter`/`map`/`Object.values`/`slice`):

```ts
const toolCalls = useSession('s', (s) => s.toolCalls)?.state // whole slice — Object.is is enough
const agentMsgs = useSession(
  's',
  (s) => s.messages.filter((m) => m.kind === 'agent'),
  shallowEqual,
)?.state // derived — needs shallowEqual
```

## Key semantics

- No tearing, no duplicate subscription under StrictMode/`startTransition`; unmount unsubscribes; references stable when nothing changes.
- `useSession(sessionId)` does not accept `undefined` — pass `''` as a placeholder while no session exists (`client.sessions.get('')` returns `undefined`), or conditionally render.
- `useAgent`/`useSession` return `undefined` for unknown ids, then converge automatically via host projections.
- Missing Provider throws a plain `Error` (not `AcpClientError`) — a usage error.
- No SSR: no `getServerSnapshot`. Under Next.js App Router, components using hooks (including `AcpProvider`) must be in a `'use client'` module.
- Auth is not modeled; agent-side auth failures surface as agent errors.
