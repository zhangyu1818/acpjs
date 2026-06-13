import { expect, test } from 'vitest'

import { AcpClientError, toClientError } from './errors.ts'

test('toClientError returns AcpClientError instances unchanged', () => {
  const original = new AcpClientError({
    code: 'acpjs/session-closed',
    message: 'closed',
    retryable: false,
  })
  expect(toClientError(original)).toBe(original)
})

test('toClientError adopts a plain ErrorObject with a known acpjs code', () => {
  const error = toClientError({
    code: 'acpjs/transport-closed',
    message: 'gone',
    data: { hint: 1 },
    retryable: true,
  })
  expect(error).toBeInstanceOf(AcpClientError)
  expect(error).toMatchObject({
    code: 'acpjs/transport-closed',
    message: 'gone',
    data: { hint: 1 },
    retryable: true,
  })
})

test.each([
  [
    'object with an unknown code string',
    { code: 'not-an-acp-code', message: 'nope' },
    'unknown error',
  ],
  [
    'object with a numeric code',
    { code: -32603, message: 'protocol-ish' },
    'unknown error',
  ],
  ['native Error', new Error('native boom'), 'native boom'],
  ['plain string', 'string boom', 'string boom'],
  ['number', 42, 'unknown error'],
  ['null', null, 'unknown error'],
  ['undefined', undefined, 'unknown error'],
])(
  'toClientError falls back to acpjs/agent-error for %s',
  (_name, value, message) => {
    const error = toClientError(value)
    expect(error).toBeInstanceOf(AcpClientError)
    expect(error).toMatchObject({
      code: 'acpjs/agent-error',
      message,
      retryable: false,
    })
  },
)
