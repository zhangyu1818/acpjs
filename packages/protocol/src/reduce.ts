import {
  createInitialSessionState,
  type MessageKind,
  type ResolvedPermissionRequest,
  type SessionState,
} from './state'
import { truncateUtf8Tail } from './terminal-output'

import type {
  ContentBlock,
  ContentChunk,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'

import type { AcpjsEvent } from './events'

function isPlainText(
  block: ContentBlock,
): block is ContentBlock & { type: 'text' } {
  return (
    block.type === 'text' && block.annotations == null && block._meta == null
  )
}

function appendContent(
  content: ContentBlock[],
  incoming: ContentBlock,
): ContentBlock[] {
  const last = content[content.length - 1]
  if (last && isPlainText(last) && isPlainText(incoming)) {
    return [
      ...content.slice(0, -1),
      { type: 'text', text: last.text + incoming.text },
    ]
  }
  return [...content, incoming]
}

function appendChunk(
  state: SessionState,
  kind: MessageKind,
  payload: Omit<ContentChunk, '_meta'>,
  seq: number,
): SessionState {
  const messageId = payload.messageId ?? null
  const messages = state.messages
  let target = -1
  if (messageId !== null) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.kind === kind && message.messageId === messageId) {
        target = index
        break
      }
    }
  } else {
    const last = messages[messages.length - 1]
    if (last?.kind === kind && last.messageId === null) {
      target = messages.length - 1
    }
  }
  if (target === -1) {
    return {
      ...state,
      messages: [
        ...messages,
        { kind, messageId, content: [payload.content], seq },
      ],
    }
  }
  return {
    ...state,
    messages: messages.map((message, index) =>
      index === target
        ? {
            ...message,
            content: appendContent(message.content, payload.content),
          }
        : message,
    ),
  }
}

export function reduce(state: SessionState, event: AcpjsEvent): SessionState {
  switch (event.type) {
    case 'user-message-chunk': {
      return appendChunk(state, 'user', event.payload, event.seq)
    }
    case 'agent-message-chunk': {
      return appendChunk(state, 'agent', event.payload, event.seq)
    }
    case 'agent-thought-chunk': {
      return appendChunk(state, 'thought', event.payload, event.seq)
    }
    case 'tool-call': {
      const payload = event.payload
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [payload.toolCallId]: {
            toolCallId: payload.toolCallId,
            title: payload.title,
            kind: payload.kind ?? null,
            status: payload.status ?? null,
            content: payload.content ?? [],
            locations: payload.locations ?? [],
            rawInput: payload.rawInput,
            rawOutput: payload.rawOutput,
            ...(event.extensions ? { extensions: event.extensions } : {}),
            seq: event.seq,
          },
        },
      }
    }
    case 'tool-call-update': {
      const payload = event.payload
      const existing = state.toolCalls[payload.toolCallId]
      if (!existing) return state
      const next = { ...existing }
      if (payload.title != null) next.title = payload.title
      if (payload.kind != null) next.kind = payload.kind
      if (payload.status != null) next.status = payload.status
      if (payload.content != null) next.content = payload.content
      if (payload.locations != null) next.locations = payload.locations
      if ('rawInput' in payload) next.rawInput = payload.rawInput
      if ('rawOutput' in payload) next.rawOutput = payload.rawOutput
      if (event.extensions) next.extensions = event.extensions
      return {
        ...state,
        toolCalls: { ...state.toolCalls, [payload.toolCallId]: next },
      }
    }
    case 'plan': {
      return { ...state, plan: event.payload }
    }
    case 'available-commands-update': {
      return { ...state, availableCommands: event.payload.availableCommands }
    }
    case 'session-config-init': {
      return {
        ...state,
        modes: event.payload.modes ?? state.modes,
        configOptions: event.payload.configOptions ?? state.configOptions,
      }
    }
    case 'current-mode-update': {
      const currentModeId = event.payload.currentModeId
      return {
        ...state,
        modes: state.modes
          ? { ...state.modes, currentModeId }
          : { currentModeId, availableModes: [] },
      }
    }
    case 'config-options-update': {
      return { ...state, configOptions: event.payload.configOptions }
    }
    case 'session-info-update': {
      const payload = event.payload
      return {
        ...state,
        info: {
          title: payload.title === undefined ? state.info.title : payload.title,
          updatedAt:
            payload.updatedAt === undefined
              ? state.info.updatedAt
              : payload.updatedAt,
        },
      }
    }
    case 'usage-update': {
      const payload = event.payload
      return {
        ...state,
        usage: {
          used: payload.used,
          size: payload.size,
          cost: payload.cost ?? null,
        },
      }
    }
    case 'prompt-finished': {
      const payload = event.payload
      return {
        ...state,
        lastStopReason: payload.stopReason,
        lastTurnUsage: payload.usage ?? null,
      }
    }
    case 'session-status-change': {
      const payload = event.payload
      const terminalReset =
        payload.status === 'disconnected' ||
        payload.status === 'closed' ||
        payload.status === 'deleted'
      return {
        ...state,
        connection: {
          status: payload.status,
          resumed:
            payload.resumed ??
            (terminalReset ? false : state.connection.resumed),
        },
      }
    }
    case 'session-reset': {
      return createInitialSessionState(event.sessionId)
    }
    case 'permission-request-created': {
      const payload = event.payload
      return {
        ...state,
        pendingPermissionRequests: [
          ...state.pendingPermissionRequests,
          {
            requestId: payload.requestId,
            toolCall: payload.toolCall,
            options: payload.options,
          },
        ],
      }
    }
    case 'terminal-output': {
      const { terminalId, delta, truncated, exit } = event.payload
      const prev = state.terminals[terminalId]
      const LIMIT = 1 << 20
      const trimmed = truncateUtf8Tail(
        (prev?.output ?? '') + (delta ?? ''),
        LIMIT,
      )
      const output = trimmed.output
      const isTruncated =
        (prev?.truncated ?? false) || (truncated ?? false) || trimmed.truncated
      const nextExit = exit ?? prev?.exit
      return {
        ...state,
        terminals: {
          ...state.terminals,
          [terminalId]: {
            output,
            truncated: isTruncated,
            ...(nextExit === undefined ? {} : { exit: nextExit }),
          },
        },
      }
    }
    case 'permission-request-resolved': {
      const { requestId, status, outcome } = event.payload
      const pending = state.pendingPermissionRequests.find(
        (request) => request.requestId === requestId,
      )
      const entry: ResolvedPermissionRequest = {
        requestId,
        toolCall: pending
          ? pending.toolCall
          : ({ toolCallId: requestId } as ToolCallUpdate),
        status,
        ...(outcome === undefined ? {} : { outcome }),
      }
      const MAX = 100
      const list = [...state.resolvedPermissionRequests, entry]
      return {
        ...state,
        pendingPermissionRequests: state.pendingPermissionRequests.filter(
          (request) => request.requestId !== requestId,
        ),
        resolvedPermissionRequests:
          list.length > MAX ? list.slice(list.length - MAX) : list,
      }
    }
    case 'unrecognized-update':
    case 'diagnostic':
    case 'agent-updated':
    case 'agent-removed':
    case 'install-progress':
    case 'session-updated':
    case 'permission-updated': {
      return state
    }
    default: {
      return event satisfies never
    }
  }
}
