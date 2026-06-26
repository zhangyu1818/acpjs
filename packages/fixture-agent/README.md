# @acpjs/fixture-agent

> **Private, never published.** `private: true` workspace package consumed via `workspace:*`. A scripted protocol-replay ACP agent used only to drive E2E tests of the other acpjs packages.

`src/cli.ts` is the executable entry: speaks the agent side of ACP over stdio (NDJSON out to stdout, NDJSON in from stdin; debug must go to stderr). The scenario is a JSON file via `--scenario <path>` or the `ACP_FIXTURE_SCENARIO` env var (argv wins); neither set → empty `{}`. `exports` points at `src/index.ts` (Node ≥ 24 strips types at runtime — no build step).

## Exports

```ts
import {
  fixtureAgentCliPath, // absolute path to cli.ts — pass to spawn()
  writeScenarioFile, // (scenario, dir?) => Promise<scenarioPath>; dir defaults to a fresh os-tmpdir
  type FixtureScenario,
  type FixtureTurn,
  type FixtureStep,
  type FixturePermissionStep,
} from '@acpjs/fixture-agent'
```

## Usage

```ts
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import {
  fixtureAgentCliPath,
  writeScenarioFile,
  type FixtureScenario,
} from '@acpjs/fixture-agent'

const scenario: FixtureScenario = {
  turns: [
    {
      steps: [
        {
          kind: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hi' },
          },
        },
      ],
      stopReason: 'end_turn',
    },
  ],
}

const scenarioPath = await writeScenarioFile(scenario)
const child = spawn(
  process.execPath,
  [fixtureAgentCliPath, '--scenario', scenarioPath],
  { stdio: ['pipe', 'pipe', 'pipe'] },
)

const updates: SessionNotification[] = []
const app = client({ name: 'fixture-example' })
  .onNotification(methods.client.session.update, ({ params }) =>
    updates.push(params),
  )
  .onRequest(methods.client.session.requestPermission, () => ({
    outcome: { outcome: 'cancelled' },
  }))
const conn = app.connect(
  ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ),
)

await conn.agent.request(methods.agent.initialize, {
  protocolVersion: PROTOCOL_VERSION,
})
const { sessionId } = await conn.agent.request(methods.agent.session.new, {
  cwd: '/tmp',
  mcpServers: [],
})
await conn.agent.request(methods.agent.session.prompt, {
  sessionId,
  prompt: [{ type: 'text', text: 'hello' }],
})
// updates contains the 'hi' chunk
conn.close()
child.kill()
```

## Scenario DSL

Every field is optional; `{}` yields a minimal agent that replies to `prompt` with an empty `end_turn`.

```ts
interface FixtureScenario {
  initialize?: {
    protocolVersion?: number
    agentCapabilities?: AgentCapabilities
    authMethods?: AuthMethod[]
  }
  session?: {
    sessionId?: string
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    authRequired?: boolean
    error?: { code: number; message: string; data?: unknown }
  }
  turns?: FixtureTurn[]
  loadSession?: {
    replay?: SessionUpdate[]
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    error?: { code: number; message: string; data?: unknown }
    failures?: number
  }
  listSessions?: { sessions: SessionInfo[]; nextCursor?: string }
  resumeSession?: {
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    expectMcpServers?: McpServer[]
  }
  setConfigOption?: { configOptions: SessionConfigOption[] }
}

interface FixtureTurn {
  steps?: FixtureStep[]
  stopReason?: StopReason
  usage?: Usage
}
```

### Steps (`FixtureStep`, discriminated by `kind`)

| `kind`          | Fields                                                             | Effect                                                                                                        |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `update`        | `update: SessionUpdate`                                            | Send a `session/update` (type-checked).                                                                       |
| `permission`    | `toolCall`, `options`, `onSelected?`, `onCancelled?`               | Send `session/request_permission`, then run the matching branch.                                              |
| `readTextFile`  | `path`, `line?`, `limit?`                                          | Issue an `fs/read_text_file` reverse request.                                                                 |
| `writeTextFile` | `path`, `content`                                                  | Issue an `fs/write_text_file` reverse request.                                                                |
| `terminal`      | `command`, `args?`, `env?`, `cwd?`, `outputByteLimit?`, `actions?` | Create a terminal; run each action in `actions` in order: `'output' \| 'waitForExit' \| 'kill' \| 'release'`. |
| `sleep`         | `ms`                                                               | Wait `ms`; interrupted immediately by `session/cancel`.                                                       |
| `disconnect`    | none                                                               | Close the transport stream while leaving the process alive.                                                   |
| `error`         | `code`, `message`, `data?`                                         | Throw a `RequestError`, ending the turn with a protocol error.                                                |
| `exit`          | `code`                                                             | `process.exit(code)` to simulate a crash.                                                                     |

### Permission branching (`FixturePermissionStep`)

```ts
interface FixturePermissionStep {
  kind: 'permission'
  toolCall: ToolCallUpdate
  options: PermissionOption[]
  onSelected?: Record<string, FixtureStep[]> // keyed by selected optionId
  onCancelled?: FixtureStep[]
}
```

After the client responds: `outcome === 'selected'` → `onSelected[optionId]`; `outcome === 'cancelled'` → `onCancelled`. A cancelled permission does **not** by itself set `stopReason: 'cancelled'`.

## Behavior

- Each `session/prompt` consumes `turns[i]` in order (single agent-global counter); past the end it falls back to an empty `end_turn` turn.
- `session/cancel`: finishes the current step (a `sleep` is interrupted immediately), discards remaining steps, resolves `{ stopReason: 'cancelled' }`.
- `session.authRequired: true` makes `session/new` throw `auth_required` until any `authenticate` call succeeds.
- `session.error` / `loadSession.error` throw the given `RequestError` from `newSession` / `loadSession`. `loadSession.failures: N` throws for the first N calls, then succeeds.
- Optional methods are wired **iff** the matching capability is declared (undeclared → SDK `-32601`):
  - `loadSession` ← `agentCapabilities.loadSession`
  - `listSessions`/`resumeSession`/`closeSession`/`deleteSession` ← `agentCapabilities.sessionCapabilities.{list,resume,close,delete}`
  - `logout` ← `agentCapabilities.auth.logout`
  - `setSessionMode` ← any of `session.modes` / `loadSession.modes` / `resumeSession.modes` present
  - `setSessionConfigOption` ← any of `setConfigOption.configOptions` / `session.configOptions` / `loadSession.configOptions` / `resumeSession.configOptions` present
- `setSessionConfigOption` answers with the full `configOptions` list from the first present source (in the order above); it does not apply the request value.
- `loadSession` replays every entry in `loadSession.replay` before its response.
- `resumeSession.expectMcpServers` asserts the request's `mcpServers` (by name, in order); mismatch → `invalidParams`.
- `newSession` generates a `crypto.randomUUID()` when `session.sessionId` is absent.
