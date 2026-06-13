import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
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
  const client: Client = {
    async sessionUpdate(params) {
      updates.push(params)
    },
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' } }
    },
    ...overrides,
  }
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const conn = new ClientSideConnection(() => client, stream)
  return { child, conn, updates }
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
