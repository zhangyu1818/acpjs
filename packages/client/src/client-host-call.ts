import { AcpClientError, toClientError } from './errors.ts'

import type { AcpjsHostMethod, HostClientTransport } from '@acpjs/protocol'

import type { HostCall } from './internal.ts'

export function createHostCaller(options: {
  ensureOpen: () => void
  connected: () => Promise<void>
  request: HostClientTransport['request']
}): HostCall {
  let requestCounter = 0
  return async function call(
    method: AcpjsHostMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    options.ensureOpen()
    try {
      await options.connected()
    } catch (error) {
      throw toClientError(error)
    }
    options.ensureOpen()
    requestCounter += 1
    let response
    try {
      response = await options.request({
        id: `host-${requestCounter}`,
        method,
        params,
      })
    } catch (error) {
      throw toClientError(error)
    }
    if (!response.ok) throw new AcpClientError(response.error)
    return response.result
  }
}
