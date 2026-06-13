import { expect, test } from 'vitest'

import { createInitialSessionState, reduce } from './index'
import { run } from './test-support'

test('a plan event replaces the current plan wholesale', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'plan',
      payload: {
        entries: [
          { content: 'step 1', priority: 'high', status: 'completed' },
          { content: 'step 2', priority: 'low', status: 'pending' },
        ],
      },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'plan',
      payload: {
        entries: [
          { content: 'step 2', priority: 'low', status: 'in_progress' },
        ],
      },
    },
  ])
  expect(state.plan).toEqual({
    entries: [{ content: 'step 2', priority: 'low', status: 'in_progress' }],
  })
})

test('an available commands update replaces the command list wholesale', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'available-commands-update',
      payload: {
        availableCommands: [
          { name: 'web', description: 'Search the web' },
          { name: 'plan', description: 'Plan mode' },
        ],
      },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'available-commands-update',
      payload: {
        availableCommands: [
          {
            name: 'web',
            description: 'Search the web',
            input: { hint: 'query' },
          },
        ],
      },
    },
  ])
  expect(state.availableCommands).toEqual([
    { name: 'web', description: 'Search the web', input: { hint: 'query' } },
  ])
})

test('session config init seeds modes and config options', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'session-config-init',
      payload: {
        modes: {
          currentModeId: 'normal',
          availableModes: [
            { id: 'normal', name: 'Normal' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        configOptions: [
          {
            type: 'select',
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'sonnet',
            options: [
              { value: 'sonnet', name: 'Sonnet' },
              { value: 'opus', name: 'Opus' },
            ],
          },
        ],
      },
    },
  ])
  expect(state.modes).toEqual({
    currentModeId: 'normal',
    availableModes: [
      { id: 'normal', name: 'Normal' },
      { id: 'plan', name: 'Plan' },
    ],
  })
  expect(state.configOptions).toEqual([
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
  ])
})

test('session config init without modes or config options keeps previous values', () => {
  const initial = createInitialSessionState('sess-1')
  const next = reduce(initial, {
    sessionId: 'sess-1',
    seq: 1,
    ts: 0,
    type: 'session-config-init',
    payload: {},
  })
  expect(next.modes).toBeNull()
  expect(next.configOptions).toEqual([])
})

test('a current mode update switches the current mode while keeping available modes', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'session-config-init',
      payload: {
        modes: {
          currentModeId: 'normal',
          availableModes: [
            { id: 'normal', name: 'Normal' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'current-mode-update',
      payload: { currentModeId: 'plan' },
    },
  ])
  expect(state.modes).toEqual({
    currentModeId: 'plan',
    availableModes: [
      { id: 'normal', name: 'Normal' },
      { id: 'plan', name: 'Plan' },
    ],
  })
})

test('a current mode update before any mode state creates one with no available modes', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'current-mode-update',
      payload: { currentModeId: 'plan' },
    },
  ])
  expect(state.modes).toEqual({ currentModeId: 'plan', availableModes: [] })
})

test('a config options update replaces config options wholesale', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'session-config-init',
      payload: {
        configOptions: [
          {
            type: 'boolean',
            id: 'web-search',
            name: 'Web search',
            currentValue: false,
          },
        ],
      },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'config-options-update',
      payload: {
        configOptions: [
          {
            type: 'boolean',
            id: 'web-search',
            name: 'Web search',
            currentValue: true,
          },
        ],
      },
    },
  ])
  expect(state.configOptions).toEqual([
    {
      type: 'boolean',
      id: 'web-search',
      name: 'Web search',
      currentValue: true,
    },
  ])
})

test('session info updates apply partially without clearing unmentioned fields', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'session-info-update',
      payload: { title: 'Greeting session' },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'session-info-update',
      payload: { updatedAt: '2026-06-10T08:00:00Z' },
    },
  ])
  expect(state.info).toEqual({
    title: 'Greeting session',
    updatedAt: '2026-06-10T08:00:00Z',
  })
})

test('a session info update with an explicit null clears that field', () => {
  const state = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'session-info-update',
      payload: { title: 'Greeting session', updatedAt: '2026-06-10T08:00:00Z' },
    },
    {
      sessionId: 'sess-1',
      seq: 2,
      ts: 0,
      type: 'session-info-update',
      payload: { title: null },
    },
  ])
  expect(state.info).toEqual({
    title: null,
    updatedAt: '2026-06-10T08:00:00Z',
  })
})

test('a usage update tracks context window occupancy with optional cost', () => {
  const first = run([
    {
      sessionId: 'sess-1',
      seq: 1,
      ts: 0,
      type: 'usage-update',
      payload: { used: 800, size: 200000 },
    },
  ])
  expect(first.usage).toEqual({ used: 800, size: 200000, cost: null })

  const second = reduce(first, {
    sessionId: 'sess-1',
    seq: 2,
    ts: 0,
    type: 'usage-update',
    payload: {
      used: 1200,
      size: 200000,
      cost: { amount: 0.12, currency: 'USD' },
    },
  })
  expect(second.usage).toEqual({
    used: 1200,
    size: 200000,
    cost: { amount: 0.12, currency: 'USD' },
  })
})
