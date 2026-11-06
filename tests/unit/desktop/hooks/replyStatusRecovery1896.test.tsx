// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, deferred } from '../../../support/testHarness'

const read = vi.hoisted(() => vi.fn())
const bus = vi.hoisted(() => ({ subscribed: null as null | (() => void), off: vi.fn() }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/lib/storedAgentTurnFailures', () => ({ readStoredAgentTurnFailures: read }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (_user: string, _event: string, _listener: unknown, options: { onSubscribed: () => void }) => {
    bus.subscribed = options.onSubscribed
    return {}
  },
  unsubscribePrivateUserEventBus: bus.off,
}))
import { useStoredAgentTurnFailure } from '../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure'

function Probe() {
  const state = useStoredAgentTurnFailure({ chatId: 'chat', threadRootId: null }, ['agent'])
  return <div><span data-read-failed>{String(state.readFailed)}</span><button onClick={state.retry}>retry</button></div>
}
let ui: ReturnType<typeof createReactHarness>
const failed = () => ui.container.querySelector('[data-read-failed]')?.textContent
beforeEach(() => {
  ui = createReactHarness()
  read.mockReset()
  bus.off.mockClear()
  window.localStorage.clear()
})
afterEach(() => ui.cleanup())

describe('reply-status manual retry diagnosis (#1896)', () => {
  it('starts another read on click; a slow failed retry leaves the same warning (B)', async () => {
    const retry = deferred<{ failures: []; recovered: [] }>()
    read.mockRejectedValueOnce(new Error('statement timeout')).mockReturnValueOnce(retry.promise)
    await ui.render(createNode(Probe, {}))
    expect(failed()).toBe('true')
    await clickElement(ui.container.querySelector('button')!)
    expect(read).toHaveBeenCalledTimes(2)
    expect(failed()).toBe('true')
    await act(async () => retry.reject(new Error('statement timeout')))
    expect(failed()).toBe('true')
  })
  it('clears the warning when the retry succeeds (negative control for C)', async () => {
    read.mockRejectedValueOnce(new Error('statement timeout')).mockResolvedValueOnce({ failures: [], recovered: [] })
    await ui.render(createNode(Probe, {}))
    expect(failed()).toBe('true')
    await clickElement(ui.container.querySelector('button')!)
    expect(read).toHaveBeenCalledTimes(2)
    expect(failed()).toBe('false')
  })
})
