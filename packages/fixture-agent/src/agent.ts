import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentSideConnection,
  type PromptResponse,
} from '@agentclientprotocol/sdk'

import { turnForPrompt, turnProgram } from './interpreter.ts'

import type { FixtureScenario, FixtureStep } from './scenario.ts'

export interface FixtureIo {
  writeRaw: (message: unknown) => void
  exit: (code: number) => never
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

export function createFixtureAgent(
  scenario: FixtureScenario,
  conn: AgentSideConnection,
  io: FixtureIo,
): Agent {
  let promptIndex = 0
  let authenticated = false
  const aborts = new Map<string, AbortController>()

  async function performStep(
    step: FixtureStep,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (step.kind) {
      case 'update': {
        await conn.sessionUpdate({ sessionId, update: step.update })
        return undefined
      }
      case 'permission': {
        const response = await conn.requestPermission({
          sessionId,
          toolCall: step.toolCall,
          options: step.options,
        })
        return response.outcome
      }
      case 'rawUpdate': {
        io.writeRaw({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: step.update },
        })
        return undefined
      }
      case 'exit': {
        return io.exit(step.code)
      }
      case 'sleep': {
        await sleep(step.ms, signal)
        return undefined
      }
      case 'readTextFile': {
        await conn.readTextFile({
          sessionId,
          path: step.path,
          ...(step.line === undefined ? {} : { line: step.line }),
          ...(step.limit === undefined ? {} : { limit: step.limit }),
        })
        return undefined
      }
      case 'writeTextFile': {
        await conn.writeTextFile({
          sessionId,
          path: step.path,
          content: step.content,
        })
        return undefined
      }
      case 'terminal': {
        const terminal = await conn.createTerminal({
          sessionId,
          command: step.command,
          ...(step.args ? { args: step.args } : {}),
          ...(step.env ? { env: step.env } : {}),
          ...(step.cwd ? { cwd: step.cwd } : {}),
          ...(step.outputByteLimit === undefined
            ? {}
            : { outputByteLimit: step.outputByteLimit }),
        })
        for (const action of step.actions ?? []) {
          if (action === 'output') {
            await terminal.currentOutput()
          } else if (action === 'waitForExit') {
            await terminal.waitForExit()
          } else if (action === 'kill') {
            await terminal.kill()
          } else {
            await terminal.release()
          }
        }
        return undefined
      }
      default: {
        throw RequestError.internalError({
          unsupportedStep: step.kind,
        })
      }
    }
  }

  async function runTurn(
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
      feedback = await performStep(next.value, sessionId, signal)
      if (signal.aborted) {
        return { stopReason: 'cancelled' }
      }
    }
  }

  const agent: Agent = {
    async initialize() {
      const init = scenario.initialize
      return {
        protocolVersion: init?.protocolVersion ?? PROTOCOL_VERSION,
        ...(init?.agentCapabilities
          ? { agentCapabilities: init.agentCapabilities }
          : {}),
        ...(init?.authMethods ? { authMethods: init.authMethods } : {}),
      }
    },
    async newSession() {
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
    },
    async authenticate() {
      authenticated = true
      return {}
    },
    async prompt(params) {
      const controller = new AbortController()
      aborts.set(params.sessionId, controller)
      try {
        return await runTurn(params.sessionId, controller.signal)
      } finally {
        aborts.delete(params.sessionId)
      }
    },
    async cancel(params) {
      aborts.get(params.sessionId)?.abort()
    },
  }

  const capabilities = scenario.initialize?.agentCapabilities

  let loadCalls = 0

  if (capabilities?.loadSession === true) {
    agent.loadSession = async (params) => {
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
      for (const update of load?.replay ?? []) {
        await conn.sessionUpdate({ sessionId: params.sessionId, update })
      }
      return {
        ...(load?.modes ? { modes: load.modes } : {}),
        ...(load?.configOptions ? { configOptions: load.configOptions } : {}),
      }
    }
  }

  const sessionCapabilities = capabilities?.sessionCapabilities

  if (sessionCapabilities?.list) {
    agent.listSessions = async () => {
      const list = scenario.listSessions
      return {
        sessions: list?.sessions ?? [],
        ...(list?.nextCursor ? { nextCursor: list.nextCursor } : {}),
      }
    }
  }

  if (sessionCapabilities?.resume) {
    agent.resumeSession = async (params) => {
      const resume = scenario.resumeSession
      if (resume?.expectMcpServers) {
        const expected = resume.expectMcpServers.map((server) => server.name)
        const received = (params.mcpServers ?? []).map((server) => server.name)
        if (JSON.stringify(received) !== JSON.stringify(expected)) {
          throw RequestError.invalidParams({ expected, received })
        }
      }
      return {
        ...(resume?.modes ? { modes: resume.modes } : {}),
        ...(resume?.configOptions
          ? { configOptions: resume.configOptions }
          : {}),
      }
    }
  }

  if (sessionCapabilities?.close) {
    agent.closeSession = async () => ({})
  }

  if (sessionCapabilities?.delete) {
    agent.deleteSession = async () => ({})
  }

  if (capabilities?.auth?.logout) {
    agent.logout = async () => ({})
  }

  const modes =
    scenario.session?.modes ??
    scenario.loadSession?.modes ??
    scenario.resumeSession?.modes

  if (modes) {
    agent.setSessionMode = async () => ({})
  }

  const configOptions =
    scenario.setConfigOption?.configOptions ??
    scenario.session?.configOptions ??
    scenario.loadSession?.configOptions ??
    scenario.resumeSession?.configOptions

  if (configOptions) {
    agent.setSessionConfigOption = async () => ({ configOptions })
  }

  return agent
}
