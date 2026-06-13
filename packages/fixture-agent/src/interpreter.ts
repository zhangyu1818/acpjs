import {
  RequestError,
  type RequestPermissionOutcome,
  type StopReason,
  type Usage,
} from '@agentclientprotocol/sdk'

import type {
  FixturePermissionStep,
  FixtureScenario,
  FixtureStep,
  FixtureTurn,
} from './scenario.ts'

export interface TurnOutcome {
  stopReason: StopReason
  usage?: Usage
}

export function turnForPrompt(
  scenario: FixtureScenario,
  promptIndex: number,
): FixtureTurn {
  return scenario.turns?.[promptIndex] ?? {}
}

export function permissionBranch(
  step: FixturePermissionStep,
  outcome: RequestPermissionOutcome,
): FixtureStep[] {
  if (outcome.outcome === 'cancelled') {
    return step.onCancelled ?? []
  }
  return step.onSelected?.[outcome.optionId] ?? []
}

function* runSteps(
  steps: FixtureStep[],
): Generator<FixtureStep, void, unknown> {
  for (const step of steps) {
    if (step.kind === 'error') {
      throw new RequestError(step.code, step.message, step.data)
    }
    const feedback = yield step
    if (step.kind === 'permission') {
      yield* runSteps(
        permissionBranch(step, feedback as RequestPermissionOutcome),
      )
    }
  }
}

export function* turnProgram(
  turn: FixtureTurn,
): Generator<FixtureStep, TurnOutcome, unknown> {
  yield* runSteps(turn.steps ?? [])
  const stopReason = turn.stopReason ?? 'end_turn'
  return turn.usage ? { stopReason, usage: turn.usage } : { stopReason }
}
