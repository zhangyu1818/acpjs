# @acpjs/fixture-agent

> **Private, not published, test fixture only.** This package is `private: true`
> and is never published to npm. It exists solely to drive
> end-to-end tests of the other acpjs packages (`core`, `client`, `electron`, …).

A scripted protocol-replay ACP agent. Its single job: translate one JSON
scenario into the behavior of a real ACP agent subprocess, so client-side code
can be exercised against a deterministic, fully-scriptable peer.

## Installation

The package is private and consumed only inside this workspace via
`workspace:*`:

```jsonc
// package.json of the consuming package
{
  "devDependencies": {
    "@acpjs/fixture-agent": "workspace:*",
  },
}
```

The `exports` entry points directly at `src/index.ts` (Node >= 24 strips types
at runtime — there is no build step and no `build` script).

## Shape

- `src/cli.ts` is the executable entry. It speaks the agent side of ACP over
  stdio: writes NDJSON to stdout, reads NDJSON from stdin. Any debug output must
  go to stderr.
- The scenario is supplied as a JSON file, either via `--scenario <path>` or via
  the `ACP_FIXTURE_SCENARIO` environment variable (argv wins). When neither is
  set, an empty scenario `{}` is used.

## Exports

```ts
import {
  fixtureAgentCliPath, // absolute path to cli.ts, for spawn()
  writeScenarioFile, // (scenario, dir?) => Promise<scenarioPath>; dir defaults to a fresh os-tmpdir directory
  type FixtureScenario,
  type FixtureTurn,
  type FixtureStep,
  type FixturePermissionStep,
} from '@acpjs/fixture-agent'
```

## Minimal usage

Write the scenario to disk, `spawn` the CLI, and connect the SDK client builder
to its stdio. The scenario below runs a single turn that emits one agent message
chunk and ends the turn:

```ts
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import {
  client as createClientApp,
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
const clientApp = createClientApp({ name: 'fixture-example' })
  .onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params)
  })
  .onRequest(methods.client.session.requestPermission, () => {
    return { outcome: { outcome: 'cancelled' } }
  })
const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
)
const conn = clientApp.connect(stream)

await conn.agent.request(methods.agent.initialize, {
  protocolVersion: PROTOCOL_VERSION,
})
const { sessionId } = await conn.agent.request(methods.agent.session.new, {
  cwd: '/tmp',
  mcpServers: [],
})
const result = await conn.agent.request(methods.agent.session.prompt, {
  sessionId,
  prompt: [{ type: 'text', text: 'hello' }],
})
// result.stopReason === 'end_turn'; updates contains the 'hi' chunk.
conn.close()
child.kill()
```

## Scenario DSL

The scenario is a single `FixtureScenario` object. Every field is optional; an
empty `{}` yields a minimal agent that replies to `prompt` with an empty
`end_turn` turn.

```ts
interface FixtureScenario {
  // initialize() response. Defaults: protocolVersion = PROTOCOL_VERSION.
  initialize?: {
    protocolVersion?: number
    agentCapabilities?: AgentCapabilities
    authMethods?: AuthMethod[]
  }
  // newSession() response and gating.
  session?: {
    sessionId?: string // default: crypto.randomUUID()
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    authRequired?: boolean // true => newSession throws auth_required until authenticate() succeeds
    error?: { code: number; message: string; data?: unknown } // newSession throws this RequestError
  }
  // One entry per prompt(), consumed in order (see Behavior).
  turns?: FixtureTurn[]
  // loadSession() — only active when agentCapabilities.loadSession === true.
  loadSession?: {
    replay?: SessionUpdate[] // history updates replayed before the response
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    error?: { code: number; message: string; data?: unknown } // loadSession throws this RequestError
    failures?: number // throw `error` for the first N calls, then succeed (undefined => fail every call)
  }
  // listSessions() — only active when agentCapabilities.sessionCapabilities.list.
  listSessions?: {
    sessions: SessionInfo[]
    nextCursor?: string
  }
  // resumeSession() — only active when agentCapabilities.sessionCapabilities.resume.
  resumeSession?: {
    modes?: SessionModeState
    configOptions?: SessionConfigOption[]
    expectMcpServers?: McpServer[] // assert the request's mcpServers (by name); mismatch => invalidParams
  }
  // setSessionConfigOption() response source (see Behavior).
  setConfigOption?: {
    configOptions: SessionConfigOption[]
  }
}

interface FixtureTurn {
  steps?: FixtureStep[] // executed in order; default: none
  stopReason?: StopReason // default: 'end_turn'
  usage?: Usage // passed through on the prompt response if present
}
```

### Steps (`FixtureStep`)

Each step is discriminated by `kind`:

| `kind`          | Fields                                                             | Effect                                                                                                             |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `update`        | `update: SessionUpdate`                                            | Send a `session/update` through the SDK (type-checked).                                                            |
| `permission`    | `toolCall`, `options`, `onSelected?`, `onCancelled?`               | Send `session/request_permission`; then run the matching branch (see below). This is `FixturePermissionStep`.      |
| `readTextFile`  | `path`, `line?`, `limit?`                                          | Issue an `fs/read_text_file` reverse request to the client.                                                        |
| `writeTextFile` | `path`, `content`                                                  | Issue an `fs/write_text_file` reverse request to the client.                                                       |
| `terminal`      | `command`, `args?`, `env?`, `cwd?`, `outputByteLimit?`, `actions?` | Create a terminal, then run each action in `actions` in order: `'output' \| 'waitForExit' \| 'kill' \| 'release'`. |
| `sleep`         | `ms`                                                               | Wait `ms` milliseconds; interrupted immediately by `session/cancel`.                                               |
| `disconnect`    | none                                                               | Close the fixture transport stream while leaving the process alive.                                                |
| `error`         | `code`, `message`, `data?`                                         | Throw a `RequestError`, ending the current turn with a protocol error.                                             |
| `exit`          | `code`                                                             | Call `process.exit(code)` to simulate an agent crash.                                                              |

#### Permission branching (`FixturePermissionStep`)

```ts
interface FixturePermissionStep {
  kind: 'permission'
  toolCall: ToolCallUpdate
  options: PermissionOption[]
  onSelected?: Record<string, FixtureStep[]> // keyed by the selected optionId
  onCancelled?: FixtureStep[]
}
```

After the client responds, the matching branch runs as a nested step list:

- `outcome.outcome === 'selected'` -> `onSelected[outcome.optionId]` (or none).
- `outcome.outcome === 'cancelled'` -> `onCancelled` (or none).

A cancelled permission does **not** by itself set `stopReason: 'cancelled'`; the
turn's `stopReason` (or a `session/cancel` notification) decides that.

## Scripting the common test cases

- **Full turn with several updates then prompt termination:** put multiple
  `update` steps in a turn's `steps`, and set the turn's `stopReason` (e.g.
  `'end_turn'`). The prompt response carries that `stopReason` (and `usage` if
  set). See the minimal example above.

- **Crash (process exit):** add an `{ kind: 'exit', code }` step. The agent
  calls `process.exit(code)` mid-turn, dropping the connection.

- **`auth_required` at session creation:** set `session.authRequired: true`.
  `newSession` throws `auth_required` until any `authenticate` call succeeds,
  after which it is allowed through.

  This is only a fixture-agent behavior for testing raw ACP agent auth errors.
  acpjs itself does not expose login/logout APIs or model auth state; host/client
  callers receive the agent error and configure their local agent outside acpjs
  before retrying.

  ```ts
  const scenario: FixtureScenario = {
    initialize: { authMethods: [{ id: 'oauth', name: 'OAuth' }] },
    session: { authRequired: true },
  }
  ```

- **`loadSession` history replay (and failures):** declare
  `agentCapabilities.loadSession: true`, then provide `loadSession.replay` with
  the updates to replay before the response. To exercise retry/recovery, set
  `loadSession.error` plus `loadSession.failures: N` so the first `N` calls throw
  and the next succeeds.

  ```ts
  const scenario: FixtureScenario = {
    initialize: { agentCapabilities: { loadSession: true } },
    loadSession: {
      error: { code: -32603, message: 'transient' },
      failures: 1, // first loadSession throws, second succeeds
      replay: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'restored' },
        },
      ],
    },
  }
  ```

## Behavior (implementation-defined choices)

- Each `session/prompt` consumes `turns[i]` in order. Past the end of the script
  it falls back to an empty turn (`stopReason: 'end_turn'`, no steps). The prompt
  index is a single agent-global counter.
- `session/cancel` (notification): one `AbortController` per session. An in-flight
  prompt finishes its current step (a `sleep` is interrupted immediately), then
  resolves with `{ stopReason: 'cancelled' }`, discarding remaining steps.
- `session.authRequired: true` makes `session/new` throw `auth_required`; any
  `authenticate` call flips the gate open.
- `session.error` / `loadSession.error` throw the given `RequestError` from
  `newSession` / `loadSession`.
- Optional methods are wired up **iff** the matching capability is declared.
  Undeclared methods are not implemented and the SDK
  answers `-32601` automatically:
  - `loadSession` <- `agentCapabilities.loadSession`
  - `listSessions` / `resumeSession` / `closeSession` / `deleteSession` <-
    `agentCapabilities.sessionCapabilities.{list,resume,close,delete}`
  - `logout` <- `agentCapabilities.auth.logout`
  - `setSessionMode` <- any of `session.modes` / `loadSession.modes` /
    `resumeSession.modes` is present
  - `setSessionConfigOption` <- any of `setConfigOption.configOptions` /
    `session.configOptions` / `loadSession.configOptions` /
    `resumeSession.configOptions` is present
- `setSessionConfigOption` answers with the full `configOptions` list, picking the
  first present source in order: `setConfigOption.configOptions` ->
  `session.configOptions` -> `loadSession.configOptions` ->
  `resumeSession.configOptions`. It does not apply the value from the request.
- `loadSession` replays every entry in `loadSession.replay` before sending its
  response.
- `resumeSession.expectMcpServers`, when set, asserts the request's `mcpServers`
  (compared by name, in order); a mismatch throws `invalidParams`.
- `newSession` generates a `crypto.randomUUID()` session id when
  `session.sessionId` is absent.
