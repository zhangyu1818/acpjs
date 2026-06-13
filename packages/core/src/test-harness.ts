import {
  fixtureAgentCliPath,
  writeScenarioFile,
  type FixtureScenario,
} from '@acpjs/fixture-agent'
import { afterEach } from 'vitest'

import type {
  AcpEvent,
  AgentStatusChangePayload,
  DiagnosticPayload,
} from '@acpjs/protocol'

import type { AcpHost } from './host.ts'
import type { AgentDefinition } from './options.ts'

const hosts: AcpHost[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()))
})

export function trackHost<T extends AcpHost>(host: T): T {
  hosts.push(host)
  return host
}

export async function fixtureDefinition(
  scenario: FixtureScenario,
  id = 'fixture',
): Promise<{ definition: AgentDefinition; scenarioPath: string }> {
  const scenarioPath = await writeScenarioFile(scenario)
  return {
    definition: {
      id,
      command: process.execPath,
      args: [fixtureAgentCliPath, '--scenario', scenarioPath],
    },
    scenarioPath,
  }
}

export function collectEvents(
  host: AcpHost,
  sessionId: string | undefined,
  fromSeq = 0,
): AcpEvent[] {
  const events: AcpEvent[] = []
  host.subscribe(sessionId, fromSeq, (event) => events.push(event))
  return events
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

export function diagnosticPayloads(
  events: AcpEvent[],
  code: string,
): DiagnosticPayload[] {
  const found: DiagnosticPayload[] = []
  for (const event of events) {
    if (event.type === 'diagnostic' && event.payload.code === code) {
      found.push(event.payload)
    }
  }
  return found
}

export function agentStatusPayloads(
  events: AcpEvent[],
): AgentStatusChangePayload[] {
  const found: AgentStatusChangePayload[] = []
  for (const event of events) {
    if (event.type === 'agent-status-change') found.push(event.payload)
  }
  return found
}

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}
