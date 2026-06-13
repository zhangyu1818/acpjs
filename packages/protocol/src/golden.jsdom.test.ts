// @vitest-environment jsdom
import { expect, test } from 'vitest'

import { goldenCorpus, goldenSessionId } from './golden-corpus'
import { allEventTypes, goldenExpectedState } from './golden-expected'
import { createInitialSessionState, reduce } from './index'

test('this mirror file runs inside a DOM environment', () => {
  expect(globalThis.document).toBeDefined()
})

test('the golden corpus covers every event type of the closed union', () => {
  const seen = new Set(goldenCorpus.map((event) => event.type))
  expect([...seen].sort()).toEqual([...allEventTypes].sort())
})

test('reducing the golden corpus yields the expected state snapshot', () => {
  let state = createInitialSessionState(goldenSessionId)
  for (const event of goldenCorpus) state = reduce(state, event)
  expect(state).toEqual(goldenExpectedState)
})

test('every golden corpus event survives structuredClone deep-equal', () => {
  for (const event of goldenCorpus) {
    expect(structuredClone(event)).toEqual(event)
  }
})
