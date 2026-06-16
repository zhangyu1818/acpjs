export type SessionStatus =
  | 'creating'
  | 'active'
  | 'prompting'
  | 'disconnected'
  | 'resuming'
  | 'closed'
  | 'deleted'

export type AgentStatus =
  | 'spawning'
  | 'initializing'
  | 'ready'
  | 'exited'
  | 'restarting'

export type AgentExitReason =
  | 'spawn-failed'
  | 'initialize-failed'
  | 'crashed'
  | 'disposed'
  | 'restart-exhausted'
