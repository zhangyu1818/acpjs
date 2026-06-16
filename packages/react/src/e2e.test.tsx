import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ReactElement } from 'react'

import {
  createAcpClient,
  createInProcessTransport,
  type AcpSession,
} from '@acpjs/client'
import { createAcpHost, createHostEndpoint } from '@acpjs/core'
import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { AcpProvider, useSession } from './index.ts'

const resolveDependency = createRequire(
  path.join(process.cwd(), 'package.json'),
)
const fixtureAgentCliPath = path.join(
  path.dirname(resolveDependency.resolve('@acpjs/fixture-agent')),
  'cli.ts',
)

async function writeScenario(scenario: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'acpjs-react-e2e-'))
  const scenarioPath = path.join(dir, 'scenario.json')
  await writeFile(scenarioPath, JSON.stringify(scenario))
  return scenarioPath
}

function SessionText({ id }: { id: string }): ReactElement {
  const session = useSession(id)
  const text = session?.state.messages
    .map((message) =>
      message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(''),
    )
    .join('|')
  return <div data-testid="e2e">{text ?? 'none'}</div>
}

test('end to end: fixture agent events arrive in the rendered hook output', async () => {
  const host = createAcpHost()
  const transport = createInProcessTransport(createHostEndpoint(host))
  const client = createAcpClient({ transport })
  try {
    const scenarioPath = await writeScenario({
      turns: [
        {
          steps: [
            {
              kind: 'update',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'hi from fixture' },
              },
            },
          ],
          stopReason: 'end_turn',
        },
      ],
    })

    let session: AcpSession | undefined
    await act(async () => {
      const agent = await client.agents.spawn({
        id: 'fixture',
        command: process.execPath,
        args: [fixtureAgentCliPath, '--scenario', scenarioPath],
      })
      session = await agent.sessions.create({
        cwd: '/tmp',
        mcpServers: [],
        additionalDirectories: [],
      })
    })

    render(
      <AcpProvider client={client}>
        <SessionText id={session!.sessionId} />
      </AcpProvider>,
    )
    expect(screen.getByTestId('e2e').textContent).toBe('')

    await act(async () => {
      const result = await session!.prompt([{ type: 'text', text: 'go' }])
      expect(result.stopReason).toBe('end_turn')
    })

    expect(screen.getByTestId('e2e').textContent).toBe('hi from fixture')
  } finally {
    await client.dispose()
    await host.dispose()
  }
}, 20000)
