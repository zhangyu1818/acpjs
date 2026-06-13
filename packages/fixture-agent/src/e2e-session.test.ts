import {
  PROTOCOL_VERSION,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { expect, test } from 'vitest'

import { chunk, cwd, spawnFixture } from './e2e-harness.ts'

test('initialize replies with scenario protocolVersion, agentCapabilities and authMethods', async () => {
  const { conn } = await spawnFixture(
    {
      initialize: {
        protocolVersion: 0,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { list: {}, close: {} },
          mcpCapabilities: { http: true },
          auth: { logout: {} },
        },
        authMethods: [
          { id: 'oauth', name: 'Log in', description: 'browser login' },
        ],
      },
    },
    {},
    { useEnv: true },
  )

  const result = await conn.initialize({ protocolVersion: PROTOCOL_VERSION })

  expect(result.protocolVersion).toBe(0)
  expect(result.agentCapabilities).toEqual({
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    sessionCapabilities: { list: {}, close: {} },
    mcpCapabilities: { http: true },
    auth: { logout: {} },
  })
  expect(result.authMethods).toEqual([
    { id: 'oauth', name: 'Log in', description: 'browser login' },
  ])
})

test('session/new replies with scripted sessionId, modes and configOptions', async () => {
  const modes = {
    currentModeId: 'code',
    availableModes: [
      { id: 'code', name: 'Code' },
      { id: 'plan', name: 'Plan' },
    ],
  }
  const configOptions = [
    {
      type: 'select' as const,
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'fast',
      options: [{ value: 'fast', name: 'Fast' }],
    },
  ]
  const { conn } = await spawnFixture({
    session: { sessionId: 'sess-1', modes, configOptions },
  })
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION })

  const result = await conn.newSession({ cwd, mcpServers: [] })

  expect(result).toEqual({ sessionId: 'sess-1', modes, configOptions })
})

test('session/new rejects with -32000 until authenticate, then succeeds', async () => {
  const { conn } = await spawnFixture({
    initialize: { authMethods: [{ id: 'login', name: 'Login' }] },
    session: { sessionId: 'sess-auth', authRequired: true },
  })
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION })

  await expect(conn.newSession({ cwd, mcpServers: [] })).rejects.toMatchObject({
    code: -32000,
  })

  await conn.authenticate({ methodId: 'login' })

  await expect(conn.newSession({ cwd, mcpServers: [] })).resolves.toEqual({
    sessionId: 'sess-auth',
  })
})

test('loadSession replays scripted history updates before resolving with modes and configOptions', async () => {
  const replay: SessionNotification['update'][] = [
    {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'earlier' },
    },
    chunk('history'),
    { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
  ]
  const modes = {
    currentModeId: 'plan',
    availableModes: [{ id: 'plan', name: 'Plan' }],
  }
  const { conn, updates } = await spawnFixture({
    initialize: { agentCapabilities: { loadSession: true } },
    loadSession: { replay, modes },
  })
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION })

  const result = await conn.loadSession({
    sessionId: 'sess-old',
    cwd,
    mcpServers: [],
  })

  expect(result).toEqual({ modes })
  expect(updates).toEqual(
    replay.map((update) => ({ sessionId: 'sess-old', update })),
  )
})

test('capability-gated methods reject with -32601 when undeclared and answer when declared', async () => {
  const bare = await spawnFixture({ loadSession: { replay: [chunk('x')] } })
  await bare.conn.initialize({ protocolVersion: PROTOCOL_VERSION })

  await expect(bare.conn.listSessions({})).rejects.toMatchObject({
    code: -32601,
  })
  await expect(
    bare.conn.loadSession({ sessionId: 's', cwd, mcpServers: [] }),
  ).rejects.toMatchObject({ code: -32601 })
  await expect(
    bare.conn.resumeSession({ sessionId: 's', cwd, mcpServers: [] }),
  ).rejects.toMatchObject({ code: -32601 })
  await expect(
    bare.conn.closeSession({ sessionId: 's' }),
  ).rejects.toMatchObject({ code: -32601 })
  await expect(
    bare.conn.deleteSession({ sessionId: 's' }),
  ).rejects.toMatchObject({ code: -32601 })
  await expect(bare.conn.logout({})).rejects.toMatchObject({ code: -32601 })
  await expect(
    bare.conn.setSessionMode({ sessionId: 's', modeId: 'code' }),
  ).rejects.toMatchObject({ code: -32601 })
  await expect(
    bare.conn.setSessionConfigOption({
      sessionId: 's',
      configId: 'verbose',
      type: 'boolean',
      value: true,
    }),
  ).rejects.toMatchObject({ code: -32601 })

  const sessions = [{ sessionId: 'sess-1', cwd, title: 'First' }]
  const enabled = await spawnFixture({
    initialize: { agentCapabilities: { sessionCapabilities: { list: {} } } },
    listSessions: { sessions, nextCursor: 'cursor-2' },
  })
  await enabled.conn.initialize({ protocolVersion: PROTOCOL_VERSION })

  await expect(enabled.conn.listSessions({})).resolves.toEqual({
    sessions,
    nextCursor: 'cursor-2',
  })
})

test('set_mode and set_config_option are gated open by modes and configOptions provided only via loadSession', async () => {
  const modes = {
    currentModeId: 'plan',
    availableModes: [{ id: 'plan', name: 'Plan' }],
  }
  const configOptions = [
    {
      type: 'boolean' as const,
      id: 'verbose',
      name: 'Verbose',
      currentValue: false,
    },
  ]
  const { conn } = await spawnFixture({
    initialize: { agentCapabilities: { loadSession: true } },
    loadSession: { modes, configOptions },
  })
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION })
  await conn.loadSession({ sessionId: 'sess-old', cwd, mcpServers: [] })

  await expect(
    conn.setSessionMode({ sessionId: 'sess-old', modeId: 'plan' }),
  ).resolves.toEqual({})
  await expect(
    conn.setSessionConfigOption({
      sessionId: 'sess-old',
      configId: 'verbose',
      type: 'boolean',
      value: true,
    }),
  ).resolves.toEqual({ configOptions })
})

test('declared session lifecycle methods answer with scripted payloads', async () => {
  const modes = {
    currentModeId: 'code',
    availableModes: [{ id: 'code', name: 'Code' }],
  }
  const configOptions = [
    {
      type: 'boolean' as const,
      id: 'verbose',
      name: 'Verbose',
      currentValue: false,
    },
  ]
  const updatedOptions = [
    {
      type: 'boolean' as const,
      id: 'verbose',
      name: 'Verbose',
      currentValue: true,
    },
  ]
  const { conn } = await spawnFixture({
    initialize: {
      agentCapabilities: {
        sessionCapabilities: { resume: {}, close: {}, delete: {} },
        auth: { logout: {} },
      },
    },
    session: { sessionId: 'sess-1', modes, configOptions },
    resumeSession: { modes },
    setConfigOption: { configOptions: updatedOptions },
  })
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION })
  await conn.newSession({ cwd, mcpServers: [] })

  await expect(
    conn.resumeSession({ sessionId: 'sess-1', cwd, mcpServers: [] }),
  ).resolves.toEqual({ modes })
  await expect(
    conn.setSessionMode({ sessionId: 'sess-1', modeId: 'code' }),
  ).resolves.toEqual({})
  await expect(
    conn.setSessionConfigOption({
      sessionId: 'sess-1',
      configId: 'verbose',
      type: 'boolean',
      value: true,
    }),
  ).resolves.toEqual({ configOptions: updatedOptions })
  await expect(conn.closeSession({ sessionId: 'sess-1' })).resolves.toEqual({})
  await expect(conn.deleteSession({ sessionId: 'sess-1' })).resolves.toEqual({})
  await expect(conn.logout({})).resolves.toEqual({})
})
