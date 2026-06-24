import { expect, test } from 'vitest'

import * as api from './index.ts'

test('the package export surface is sealed', () => {
  expect(Object.keys(api).sort()).toEqual([
    'AcpProvider',
    'shallowEqual',
    'useAcpClient',
    'useAgent',
    'useAgents',
    'useConnectionStatus',
    'useDiagnostics',
    'usePermissionRequests',
    'useSession',
    'useSessions',
  ])
})

test('hooks expose an optional selector but no required selector or raw subscription parameter', () => {
  // .length counts only required params; optional selector/isEqual do not bump
  // it. The arity table is the boundary that keeps the surface sealed: there is
  // deliberately no required selector/subscription param, no raw host-envelope send, no
  // raw protocol-notification subscribe, and no raw event/event-log handle.
  // Only a typed pure-projection selector is permitted.
  expect(api.useAcpClient.length).toBe(0)
  expect(api.useAgent.length).toBe(1)
  expect(api.useAgents.length).toBe(0)
  expect(api.useConnectionStatus.length).toBe(0)
  expect(api.useDiagnostics.length).toBe(0)
  expect(api.useSession.length).toBe(1)
  expect(api.useSessions.length).toBe(0)
  expect(api.usePermissionRequests.length).toBe(0)
  expect(api.AcpProvider.length).toBe(1)
})
