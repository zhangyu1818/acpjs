import { readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { parseArgs } from 'node:util'

import { ndJsonStream } from '@agentclientprotocol/sdk'

import { createFixtureAgent } from './agent.ts'

import type { FixtureScenario } from './scenario.ts'

const { values } = parseArgs({
  options: { scenario: { type: 'string' } },
  strict: false,
})

const scenarioPath =
  (typeof values.scenario === 'string' ? values.scenario : undefined) ??
  process.env['ACP_FIXTURE_SCENARIO']

const scenario: FixtureScenario = scenarioPath
  ? (JSON.parse(readFileSync(scenarioPath, 'utf8')) as FixtureScenario)
  : {}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
)

const app = createFixtureAgent(scenario, {
  disconnect() {
    process.stdout.end()
  },
  exit: (code) => process.exit(code),
})
const conn = app.connect(stream)

await conn.closed
