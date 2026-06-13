import {
  goldenModelOption,
  goldenModes,
  goldenSessionId,
} from './golden-corpus'

import type { AcpEvent, SessionState } from './index'

const coveredEventTypes = {
  'user-message-chunk': true,
  'agent-message-chunk': true,
  'agent-thought-chunk': true,
  'tool-call': true,
  'tool-call-update': true,
  plan: true,
  'available-commands-update': true,
  'current-mode-update': true,
  'session-config-init': true,
  'config-options-update': true,
  'session-info-update': true,
  'usage-update': true,
  'prompt-finished': true,
  'session-status-change': true,
  'permission-request-created': true,
  'permission-request-resolved': true,
  'terminal-output': true,
  'unrecognized-update': true,
  'agent-status-change': true,
  'install-progress': true,
  'auth-required': true,
  diagnostic: true,
  'session-created': true,
  'session-closed': true,
} satisfies Record<AcpEvent['type'], true>

export const allEventTypes = Object.keys(
  coveredEventTypes,
) as AcpEvent['type'][]

export const goldenExpectedState: SessionState = {
  sessionId: goldenSessionId,
  messages: [
    {
      kind: 'user',
      messageId: 'u1',
      content: [{ type: 'text', text: 'hi' }],
      seq: 4,
    },
    {
      kind: 'thought',
      messageId: 't1',
      content: [{ type: 'text', text: 'thinking' }],
      seq: 5,
    },
    {
      kind: 'agent',
      messageId: 'm1',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ],
      seq: 6,
    },
  ],
  toolCalls: {
    'call-1': {
      toolCallId: 'call-1',
      title: 'Read file',
      kind: 'read',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'file body' } },
      ],
      locations: [{ path: '/tmp/a.txt' }],
      rawInput: { path: '/tmp/a.txt' },
      rawOutput: { ok: true },
      seq: 9,
    },
  },
  plan: {
    entries: [
      { content: 'Read the file', priority: 'high', status: 'in_progress' },
    ],
  },
  availableCommands: [
    { name: 'web', description: 'Search the web', input: { hint: 'query' } },
  ],
  modes: goldenModes('plan'),
  configOptions: [goldenModelOption('opus')],
  info: { title: 'Greeting session', updatedAt: '2026-06-10T08:00:00Z' },
  usage: { used: 1200, size: 200000, cost: { amount: 0.12, currency: 'USD' } },
  lastTurnUsage: {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedReadTokens: 5,
  },
  lastStopReason: 'end_turn',
  lastPromptError: null,
  connection: { status: 'active', resumed: true, authMethods: null },
  pendingPermissionRequests: [],
  terminals: {
    'term-1': {
      output: 'build ok\n',
      truncated: false,
      exit: { exitCode: 0 },
    },
  },
  resolvedPermissionRequests: [
    {
      requestId: 'req-1',
      toolCall: { toolCallId: 'call-1' },
      status: 'answered',
      outcome: { outcome: 'selected', optionId: 'allow' },
    },
  ],
}
