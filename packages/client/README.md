# @acpjs/client

Typed facade + reducer-driven snapshot/subscribe store for acpjs. Environment-neutral; talks to any host purely through the acpjs HostClientTransport contract. Replays the normalized event stream with the pure reducer into `SessionState`.

## Install

```sh
pnpm add @acpjs/client
```

ESM-only, `node >= 24` (also browser/renderer-safe).

## Usage (in-process)

```ts
import { createAcpClient, createInProcessTransport, AcpClientError } from '@acpjs/client'
import { createAcpHost, createHostEndpoint } from '@acpjs/core'

const host = createAcpHost()
const client = createAcpClient({ transport: createInProcessTransport(createHostEndpoint(host)) })

const agent = await client.agents.spawn({ id: 'my-agent', command: 'npx', args: ['some-acp-agent'] })
const session = await agent.sessions.create({ cwd: process.cwd(), mcpServers: [], additionalDirectories: [] })
session.subscribe(() => render(session.getSnapshot()))

client.permissions.subscribe((requests) => {
  for (const r of requests) {
    r.respond({ outcome: 'selected', optionId: r.options[0]?.optionId ?? '' }).catch((e) => {
      if (e instanceof AcpClientError && e.code === 'acpjs/already-answered') return
      throw e
    })
  }
})

await session.prompt([{ type: 'text', text: 'hello' }])
await client.dispose()
await host.dispose() // in-process: host lifetime is independent of the client
```

## Exports

Closed surface (pinned by an API snapshot test): `createAcpClient`, `createInProcessTransport`, `AcpClientError`. Re-exports from `@acpjs/protocol`: `reduce`, `createInitialSessionState`, and types `AcpjsSessionEvent`, `SessionState`, `SessionEventOptions`.

- Types: `AcpClient`, `AcpAgent`, `AcpSession`, `AcpAgentSessions`, `AgentDefinition`, `ConnectionStatusSnapshot`, `CreateAcpClientOptions`, `CreateOrLoadSessionParams`, `ResumeSessionParams`, `PermissionRequest`, `PermissionListener`, `ChangeListener`, `SessionConfigValue`, `SessionEventOptions`, `SessionListParams`. Plus re-exported `AgentSnapshot`, `SessionSnapshot`, `DiagnosticEvent`, `PromptFinishedPayload`, `RequestPermissionOutcome`, `SessionConfigOption`, `ContentBlock`, `ListSessionsResponse`.

### `createAcpClient({ transport }): AcpClient`

- `client.agents` — `spawn(definition): Promise<AcpAgent>`, `get(agentId)`, `getSnapshot(): readonly AcpAgent[]`, `subscribe(cb)`, `list(): Promise<readonly AgentSnapshot[]>`, `attach(agentId): Promise<AcpAgent>` (unknown → `acpjs/agent-exited`), `dispose(agentId): Promise<void>` (idempotent).
- `client.sessions` — `get(sessionId)`, `getSnapshot(): readonly AcpSession[]`, `subscribe(cb)`, `list(): Promise<readonly SessionSnapshot[]>`, `attach(sessionId): Promise<AcpSession>` (unknown → `acpjs/session-closed`), `restore(): Promise<readonly SessionSnapshot[]>`.
- `client.permissions` — `getSnapshot(): readonly PermissionRequest[]`, `subscribe((requests) => …)`. Each `request` carries `requestId`/`sessionId`/`toolCall`/`options` and `respond(outcome)`.
- `client.diagnostics` — `getSnapshot(): readonly DiagnosticEvent[]` (bounded 200, oldest evicted), `subscribe(cb)`.
- `client.status` — `getSnapshot(): ConnectionStatusSnapshot` (`connecting`/`connected`/`closed`, optional `error`), `subscribe(cb)`.
- `client.dispose()` — closes the transport; afterwards every call rejects with `acpjs/transport-closed`.

### `AcpAgent`

- `agentId` (readonly), `getSnapshot(): AgentSnapshot`, `subscribe(cb)`.
- `authenticate(methodId): Promise<void>`, `logout(): Promise<void>` (gated on `auth.logout`).
- `sessions.create({ cwd, mcpServers, additionalDirectories })` / `load(id, …)` / `list({ cursor?, cwd? })` / `resume(id, …)` / `delete(id)`.

### `AcpSession`

- `sessionId` (readonly), `getSnapshot(): SessionState`, `subscribe((state) => …)`.
- `onEvent((event) => …, options?): () => void` — independent read-only tap on the normalized stream; `{ fromSeq: 0 }` replays the full log then streams live; omit for live-only.
- `prompt(ContentBlock[]): Promise<PromptFinishedPayload>`, `cancel()`, `close()`, `setMode(modeId)`, `setConfigOption(configId, value)`.

## Key semantics

- **No raw send.** No raw host-envelope send, no raw notification subscription, no store selector. For projections the single `SessionState` can't express, use `session.onEvent` (with `reduce`/`createInitialSessionState` re-exported for one-import projections).
- **State construction**: transport delivers `AcpjsEvent` → `reduce` replays in `seq` order; duplicate `seq` ignored; late subscribers backfill via `fromSeq` to deeply equal state.
- **`subscribe` never calls back immediately** — read the initial value via `getSnapshot`/`get`. Same for agents/sessions/status/permissions/diagnostics.
- **Reactive mirror**: agent/session registries mirror the host stream — a session created by another endpoint appears via `session-updated`; a disposed agent leaves via `agent-removed`.
- **Handle lifecycle**: a live session reuses one frozen handle across create/load/resume/attach; a `closed`/`deleted` handle is dropped, and a later reopen builds a new handle.
- **Permissions**: sourced from host `permission-updated` projections; leaves the pending set on respond, `acpjs/already-answered`, or answered/superseded projection. Under multi-client race, `acpjs/already-answered` is the normal path — ignore it.
- **Errors**: every error is `AcpClientError` (`ErrorObject` shape: `code` (`acpjs/*`), `message`, `data?`, `retryable`). Auth failures during create/load/resume/prompt reject with `acpjs/agent-error` and the original error in `data`.
- **Slash commands**: no `invokeCommand` — invoke by writing a `/`-prefixed text block in the prompt: `session.prompt([{ type: 'text', text: '/web query' }])`.
