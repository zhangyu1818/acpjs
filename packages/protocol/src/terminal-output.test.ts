import { expect, test } from 'vitest'

import { run } from './test-support'

import type { AcpEvent } from './index'

function terminalOutput(
  seq: number,
  payload: {
    terminalId: string
    delta?: string
    truncated?: boolean
    exit?: { exitCode?: number; signal?: string }
  },
): AcpEvent {
  return { sessionId: 'sess-1', seq, ts: 0, type: 'terminal-output', payload }
}

test('a terminal-output event initializes a terminal from an empty store', () => {
  const state = run([terminalOutput(1, { terminalId: 'term-1', delta: 'hi' })])
  expect(state.terminals['term-1']).toEqual({ output: 'hi', truncated: false })
})

test('successive deltas for the same terminal accumulate in order', () => {
  const state = run([
    terminalOutput(1, { terminalId: 'term-1', delta: 'foo' }),
    terminalOutput(2, { terminalId: 'term-1', delta: 'bar' }),
    terminalOutput(3, { terminalId: 'term-1', delta: 'baz' }),
  ])
  expect(state.terminals['term-1']?.output).toBe('foobarbaz')
})

test('an exit payload is merged onto the terminal state', () => {
  const state = run([
    terminalOutput(1, { terminalId: 'term-1', delta: 'done' }),
    terminalOutput(2, { terminalId: 'term-1', exit: { exitCode: 0 } }),
  ])
  expect(state.terminals['term-1']).toEqual({
    output: 'done',
    truncated: false,
    exit: { exitCode: 0 },
  })
})

test('terminal output beyond 1 MiB is truncated from the front, keeping the newest tail', () => {
  const big = `HEAD${'x'.repeat(1 << 20)}TAIL`
  const state = run([terminalOutput(1, { terminalId: 'term-1', delta: big })])
  expect(state.terminals['term-1']?.truncated).toBe(true)
  expect(
    new TextEncoder().encode(state.terminals['term-1']?.output).length,
  ).toBeLessThanOrEqual(1 << 20)
  expect(String(state.terminals['term-1']?.output).endsWith('TAIL')).toBe(true)
  expect(String(state.terminals['term-1']?.output).includes('HEAD')).toBe(false)
})

test('truncation respects UTF-8 character boundaries without replacement chars', () => {
  const big = '中'.repeat(400_000)
  const state = run([terminalOutput(1, { terminalId: 'term-1', delta: big })])
  const bytes = new TextEncoder().encode(state.terminals['term-1']?.output)
  expect(state.terminals['term-1']?.truncated).toBe(true)
  expect(bytes.length).toBeLessThanOrEqual(1 << 20)
  expect(String(state.terminals['term-1']?.output).length).toBeLessThan(
    bytes.length,
  )
  expect(String(state.terminals['term-1']?.output).includes('�')).toBe(false)
  expect(String(state.terminals['term-1']?.output).endsWith('中')).toBe(true)
})

test('a truncated flag carried by the event is preserved on the terminal', () => {
  const state = run([
    terminalOutput(1, { terminalId: 'term-1', delta: 'tail', truncated: true }),
  ])
  expect(state.terminals['term-1']?.truncated).toBe(true)
})

test('separate terminals are tracked independently', () => {
  const state = run([
    terminalOutput(1, { terminalId: 'term-1', delta: 'a' }),
    terminalOutput(2, { terminalId: 'term-2', delta: 'b' }),
  ])
  expect(state.terminals['term-1']?.output).toBe('a')
  expect(state.terminals['term-2']?.output).toBe('b')
})

test('a merged exit survives later deltas that omit exit', () => {
  const state = run([
    terminalOutput(1, {
      terminalId: 'term-1',
      delta: 'a',
      exit: { exitCode: 0 },
    }),
    terminalOutput(2, { terminalId: 'term-1', delta: 'b' }),
  ])
  expect(state.terminals['term-1']).toEqual({
    output: 'ab',
    truncated: false,
    exit: { exitCode: 0 },
  })
})

test('a truncated flag stays set after a later untruncated delta', () => {
  const state = run([
    terminalOutput(1, { terminalId: 'term-1', delta: 'tail', truncated: true }),
    terminalOutput(2, { terminalId: 'term-1', delta: 'more' }),
  ])
  expect(state.terminals['term-1']?.truncated).toBe(true)
  expect(state.terminals['term-1']?.output).toBe('tailmore')
})
