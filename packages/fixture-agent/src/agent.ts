import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentContext,
  type PromptResponse,
} from '@agentclientprotocol/sdk'

import { performFixtureStep } from './agent-steps.ts'
import { turnForPrompt, turnProgram } from './interpreter.ts'

import type { FixtureScenario } from './scenario.ts'

export interface FixtureIo {
  disconnect: () => void
  exit: (code: number) => never
}

function requireExpectedMcpServers(
  expectedServers: readonly { name: string }[] | undefined,
  receivedServers: readonly { name: string }[] | undefined,
): void {
  if (expectedServers === undefined) return
  const expected = expectedServers.map((server) => server.name)
  const received = (receivedServers ?? []).map((server) => server.name)
  if (JSON.stringify(received) !== JSON.stringify(expected)) {
    throw RequestError.invalidParams({ expected, received })
  }
}

export function createFixtureAgent(
  scenario: FixtureScenario,
  io: FixtureIo,
): AgentApp {
  let promptIndex = 0
  let authenticated = false
  const aborts = new Map<string, AbortController>()

  async function runTurn(
    client: AgentContext,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    const program = turnProgram(turnForPrompt(scenario, promptIndex))
    promptIndex += 1
    let feedback: unknown
    for (;;) {
      const next = program.next(feedback)
      if (next.done) {
        return signal.aborted ? { stopReason: 'cancelled' } : next.value
      }
      feedback = await performFixtureStep(
        client,
        next.value,
        sessionId,
        signal,
        io,
      )
      if (signal.aborted) {
        return { stopReason: 'cancelled' }
      }
    }
  }

  const app = agent({ name: '@acpjs/fixture-agent' })
    .onRequest(methods.agent.initialize, () => {
      const init = scenario.initialize
      return {
        protocolVersion: init?.protocolVersion ?? PROTOCOL_VERSION,
        ...(init?.agentCapabilities
          ? { agentCapabilities: init.agentCapabilities }
          : {}),
        ...(init?.authMethods ? { authMethods: init.authMethods } : {}),
        ...(init?.agentInfo ? { agentInfo: init.agentInfo } : {}),
      }
    })
    .onRequest(methods.agent.session.new, () => {
      const session = scenario.session
      if (session?.authRequired === true && !authenticated) {
        throw RequestError.authRequired()
      }
      if (session?.error) {
        throw new RequestError(
          session.error.code,
          session.error.message,
          session.error.data,
        )
      }
      return {
        sessionId: session?.sessionId ?? crypto.randomUUID(),
        ...(session?.modes ? { modes: session.modes } : {}),
        ...(session?.configOptions
          ? { configOptions: session.configOptions }
          : {}),
      }
    })
    .onRequest(methods.agent.authenticate, () => {
      authenticated = true
      return {}
    })
    .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
      const controller = new AbortController()
      aborts.set(params.sessionId, controller)
      try {
        return await runTurn(client, params.sessionId, controller.signal)
      } finally {
        aborts.delete(params.sessionId)
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      aborts.get(params.sessionId)?.abort()
    })

  const capabilities = scenario.initialize?.agentCapabilities

  let loadCalls = 0

  if (capabilities?.loadSession === true) {
    app.onRequest(methods.agent.session.load, async ({ client, params }) => {
      const load = scenario.loadSession
      loadCalls += 1
      if (
        load?.error &&
        (load.failures === undefined || loadCalls <= load.failures)
      ) {
        throw new RequestError(
          load.error.code,
          load.error.message,
          load.error.data,
        )
      }
      for (const step of load?.steps ?? []) {
        await performFixtureStep(
          client,
          step,
          params.sessionId,
          new AbortController().signal,
          io,
        )
      }
      for (const update of load?.replay ?? []) {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        })
      }
      requireExpectedMcpServers(load?.expectMcpServers, params.mcpServers)
      return {
        ...(load?.modes ? { modes: load.modes } : {}),
        ...(load?.configOptions ? { configOptions: load.configOptions } : {}),
      }
    })
  }

  const sessionCapabilities = capabilities?.sessionCapabilities
  let resumeCalls = 0

  if (sessionCapabilities?.list) {
    app.onRequest(methods.agent.session.list, () => {
      const list = scenario.listSessions
      return {
        sessions: list?.sessions ?? [],
        ...(list?.nextCursor ? { nextCursor: list.nextCursor } : {}),
      }
    })
  }

  if (sessionCapabilities?.resume) {
    app.onRequest(methods.agent.session.resume, async ({ client, params }) => {
      const resume = scenario.resumeSession
      resumeCalls += 1
      if (
        resume?.error &&
        (resume.failures === undefined || resumeCalls <= resume.failures)
      ) {
        throw new RequestError(
          resume.error.code,
          resume.error.message,
          resume.error.data,
        )
      }
      for (const step of resume?.steps ?? []) {
        await performFixtureStep(
          client,
          step,
          params.sessionId,
          new AbortController().signal,
          io,
        )
      }
      requireExpectedMcpServers(resume?.expectMcpServers, params.mcpServers)
      return {
        ...(resume?.modes ? { modes: resume.modes } : {}),
        ...(resume?.configOptions
          ? { configOptions: resume.configOptions }
          : {}),
      }
    })
  }

  if (sessionCapabilities?.close) {
    app.onRequest(methods.agent.session.close, () => {
      const error = scenario.closeSession?.error
      if (error) {
        throw new RequestError(error.code, error.message, error.data)
      }
      return {}
    })
  }

  if (sessionCapabilities?.delete) {
    app.onRequest(methods.agent.session.delete, () => {
      const error = scenario.deleteSession?.error
      if (error) {
        throw new RequestError(error.code, error.message, error.data)
      }
      return {}
    })
  }

  if (capabilities?.auth?.logout) {
    app.onRequest(methods.agent.logout, () => ({}))
  }

  const modes =
    scenario.session?.modes ??
    scenario.loadSession?.modes ??
    scenario.resumeSession?.modes

  if (modes) {
    app.onRequest(methods.agent.session.setMode, () => ({}))
  }

  const configOptions =
    scenario.setConfigOption?.configOptions ??
    scenario.session?.configOptions ??
    scenario.loadSession?.configOptions ??
    scenario.resumeSession?.configOptions

  if (configOptions) {
    app.onRequest(methods.agent.session.setConfigOption, () => ({
      configOptions,
    }))
  }

  return app
}
