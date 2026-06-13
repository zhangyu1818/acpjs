import { expect, test } from 'vitest'

import { createAcpClient } from './index.ts'
import { createFakeHub } from './test-support.ts'

test('agents.spawn performs a typed RPC roundtrip over the transport', async () => {
  const hub = createFakeHub()
  hub.handle('agents/spawn', () => ({
    agentId: 'agent-1',
    status: 'ready',
    restartCount: 0,
    capabilities: { loadSession: true },
    authMethods: [{ id: 'device', name: 'Device flow' }],
  }))
  const client = createAcpClient({ transport: hub.connection().transport })

  const agent = await client.agents.spawn({ id: 'fixture', command: 'node' })

  expect(agent.agentId).toBe('agent-1')
  expect(agent.capabilities).toEqual({ loadSession: true })
  expect(agent.authMethods).toEqual([{ id: 'device', name: 'Device flow' }])
  expect(hub.requests).toHaveLength(1)
  expect(hub.requests[0]).toMatchObject({
    method: 'agents/spawn',
    params: { definition: { id: 'fixture', command: 'node' } },
  })
  expect(typeof hub.requests[0]?.id).toBe('string')
})
