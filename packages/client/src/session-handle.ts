import {
  ACPJS_HOST_METHODS,
  type ContentBlock,
  type PromptFinishedPayload,
  type SessionConfigOption,
} from '@acpjs/protocol'

import type { HostCall } from './internal.ts'
import type { SessionStore, StateListener } from './store.ts'
import type { AcpSession, SessionConfigValue } from './types.ts'

export function createSessionHandle(
  call: HostCall,
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
      return (await call(ACPJS_HOST_METHODS.prompt, {
        sessionId,
        prompt: blocks,
      })) as PromptFinishedPayload
    },
    async cancel(): Promise<void> {
      await call(ACPJS_HOST_METHODS.cancel, { sessionId })
    },
    async close(): Promise<void> {
      await call(ACPJS_HOST_METHODS.closeSession, { sessionId })
    },
    async setMode(modeId: string): Promise<void> {
      await call(ACPJS_HOST_METHODS.setMode, { sessionId, modeId })
    },
    async setConfigOption(
      configId: string,
      value: SessionConfigValue,
    ): Promise<SessionConfigOption[]> {
      return (await call(ACPJS_HOST_METHODS.setConfigOption, {
        sessionId,
        configId,
        value,
      })) as SessionConfigOption[]
    },
  })
}
