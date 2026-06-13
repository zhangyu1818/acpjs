import { expect, test } from 'vitest'

import { turnProgram } from './interpreter.ts'

import type {
  FixturePermissionStep,
  FixtureStep,
  FixtureTurn,
} from './scenario.ts'

const update = (text: string): FixtureStep => ({
  kind: 'update',
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  },
})

function drive(
  turn: FixtureTurn,
  feedback: (step: FixtureStep) => unknown = () => undefined,
) {
  const program = turnProgram(turn)
  const steps: FixtureStep[] = []
  let next = program.next()
  while (!next.done) {
    steps.push(next.value)
    next = program.next(feedback(next.value))
  }
  return { steps, outcome: next.value }
}

test('returns scripted stopReason and usage', () => {
  const usage = { inputTokens: 3, outputTokens: 7, totalTokens: 10 }
  const { outcome } = drive({ stopReason: 'refusal', usage })

  expect(outcome).toEqual({ stopReason: 'refusal', usage })
})

const permission = (
  branches: Pick<FixturePermissionStep, 'onSelected' | 'onCancelled'>,
): FixturePermissionStep => ({
  kind: 'permission',
  toolCall: { toolCallId: 'call_1' },
  options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
  ...branches,
})

test('runs the branch matching the selected permission option, then continues remaining steps', () => {
  const turn: FixtureTurn = {
    steps: [
      permission({
        onSelected: { allow: [update('granted')], deny: [update('denied')] },
      }),
      update('after'),
    ],
  }

  const { steps } = drive(turn, (step) =>
    step.kind === 'permission'
      ? { outcome: 'selected', optionId: 'allow' }
      : undefined,
  )

  expect(steps).toEqual([turn.steps?.[0], update('granted'), update('after')])
})

test('skips branch steps when no branch matches the selected option', () => {
  const turn: FixtureTurn = {
    steps: [
      permission({ onSelected: { allow: [update('granted')] } }),
      update('after'),
    ],
  }

  const { steps } = drive(turn, (step) =>
    step.kind === 'permission'
      ? { outcome: 'selected', optionId: 'reject' }
      : undefined,
  )

  expect(steps).toEqual([turn.steps?.[0], update('after')])
})
