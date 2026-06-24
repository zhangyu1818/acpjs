import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentNotificationMethod,
  type AgentNotificationParamsByMethod,
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
  type Client,
  type ClientConnection,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { afterEach } from 'vitest'

import {
  fixtureAgentCliPath,
  writeScenarioFile,
  type FixtureScenario,
} from './index.ts'

export const cwd = '/tmp'

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill()
  }
})

export function trackChild<T extends ChildProcess>(child: T): T {
  children.push(child)
  return child
}

function createFixtureConnection(connection: ClientConnection) {
  const request = <Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
  ): Promise<AgentRequestResponsesByMethod[Method]> =>
    connection.agent.request(method, params)
  const notify = <Method extends AgentNotificationMethod>(
    method: Method,
    params: AgentNotificationParamsByMethod[Method],
  ): Promise<void> => connection.agent.notify(method, params)

  return {
    signal: connection.signal,
    closed: connection.closed,
    close: (error?: unknown) => connection.close(error),
    initialize: (
      params: AgentRequestParamsByMethod[typeof methods.agent.initialize],
    ) => request(methods.agent.initialize, params),
    newSession: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.new],
    ) => request(methods.agent.session.new, params),
    authenticate: (
      params: AgentRequestParamsByMethod[typeof methods.agent.authenticate],
    ) => request(methods.agent.authenticate, params),
    loadSession: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.load],
    ) => request(methods.agent.session.load, params),
    listSessions: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.list],
    ) => request(methods.agent.session.list, params),
    resumeSession: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.resume],
    ) => request(methods.agent.session.resume, params),
    closeSession: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.close],
    ) => request(methods.agent.session.close, params),
    deleteSession: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.delete],
    ) => request(methods.agent.session.delete, params),
    logout: (params: AgentRequestParamsByMethod[typeof methods.agent.logout]) =>
      request(methods.agent.logout, params),
    setSessionMode: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.setMode],
    ) => request(methods.agent.session.setMode, params),
    setSessionConfigOption: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.setConfigOption],
    ) => request(methods.agent.session.setConfigOption, params),
    prompt: (
      params: AgentRequestParamsByMethod[typeof methods.agent.session.prompt],
    ) => request(methods.agent.session.prompt, params),
    cancel: (
      params: AgentNotificationParamsByMethod[typeof methods.agent.session.cancel],
    ) => notify(methods.agent.session.cancel, params),
  }
}

function buildClientApp(
  updates: SessionNotification[],
  overrides: Partial<Client>,
) {
  const app = createClientApp({ name: '@acpjs/fixture-agent-tests' })
    .onNotification(methods.client.session.update, async ({ params }) => {
      updates.push(params)
      await overrides.sessionUpdate?.(params)
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      return (
        overrides.requestPermission?.(params) ?? {
          outcome: { outcome: 'cancelled' },
        }
      )
    })

  const readTextFile = overrides.readTextFile
  if (readTextFile) {
    app.onRequest(methods.client.fs.readTextFile, ({ params }) =>
      readTextFile(params),
    )
  }
  const writeTextFile = overrides.writeTextFile
  if (writeTextFile) {
    app.onRequest(methods.client.fs.writeTextFile, ({ params }) =>
      writeTextFile(params),
    )
  }
  const createTerminal = overrides.createTerminal
  if (createTerminal) {
    app.onRequest(methods.client.terminal.create, ({ params }) =>
      createTerminal(params),
    )
  }
  const terminalOutput = overrides.terminalOutput
  if (terminalOutput) {
    app.onRequest(methods.client.terminal.output, ({ params }) =>
      terminalOutput(params),
    )
  }
  const waitForTerminalExit = overrides.waitForTerminalExit
  if (waitForTerminalExit) {
    app.onRequest(methods.client.terminal.waitForExit, ({ params }) =>
      waitForTerminalExit(params),
    )
  }
  const killTerminal = overrides.killTerminal
  if (killTerminal) {
    app.onRequest(methods.client.terminal.kill, ({ params }) =>
      killTerminal(params),
    )
  }
  const releaseTerminal = overrides.releaseTerminal
  if (releaseTerminal) {
    app.onRequest(methods.client.terminal.release, ({ params }) =>
      releaseTerminal(params),
    )
  }
  return app
}

export function connectFixture(
  args: string[],
  overrides: Partial<Client> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const child = trackChild(
    spawn(process.execPath, [fixtureAgentCliPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }),
  )
  const updates: SessionNotification[] = []
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const connection = buildClientApp(updates, overrides).connect(stream)
  return { child, conn: createFixtureConnection(connection), updates }
}

export async function spawnFixture(
  scenario: FixtureScenario,
  overrides: Partial<Client> = {},
  options: { useEnv?: boolean } = {},
) {
  const scenarioPath = await writeScenarioFile(scenario)
  return options.useEnv
    ? connectFixture([], overrides, {
        ...process.env,
        ACP_FIXTURE_SCENARIO: scenarioPath,
      })
    : connectFixture(['--scenario', scenarioPath], overrides)
}

export async function startSession(
  scenario: FixtureScenario,
  overrides: Partial<Client> = {},
) {
  const fixture = await spawnFixture(scenario, overrides)
  await fixture.conn.initialize({ protocolVersion: PROTOCOL_VERSION })
  const { sessionId } = await fixture.conn.newSession({ cwd, mcpServers: [] })
  return { ...fixture, sessionId }
}

export const chunk = (text: string): SessionNotification['update'] => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
})
