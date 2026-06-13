import { isAbsolute, resolve } from 'node:path'

import { expect, test } from 'vitest'

import { resolveAgentDefinition, resolveHostOptions } from './index.ts'

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected function to throw')
}

test('host options apply spec defaults', () => {
  const options = resolveHostOptions()

  expect(options.restart).toBe('never')
  expect(options.restartLimit).toBe(3)
  expect(options.restartBackoff).toEqual({
    initialMs: 1000,
    factor: 2,
    maxMs: 30_000,
  })
  expect(options.permissionPolicy).toEqual([])
  expect(options.killTimeoutMs).toBe(5000)
  expect(typeof options.storage.appendEvent).toBe('function')
  expect(typeof options.storage.listSessions).toBe('function')
  expect(typeof options.storage.loadEvents).toBe('function')
})

test('resolved host options are frozen', () => {
  const options = resolveHostOptions()

  expect(Object.isFrozen(options)).toBe(true)
  expect(Object.isFrozen(options.restartBackoff)).toBe(true)
  expect(Object.isFrozen(options.permissionPolicy)).toBe(true)
})

test('invalid restart mode throws acpjs/config-invalid synchronously', () => {
  expect(
    captureError(() => resolveHostOptions({ restart: 'always' as never })),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
})

test('invalid restartLimit throws acpjs/config-invalid', () => {
  expect(
    captureError(() => resolveHostOptions({ restartLimit: -1 })),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
  expect(
    captureError(() => resolveHostOptions({ restartLimit: 1.5 })),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
})

test('invalid restartBackoff throws acpjs/config-invalid', () => {
  expect(
    captureError(() =>
      resolveHostOptions({
        restartBackoff: { initialMs: 0, factor: 2, maxMs: 30_000 },
      }),
    ),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
  expect(
    captureError(() =>
      resolveHostOptions({
        restartBackoff: { initialMs: 10, factor: 0.5, maxMs: 30_000 },
      }),
    ),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
})

test('invalid permissionPolicy action throws acpjs/config-invalid', () => {
  expect(
    captureError(() =>
      resolveHostOptions({ permissionPolicy: [{ action: 'deny' as never }] }),
    ),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
})

test.each([
  ['permissionPolicy is not an array', { permissionPolicy: 'allow' as never }],
  ['killTimeoutMs is zero', { killTimeoutMs: 0 }],
  ['killTimeoutMs is negative', { killTimeoutMs: -1 }],
  ['killTimeoutMs is not a number', { killTimeoutMs: '5s' as never }],
  ['storage adapter misses appendEvent', { storage: {} as never }],
  [
    'storage adapter misses loadEvents',
    {
      storage: {
        appendEvent: () => Promise.resolve(),
        listSessions: () => Promise.resolve([]),
      } as never,
    },
  ],
])('invalid host options throw acpjs/config-invalid: %s', (_name, raw) => {
  expect(captureError(() => resolveHostOptions(raw))).toMatchObject({
    code: 'acpjs/config-invalid',
  })
})

test.each([
  ['definition is null', null as never],
  ['definition is a string', 'agent' as never],
  ['env is a string', { id: 'a', command: 'node', env: 'PATH=1' as never }],
  ['env is null', { id: 'a', command: 'node', env: null as never }],
  ['cwd is a number', { id: 'a', command: 'node', cwd: 1 as never }],
])('invalid agent definition throws acpjs/config-invalid: %s', (_name, raw) => {
  expect(captureError(() => resolveAgentDefinition(raw))).toMatchObject({
    code: 'acpjs/config-invalid',
  })
})

test('agent definition applies defaults and absolutizes cwd', () => {
  const definition = resolveAgentDefinition({
    id: 'fixture',
    command: 'node',
    cwd: 'relative/dir',
  })

  expect(definition.args).toEqual([])
  expect(definition.cwd).toBe(resolve('relative/dir'))
  expect(isAbsolute(definition.cwd)).toBe(true)
  expect(Object.isFrozen(definition)).toBe(true)
})

test('agent definition cwd defaults to process cwd', () => {
  const definition = resolveAgentDefinition({ id: 'a', command: 'node' })

  expect(definition.cwd).toBe(process.cwd())
})

test('agent definition meta is validated as an object and shallow-copied frozen', () => {
  const meta = { vendor: 'x' }
  const definition = resolveAgentDefinition({
    id: 'a',
    command: 'node',
    meta,
  })

  expect(definition.meta).toEqual({ vendor: 'x' })
  expect(definition.meta).not.toBe(meta)
  expect(Object.isFrozen(definition.meta)).toBe(true)
  expect(
    captureError(() =>
      resolveAgentDefinition({ id: 'a', command: 'node', meta: 'm' as never }),
    ),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
})

test('invalid agent definition throws acpjs/config-invalid', () => {
  expect(
    captureError(() => resolveAgentDefinition({ id: '', command: 'node' })),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
  expect(
    captureError(() => resolveAgentDefinition({ id: 'a', command: '' })),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
  expect(
    captureError(() =>
      resolveAgentDefinition({ id: 'a', command: 'node', args: [1] as never }),
    ),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
  expect(
    captureError(() =>
      resolveAgentDefinition({
        id: 'a',
        command: 'node',
        env: { KEY: 1 } as never,
      }),
    ),
  ).toMatchObject({ code: 'acpjs/config-invalid' })
})
