import type {
  SessionConfigOption,
  SessionModeState,
} from '@agentclientprotocol/sdk'

import type {
  AcpEvent,
  AcpEventExtensions,
  AcpHostEvent,
  AcpSessionEvent,
} from './index'

const base = 1718000000000

export const goldenSessionId = 'sess-1'

export const goldenAgentId = 'agent-1'

type SessionPayloadOf<T extends AcpSessionEvent['type']> = Extract<
  AcpSessionEvent,
  { type: T }
>['payload']

type HostPayloadOf<T extends AcpHostEvent['type']> = Extract<
  AcpHostEvent,
  { type: T }
>['payload']

function session<T extends AcpSessionEvent['type']>(
  seq: number,
  type: T,
  payload: SessionPayloadOf<T>,
  extensions?: AcpEventExtensions,
): AcpEvent {
  const event = {
    sessionId: goldenSessionId,
    seq,
    ts: base + seq,
    type,
    payload,
  }
  return (extensions ? { ...event, extensions } : event) as AcpEvent
}

function host<T extends AcpHostEvent['type']>(
  seq: number,
  type: T,
  payload: HostPayloadOf<T>,
): AcpEvent {
  return {
    agentId: goldenAgentId,
    seq,
    ts: base + 100 + seq,
    type,
    payload,
  } as AcpEvent
}

export function goldenModelOption(currentValue: string): SessionConfigOption {
  return {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue,
    options: [
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'opus', name: 'Opus' },
    ],
  }
}

export function goldenModes(currentModeId: string): SessionModeState {
  return {
    currentModeId,
    availableModes: [
      { id: 'normal', name: 'Normal' },
      { id: 'plan', name: 'Plan' },
    ],
  }
}

export const goldenCorpus: AcpEvent[] = [
  session(0, 'session-reset', { reason: 'load' }),
  session(1, 'session-config-init', {
    modes: goldenModes('normal'),
    configOptions: [goldenModelOption('sonnet')],
  }),
  session(2, 'session-status-change', { status: 'active' }),
  session(3, 'session-status-change', { status: 'prompting' }),
  session(
    4,
    'user-message-chunk',
    { content: { type: 'text', text: 'hi' }, messageId: 'u1' },
    { _meta: { vendor: { trace: 'abc' } } },
  ),
  session(5, 'agent-thought-chunk', {
    content: { type: 'text', text: 'thinking' },
    messageId: 't1',
  }),
  session(6, 'agent-message-chunk', {
    content: { type: 'text', text: 'Hello' },
    messageId: 'm1',
  }),
  session(7, 'agent-message-chunk', {
    content: { type: 'text', text: ' world' },
    messageId: 'm1',
  }),
  session(8, 'plan', {
    entries: [
      { content: 'Read the file', priority: 'high', status: 'in_progress' },
    ],
  }),
  session(9, 'tool-call', {
    toolCallId: 'call-1',
    title: 'Read file',
    kind: 'read',
    status: 'pending',
    locations: [{ path: '/tmp/a.txt' }],
    rawInput: { path: '/tmp/a.txt' },
  }),
  session(10, 'permission-request-created', {
    requestId: 'req-1',
    toolCall: { toolCallId: 'call-1' },
    options: [
      { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
      { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
    ],
  }),
  session(11, 'permission-request-resolved', {
    requestId: 'req-1',
    status: 'answered',
    outcome: { outcome: 'selected', optionId: 'allow' },
  }),
  session(12, 'tool-call-update', {
    toolCallId: 'call-1',
    status: 'in_progress',
    content: [
      { type: 'content', content: { type: 'text', text: 'file body' } },
    ],
  }),
  session(13, 'tool-call-update', {
    toolCallId: 'call-1',
    status: 'completed',
    rawOutput: { ok: true },
  }),
  session(14, 'available-commands-update', {
    availableCommands: [
      { name: 'web', description: 'Search the web', input: { hint: 'query' } },
    ],
  }),
  session(15, 'current-mode-update', { currentModeId: 'plan' }),
  session(16, 'config-options-update', {
    configOptions: [goldenModelOption('opus')],
  }),
  session(17, 'session-info-update', {
    title: 'Greeting session',
    updatedAt: '2026-06-10T08:00:00Z',
  }),
  session(18, 'usage-update', {
    used: 1200,
    size: 200000,
    cost: { amount: 0.12, currency: 'USD' },
  }),
  session(19, 'unrecognized-update', {
    sessionUpdate: 'plan_update',
    plan: { type: 'markdown', id: 'p1', content: '# plan' },
  }),
  session(20, 'prompt-finished', {
    stopReason: 'end_turn',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedReadTokens: 5,
    },
  }),
  session(21, 'session-status-change', { status: 'active' }),
  session(22, 'session-status-change', { status: 'disconnected' }),
  session(23, 'session-status-change', { status: 'resuming' }),
  session(24, 'session-status-change', { status: 'active', resumed: true }),
  session(25, 'terminal-output', {
    terminalId: 'term-1',
    delta: 'build ok\n',
  }),
  session(26, 'terminal-output', {
    terminalId: 'term-1',
    exit: { exitCode: 0 },
  }),
  host(1, 'agent-updated', {
    agentId: goldenAgentId,
    status: 'spawning',
    restartCount: 0,
  }),
  host(2, 'agent-updated', {
    agentId: goldenAgentId,
    status: 'ready',
    restartCount: 0,
  }),
  host(3, 'install-progress', {
    stage: 'downloading',
    version: '1.2.3',
    platform: 'darwin-aarch64',
    downloadedBytes: 1024,
    totalBytes: 4096,
  }),
  host(4, 'diagnostic', {
    level: 'info',
    code: 'agent.spawn',
    message: 'agent spawned',
  }),
  host(5, 'session-updated', {
    sessionId: goldenSessionId,
    agentId: goldenAgentId,
    cwd: '/workspace',
    additionalDirectories: [],
    status: 'active',
  }),
  host(6, 'permission-updated', {
    requestId: 'req-2',
    sessionId: goldenSessionId,
    agentId: goldenAgentId,
    status: 'pending',
    toolCall: { toolCallId: 'call-2' },
    options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
  }),
]
