import { expect, test } from 'vitest'

import { createAcpHost, type StorageAdapter } from './index.ts'
import {
  fixtureDefinition,
  sessionParams,
  trackHost,
  waitFor,
} from './test-harness.ts'

test('disconnect during in-flight load is not overwritten by the late load commit', async () => {
  let releaseReplace: (() => void) | undefined
  const replaceBlocked = new Promise<void>((resolvePromise) => {
    releaseReplace = resolvePromise
  })
  let replaceCalls = 0
  const storage: StorageAdapter = {
    appendEvent() {},
    appendMeta() {},
    listSessions: () => [],
    loadEvents: () => [],
    replaceSession() {
      replaceCalls += 1
      return replaceBlocked
    },
  }
  const host = trackHost(createAcpHost({ storage }))
  const { definition } = await fixtureDefinition({
    initialize: { agentCapabilities: { loadSession: true } },
    session: { sessionId: 'sess-disconnect-load' },
    loadSession: { steps: [], replay: [] },
  })
  const agent = await host.spawnAgent(definition)
  const created = await host.createSession(agent.agentId, sessionParams('/tmp'))
  if (created.status !== 'active') throw new Error('expected active')

  const loading = host
    .loadSession(agent.agentId, 'sess-disconnect-load', sessionParams('/tmp'))
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  await waitFor(() => replaceCalls === 1)

  await host.disposeAgent(agent.agentId)
  expect(host.getSession('sess-disconnect-load')?.status).toBe('disconnected')

  releaseReplace?.()
  await loading

  expect(host.getSession('sess-disconnect-load')?.status).toBe('disconnected')
})
