import { AcpClientError, toClientError } from './errors.ts'

import type { Transport } from '@acpjs/protocol'

import type { RpcCall } from './internal.ts'

export function createRpcCaller(options: {
  ensureOpen: () => void
  connected: () => Promise<void>
  request: Transport['request']
}): RpcCall {
  let rpcCounter = 0
  return async function call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    options.ensureOpen()
    try {
      await options.connected()
    } catch (error) {
      throw toClientError(error)
    }
    options.ensureOpen()
    rpcCounter += 1
    let response
    try {
      response = await options.request({
        id: `rpc-${rpcCounter}`,
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
