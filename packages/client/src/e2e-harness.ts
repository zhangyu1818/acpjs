import { createAcpHost, createHostEndpoint } from '@acpjs/core'
import {
  fixtureAgentCliPath,
  writeScenarioFile,
  type FixtureScenario,
} from '@acpjs/fixture-agent'
import { afterEach } from 'vitest'

import { createAcpClient } from './client.ts'
import { createInProcessTransport } from './in-process.ts'

import type { EnvelopeEndpoint } from '@acpjs/protocol'

import type { AcpClient, AgentDefinition } from './types.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function assertCloneable<T>(value: T): T {
  structuredClone(value)
  return value
}

function checkedEndpoint(endpoint: EnvelopeEndpoint): EnvelopeEndpoint {
  return {
    request: async (request) =>
      assertCloneable(await endpoint.request(assertCloneable(request))),
    subscribe: (params, onEvent) =>
      endpoint.subscribe(assertCloneable(params), (event) =>
        onEvent(assertCloneable(event)),
      ),
    onInboundRequest: (handler) =>
      endpoint.onInboundRequest((request) => handler(assertCloneable(request))),
    respondInbound: (response) =>
      endpoint.respondInbound(assertCloneable(response)),
  }
}

export async function e2eClient(scenario: FixtureScenario): Promise<{
  client: AcpClient
  definition: AgentDefinition
  connectClient: () => AcpClient
}> {
  const host = createAcpHost()
  const extraClients: AcpClient[] = []
  function connectClient(): AcpClient {
    const extra = createAcpClient({
      transport: createInProcessTransport(
        checkedEndpoint(createHostEndpoint(host)),
      ),
    })
    extraClients.push(extra)
    return extra
  }
  const client = connectClient()
  cleanups.push(async () => {
    for (const open of extraClients) await open.dispose()
    await host.dispose()
  })
  const scenarioPath = await writeScenarioFile(scenario)
  return {
    client,
    definition: {
      id: 'fixture',
      command: process.execPath,
      args: [fixtureAgentCliPath, '--scenario', scenarioPath],
    },
    connectClient,
  }
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
}
