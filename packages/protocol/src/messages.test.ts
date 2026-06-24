import { expect, test } from 'vitest'

import { chunk, run, text } from './test-support'

import type { AcpjsEvent } from './index'

function imageChunk(
  type: 'agent-message-chunk',
  messageId: string,
  seq: number,
): AcpjsEvent {
  return {
    sessionId: 'sess-1',
    seq,
    ts: 0,
    type,
    payload: {
      content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      messageId,
    },
  }
}

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
      content: [text('Hello')],
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
    { kind: 'agent', messageId: null, content: [text('ab')], seq: 1 },
    { kind: 'thought', messageId: null, content: [text('hm')], seq: 3 },
    { kind: 'agent', messageId: null, content: [text('c')], seq: 4 },
  ])
})

test('consecutive text chunks merge into a single text block with concatenated text', () => {
  const state = run([
    chunk('agent-message-chunk', 'Lorem ', 'm1'),
    chunk('agent-message-chunk', 'ipsum ', 'm1', 2),
    chunk('agent-message-chunk', 'dolor', 'm1', 3),
  ])
  expect(state.messages).toEqual([
    {
      kind: 'agent',
      messageId: 'm1',
      content: [text('Lorem ipsum dolor')],
      seq: 1,
    },
  ])
})

test('consecutive thought chunks merge into a single text block', () => {
  const state = run([
    chunk('agent-thought-chunk', 'I should ', 't1'),
    chunk('agent-thought-chunk', 'check ', 't1', 2),
    chunk('agent-thought-chunk', 'the file', 't1', 3),
  ])
  expect(state.messages).toEqual([
    {
      kind: 'thought',
      messageId: 't1',
      content: [text('I should check the file')],
      seq: 1,
    },
  ])
})

test('a non-text block between text chunks prevents merging across it', () => {
  const state = run([
    chunk('agent-message-chunk', 'before', 'm1'),
    imageChunk('agent-message-chunk', 'm1', 2),
    chunk('agent-message-chunk', 'after', 'm1', 3),
  ])
  expect(state.messages).toEqual([
    {
      kind: 'agent',
      messageId: 'm1',
      content: [
        text('before'),
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        text('after'),
      ],
      seq: 1,
    },
  ])
})

test('text chunks under different messageIds never merge', () => {
  const state = run([
    chunk('agent-message-chunk', 'one', 'm1'),
    chunk('agent-message-chunk', 'two', 'm2', 2),
  ])
  expect(state.messages).toEqual([
    { kind: 'agent', messageId: 'm1', content: [text('one')], seq: 1 },
    { kind: 'agent', messageId: 'm2', content: [text('two')], seq: 2 },
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
