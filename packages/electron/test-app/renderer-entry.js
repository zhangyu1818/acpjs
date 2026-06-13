import { createAcpClient } from '@acpjs/client'
import { createInitialSessionState, reduce } from '@acpjs/protocol'

import { electronTransport } from '../dist/renderer.js'

const params = new URLSearchParams(location.search)
const role = params.get('role')
const trace = []

function mark(step) {
  trace.push(step)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

function waitSignal(harness, name, timeoutMs = 30_000) {
  return Promise.race([
    harness.wait(name),
    sleep(timeoutMs).then(() => {
      throw new Error(`signal ${name} timed out`)
    }),
  ])
}

async function runA(harness) {
  const cfg = await harness.config()
  const transport = electronTransport()
  const client = createAcpClient({ transport })
  let captured = null
  client.permissions.subscribe((snapshot) => {
    if (captured === null && snapshot.length !== 0) captured = snapshot[0]
  })
  const agent = await client.agents.spawn({
    id: 'fixture',
    command: cfg.nodeBin,
    args: [cfg.cliPath, '--scenario', cfg.scenarioPath],
  })
  const session = await agent.sessions.create({ cwd: cfg.cwd })
  const sessionId = session.getSnapshot().sessionId
  mark(`session:${sessionId}`)
  harness.signal('session', { sessionId })
  await waitSignal(harness, 'b-ready')
  mark('b-ready-received')
  const promptPromise = session.prompt([{ type: 'text', text: 'go' }])
  await waitFor(() => captured !== null)
  mark('a-got-permission')
  harness.signal('a-got-permission')
  await waitSignal(harness, 'b-answered')
  mark('b-answered-received')
  let secondRespond
  try {
    await captured.respond({
      outcome: 'selected',
      optionId: 'allow-once',
    })
    secondRespond = { ok: true }
  } catch (error) {
    secondRespond = { code: error.code, message: error.message }
  }
  const first = await promptPromise
  await waitFor(() => session.getSnapshot().lastStopReason === 'end_turn')
  const state = session.getSnapshot()
  await waitSignal(harness, 'b-done')
  const second = await session.prompt([{ type: 'text', text: 'again' }])
  return {
    sessionId,
    firstStop: first.stopReason,
    secondStop: second.stopReason,
    secondRespond,
    state,
    bridgeKeys: Object.keys(window.acp),
    bridgeIpcRendererAbsent: window.acp.ipcRenderer === undefined,
  }
}

async function settledDestroyedListeners(harness) {
  let last = await harness.destroyedListeners()
  let stable = 0
  const deadline = Date.now() + 15_000
  while (stable < 3 && Date.now() < deadline) {
    await sleep(50)
    const next = await harness.destroyedListeners()
    if (next === last) {
      stable += 1
    } else {
      stable = 0
      last = next
    }
  }
  return last
}

async function runB(harness) {
  const eventsTransport = electronTransport()
  await eventsTransport.connect({
    onInboundRequest(request) {
      mark(`raw-inbound:${JSON.stringify(request)}`)
    },
    onLifecycle() {},
  })
  mark('events-transport-connected')
  let unknownSubEvents = 0
  eventsTransport.subscribe(
    { sessionId: 'no-such-session', fromSeq: 0 },
    () => {
      unknownSubEvents += 1
    },
  )
  const client = createAcpClient({ transport: electronTransport() })
  const fromA = await harness.wait('session')
  const sessionId = fromA.sessionId
  mark(`session:${sessionId}`)
  let state = createInitialSessionState(sessionId)
  let eventCount = 0
  eventsTransport.subscribe({ sessionId, fromSeq: 0 }, (event) => {
    eventCount += 1
    state = reduce(state, event)
  })
  let answered = false
  let respondResult = null
  client.permissions.subscribe((snapshot) => {
    const request = snapshot.find((entry) => entry.sessionId === sessionId)
    if (answered || request === undefined) return
    mark(`permission:${request.requestId}:${request.sessionId}`)
    answered = true
    waitSignal(harness, 'a-got-permission')
      .then(() =>
        request.respond({ outcome: 'selected', optionId: 'allow-once' }),
      )
      .then(() => {
        respondResult = { ok: true }
      })
      .catch((error) => {
        respondResult = { code: error.code }
      })
      .then(() => {
        mark('responded')
        harness.signal('b-answered', respondResult)
      })
  })
  harness.signal('b-ready')
  mark('b-ready-signalled')
  await waitFor(
    () =>
      state.lastStopReason === 'end_turn' &&
      state.pendingPermissionRequests.length === 0 &&
      respondResult !== null,
  )
  const finalState = state
  await client.dispose()
  await eventsTransport.close()
  const destroyedFloor = await settledDestroyedListeners(harness)
  for (let i = 0; i < 12; i += 1) {
    const cycled = electronTransport()
    await cycled.connect({ onInboundRequest() {}, onLifecycle() {} })
    await cycled.close()
  }
  const deadline = Date.now() + 15_000
  let leakedDestroyedListeners =
    (await harness.destroyedListeners()) - destroyedFloor
  while (leakedDestroyedListeners > 0 && Date.now() < deadline) {
    await sleep(25)
    leakedDestroyedListeners =
      (await harness.destroyedListeners()) - destroyedFloor
  }
  harness.signal('b-done')
  return {
    sessionId,
    respondResult,
    eventCount,
    state: finalState,
    unknownSubEvents,
    leakedDestroyedListeners,
  }
}

async function runC() {
  const transport = electronTransport()
  try {
    await transport.connect({ onInboundRequest() {}, onLifecycle() {} })
    return { handshakeFailed: false }
  } catch (error) {
    return { handshakeFailed: true, message: String(error.message || error) }
  }
}

async function main() {
  await waitFor(
    () => window.acp !== undefined && window.harness !== undefined,
    20_000,
  )
  const harness = window.harness
  try {
    let data
    if (role === 'a') data = await runA(harness)
    else if (role === 'b') data = await runB(harness)
    else data = await runC()
    harness.report(role, data)
  } catch (error) {
    harness.report(role, {
      error: String((error && error.stack) || error),
      trace,
    })
  }
}

void main()
