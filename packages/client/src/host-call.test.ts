import { expect, test } from 'vitest'

import { createAcpClient } from './index.ts'
import { createFakeHub } from './test-support.ts'

test('agents.spawn performs a typed host request roundtrip over the transport', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({
    agentId: 'agent-1',
    status: 'ready',
    restartCount: 0,
    capabilities: { loadSession: true },
  }))
  const client = createAcpClient({ transport: hub.connection().transport })

  const agent = await client.agents.spawn({ id: 'fixture', command: 'node' })

  expect(agent.agentId).toBe('agent-1')
  expect(agent.getSnapshot().capabilities).toEqual({ loadSession: true })
  expect(hub.requests).toHaveLength(1)
  expect(hub.requests[0]).toMatchObject({
    method: 'agents/spawn',
    params: { definition: { id: 'fixture', command: 'node' } },
  })
  expect(typeof hub.requests[0]?.id).toBe('string')
})
