// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, deferred } from '../../../support/testHarness'

const read = vi.hoisted(() => vi.fn())
const bus = vi.hoisted(() => ({ subscribed: null as null | (() => void), off: vi.fn() }))
const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/lib/storedAgentTurnFailures', () => ({ readStoredAgentTurnFailures: read }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => log }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (_user: string, _event: string, _listener: unknown, options: { onSubscribed: () => void }) => {
    bus.subscribed = options.onSubscribed
    queueMicrotask(options.onSubscribed)
    return {}
  },
  unsubscribePrivateUserEventBus: bus.off,
}))
import { useStoredAgentTurnFailure } from '../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure'

const empty = { failures: [], recovered: [] }
const failure = { agentUserId: 'agent', commandId: 'cmd', revision: 'one', at: 1, reason: 'weeklyQuota' }
function Probe({ chatId = 'chat' }: { chatId?: string }) {
  const state = useStoredAgentTurnFailure({ chatId, threadRootId: null }, ['agent'])
  return <div><span data-failure>{state.failure?.commandId}</span></div>
}
let ui: ReturnType<typeof createReactHarness>
const current = () => ui.container.querySelector('[data-failure]')?.textContent
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const reconnect = () => act(async () => bus.subscribed?.())
beforeEach(() => {
  vi.useFakeTimers()
  ui = createReactHarness()
  read.mockReset().mockResolvedValue(empty)
  bus.off.mockClear()
  log.error.mockClear()
  window.localStorage.clear()
})
afterEach(() => { ui.cleanup(); vi.useRealTimers() })

describe('automatic reply-status read recovery (#1896)', () => {
  it('retries a slow failed read without user action', async () => {
    const slow = deferred<typeof empty>()
    read.mockReturnValueOnce(slow.promise)
    await ui.render(createNode(Probe, {}))
    await advance(63_000)
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => slow.reject(new Error('statement timeout')))
    expect(log.error).toHaveBeenCalledWith({ scope: { chatId: 'chat', threadRootId: null }, error: 'Error: statement timeout' }, 'could not read agent reply outcome')
    await advance(999)
    expect(read).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('backs off repeated failures to 30 seconds and continues retrying', async () => {
    read.mockRejectedValue(new Error('offline'))
    await ui.render(createNode(Probe, {}))
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const [index, delay] of delays.entries()) {
      await advance(delay - 1)
      expect(read).toHaveBeenCalledTimes(index + 1)
      await advance(1)
      expect(read).toHaveBeenCalledTimes(index + 2)
    }
    expect(log.error).toHaveBeenCalledTimes(delays.length + 1)
  })

  it('starts again at one second after a successful recovery', async () => {
    read.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    await ui.render(createNode(Probe, {}))
    await advance(1_000)
    await advance(2_000)
    read.mockRejectedValueOnce(new Error('offline again'))
    await reconnect()
    await advance(999)
    expect(read).toHaveBeenCalledTimes(4)
    await advance(1)
    expect(read).toHaveBeenCalledTimes(5)
  })

  it('keeps verified turn failures while reads fail, then applies the recovered result', async () => {
    read.mockResolvedValueOnce({ failures: [failure], recovered: [] }).mockRejectedValueOnce(new Error('offline'))
    await ui.render(createNode(Probe, {}))
    expect(current()).toBe('cmd')
    await reconnect()
    expect(current()).toBe('cmd')
    await advance(1_000)
    expect(current()).toBe('')
  })

  it('an event refresh replaces a scheduled retry instead of leaving an extra read behind', async () => {
    read.mockRejectedValueOnce(new Error('offline'))
    await ui.render(createNode(Probe, {}))
    await advance(500)
    await reconnect()
    expect(read).toHaveBeenCalledTimes(2)
    await advance(30_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not let a late failed request overwrite a newer success or schedule a retry', async () => {
    const old = deferred<typeof empty>()
    read.mockReturnValueOnce(old.promise)
    await ui.render(createNode(Probe, {}))
    await reconnect()
    await act(async () => old.reject(new Error('old timeout')))
    await advance(30_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('cancels scheduled recovery on unmount', async () => {
    read.mockRejectedValue(new Error('offline'))
    await ui.render(createNode(Probe, {}))
    ui.cleanup()
    await advance(30_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(bus.off).toHaveBeenCalled()
  })

  it('cancels the previous chat retry and never applies its late read to the new chat', async () => {
    const old = deferred<typeof empty>()
    read.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(old.promise)
    await ui.render(createNode(Probe, {}))
    await advance(1_000)
    await ui.render(createNode(Probe, { chatId: 'other' }))
    await act(async () => old.reject(new Error('previous chat timeout')))
    await advance(30_000)
    expect(read).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenLastCalledWith({ chatId: 'other', threadRootId: null }, ['agent'])
  })
})
