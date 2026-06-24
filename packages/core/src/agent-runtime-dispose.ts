import type { EventBus } from './event-bus.ts'
import type { AgentHandle } from './internal.ts'
import type { ResolvedHostOptions } from './options.ts'

interface DisposeDeps {
  options: ResolvedHostOptions
  bus: EventBus
  onAgentDown: (handle: AgentHandle) => void
}

export async function disposeAgentProcess(
  handle: AgentHandle,
  deps: DisposeDeps,
): Promise<void> {
  handle.disposed = true
  if (handle.restartTimer) {
    clearTimeout(handle.restartTimer)
    handle.restartTimer = undefined
  }
  const proc = handle.proc
  if (!proc) {
    if (handle.status !== 'exited') {
      deps.onAgentDown(handle)
      deps.bus.setAgentStatus(handle, 'exited', 'disposed')
    }
    return
  }
  const exited = new Promise<void>((resolvePromise) => {
    proc.once('exit', () => resolvePromise())
    if (proc.exitCode !== null || proc.signalCode !== null) resolvePromise()
  })
  proc.stdin?.end()
  const timedOut = await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(
      () => resolvePromise(true),
      deps.options.killTimeoutMs,
    )
    void exited.then(() => {
      clearTimeout(timer)
      resolvePromise(false)
    })
  })
  if (timedOut) {
    deps.bus.diagnostic('warn', 'agent/kill', {
      message: 'kill timeout exceeded, sending SIGKILL',
      agentId: handle.agentId,
    })
    proc.kill('SIGKILL')
    await Promise.race([
      exited,
      new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, deps.options.killTimeoutMs),
      ),
    ])
  }
}
