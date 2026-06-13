import { expect, test } from 'vitest'

import { chunk, run, text } from './test-support'

test('a message chunk starts a new message holding its content block', () => {
  const state = run([chunk('user-message-chunk', 'hi', 'u1')])
  expect(state.messages).toEqual([
    { kind: 'user', messageId: 'u1', content: [text('hi')], seq: 1 },
  ])
})

test('chunks sharing a messageId merge into the same message even across other messages', () => {
  const state = run([
    chunk('agent-message-chunk', 'Hel', 'm1'),
    chunk('agent-thought-chunk', 'pondering', 't1', 2),
    chunk('agent-message-chunk', 'lo', 'm1', 3),
  ])
  expect(state.messages).toEqual([
    {
      kind: 'agent',
      messageId: 'm1',
      content: [text('Hel'), text('lo')],
      seq: 1,
    },
    { kind: 'thought', messageId: 't1', content: [text('pondering')], seq: 2 },
  ])
})

test('chunks without messageId merge only into a consecutive trailing message of the same kind', () => {
  const state = run([
    chunk('agent-message-chunk', 'a'),
    chunk('agent-message-chunk', 'b', undefined, 2),
    chunk('agent-thought-chunk', 'hm', undefined, 3),
    chunk('agent-message-chunk', 'c', undefined, 4),
  ])
  expect(state.messages).toEqual([
    { kind: 'agent', messageId: null, content: [text('a'), text('b')], seq: 1 },
    { kind: 'thought', messageId: null, content: [text('hm')], seq: 3 },
    { kind: 'agent', messageId: null, content: [text('c')], seq: 4 },
  ])
})

test('a chunk whose messageId differs from the previous one starts a new message', () => {
  const state = run([
    chunk('agent-message-chunk', 'first', 'm1'),
    chunk('agent-message-chunk', 'second', 'm2', 2),
    chunk('agent-message-chunk', 'third', undefined, 3),
  ])
  expect(state.messages).toEqual([
    { kind: 'agent', messageId: 'm1', content: [text('first')], seq: 1 },
    { kind: 'agent', messageId: 'm2', content: [text('second')], seq: 2 },
    { kind: 'agent', messageId: null, content: [text('third')], seq: 3 },
  ])
})
