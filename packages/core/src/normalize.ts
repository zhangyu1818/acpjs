import type { AcpjsEventExtensions, AcpjsSessionEvent } from '@acpjs/protocol'
import type { SessionUpdate } from '@agentclientprotocol/sdk'

export interface NormalizedUpdate {
  type: AcpjsSessionEvent['type']
  payload: Record<string, unknown>
  extensions?: AcpjsEventExtensions
}

interface VariantSpec {
  type: AcpjsSessionEvent['type']
  keys: readonly string[]
  keepNullKeys?: readonly string[]
}

const VARIANTS: Record<string, VariantSpec> = {
  user_message_chunk: {
    type: 'user-message-chunk',
    keys: ['content', 'messageId'],
  },
  agent_message_chunk: {
    type: 'agent-message-chunk',
    keys: ['content', 'messageId'],
  },
  agent_thought_chunk: {
    type: 'agent-thought-chunk',
    keys: ['content', 'messageId'],
  },
  tool_call: {
    type: 'tool-call',
    keys: [
      'toolCallId',
      'title',
      'kind',
      'status',
      'content',
      'locations',
      'rawInput',
      'rawOutput',
    ],
    keepNullKeys: ['rawInput', 'rawOutput'],
  },
  tool_call_update: {
    type: 'tool-call-update',
    keys: [
      'toolCallId',
      'title',
      'kind',
      'status',
      'content',
      'locations',
      'rawInput',
      'rawOutput',
    ],
    keepNullKeys: ['rawInput', 'rawOutput'],
  },
  plan: { type: 'plan', keys: ['entries'] },
  available_commands_update: {
    type: 'available-commands-update',
    keys: ['availableCommands'],
  },
  current_mode_update: {
    type: 'current-mode-update',
    keys: ['currentModeId'],
  },
  config_option_update: {
    type: 'config-options-update',
    keys: ['configOptions'],
  },
  session_info_update: {
    type: 'session-info-update',
    keys: ['title', 'updatedAt'],
    keepNullKeys: ['title', 'updatedAt'],
  },
  usage_update: { type: 'usage-update', keys: ['used', 'size', 'cost'] },
}

export function normalizeSessionUpdate(
  update: SessionUpdate,
): NormalizedUpdate {
  const record = update as unknown as Record<string, unknown>
  const variant = VARIANTS[String(record['sessionUpdate'])]
  if (!variant) {
    return { type: 'unrecognized-update', payload: { ...record } }
  }
  const payload: Record<string, unknown> = {}
  const extensions: AcpjsEventExtensions = {}
  let hasExtensions = false
  for (const [key, value] of Object.entries(record)) {
    if (key === 'sessionUpdate' || value === undefined) continue
    if (key === '_meta') {
      if (value !== null) {
        extensions['_meta'] = value
        hasExtensions = true
      }
      continue
    }
    if (variant.keys.includes(key)) {
      if (value === null && !variant.keepNullKeys?.includes(key)) continue
      payload[key] = value
    } else {
      extensions[key] = value
      hasExtensions = true
    }
  }
  return {
    type: variant.type,
    payload,
    ...(hasExtensions ? { extensions } : {}),
  }
}
