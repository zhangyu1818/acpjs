import {
  ACPJS_HOST_RPC_METHODS,
  type ContentBlock,
  type PromptFinishedPayload,
  type SessionConfigOption,
} from '@acpjs/protocol'

import type { RpcCall } from './internal.ts'
import type { SessionStore, StateListener } from './store.ts'
import type { AcpSession, SessionConfigValue } from './types.ts'

export function createSessionHandle(
  call: RpcCall,
  store: SessionStore,
  onEvent: AcpSession['onEvent'],
): AcpSession {
  const sessionId = store.sessionId
  return Object.freeze({
    sessionId,
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener: StateListener) => store.subscribe(listener),
    onEvent,
    async prompt(blocks: ContentBlock[]): Promise<PromptFinishedPayload> {
      return (await call(ACPJS_HOST_RPC_METHODS.prompt, {
        sessionId,
        prompt: blocks,
      })) as PromptFinishedPayload
    },
    async cancel(): Promise<void> {
      await call(ACPJS_HOST_RPC_METHODS.cancel, { sessionId })
    },
    async close(): Promise<void> {
      await call(ACPJS_HOST_RPC_METHODS.closeSession, { sessionId })
    },
    async setMode(modeId: string): Promise<void> {
      await call(ACPJS_HOST_RPC_METHODS.setMode, { sessionId, modeId })
    },
    async setConfigOption(
      configId: string,
      value: SessionConfigValue,
    ): Promise<SessionConfigOption[]> {
      return (await call(ACPJS_HOST_RPC_METHODS.setConfigOption, {
        sessionId,
        configId,
        value,
      })) as SessionConfigOption[]
    },
  })
}
