import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { expect, test } from 'vitest'

import { connectFixture, cwd } from './e2e-harness.ts'
import { writeScenarioFile } from './index.ts'

test('--scenario argv takes precedence over ACP_FIXTURE_SCENARIO when both are set', async () => {
  const argvPath = await writeScenarioFile({
    session: { sessionId: 'from-argv' },
  })
  const envPath = await writeScenarioFile({
    session: { sessionId: 'from-env' },
  })
  const { conn } = connectFixture(
    ['--scenario', argvPath],
    {},
    {
      ...process.env,
      ACP_FIXTURE_SCENARIO: envPath,
    },
  )
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION })

  await expect(conn.newSession({ cwd, mcpServers: [] })).resolves.toEqual({
    sessionId: 'from-argv',
  })
})

test('falls back to the empty scenario when neither argv nor env provides one', async () => {
  const env = { ...process.env }
  delete env.ACP_FIXTURE_SCENARIO
  const { conn } = connectFixture([], {}, env)
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION })

  const { sessionId } = await conn.newSession({ cwd, mcpServers: [] })

  await expect(
    conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }),
  ).resolves.toEqual({ stopReason: 'end_turn' })
})
