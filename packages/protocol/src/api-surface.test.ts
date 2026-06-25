import { expect, test } from 'vitest'

import * as api from './index.ts'

test('the package export surface is sealed', () => {
  expect(Object.keys(api).sort()).toEqual([
    'ACPJS_ERROR_CODES',
    'ACPJS_HOST_METHODS',
    'createInitialSessionState',
    'isAcpjsErrorCode',
    'reduce',
    'truncateUtf8Tail',
  ])
})
