// @vitest-environment jsdom
import { act,createElement } from 'react'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { createConnectionRouting,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import { ConnectionRouteBoundary } from '@/components/connections/ConnectionRouteBoundary'
import type { ConnectionBridge,ConnectionWindow } from '@/lib/connectionBridge'
import { createConnectionClient } from '@gugu/core/cloud/connections'
import { useConnectionMutationAllowed } from '@/components/connections/connection-mutation-context'
import { createReactHarness,renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>,route: ConnectionRoute,refresh: () => void
const notice = vi.hoisted(() => vi.fn())
vi.mock('@/lib/notices',() => ({ notify: notice }))
const owner = vi.fn(),legacy = vi.fn(),read = vi.fn()
beforeEach(() => {
  harness = createReactHarness(); owner.mockReset(); legacy.mockReset(); read.mockReset()
  notice.mockClear()
  route = { mode: 'legacy',epoch: '0',phase: 'stable',acceptingNewOperations: true }
  read.mockImplementation(async () => route)
  const routing = createConnectionRouting({ accountId: () => 'boundary-owner',read,changed: () => {} })
  const bridge: ConnectionBridge = { routing,accountId: () => 'boundary-owner',subscribeAccount: () => () => {},
    subscribeChanges: (_owner,listener) => { refresh = listener; return () => {} },
    metadata: () => { throw new Error('Unexpected owner metadata read') },
    client: createConnectionClient(async () => { throw new Error('Unexpected owner RPC') },() => 'boundary-owner'),
    retryOperation: async () => { throw new Error('Unexpected effect') },
  }
  ;(window as ConnectionWindow).__GUGU_CONNECTIONS__ = bridge
})
afterEach(() => { harness.cleanup(); vi.useRealTimers(); delete (window as ConnectionWindow).__GUGU_CONNECTIONS__ })
function Owner() { const allowed = useConnectionMutationAllowed(); return createElement('button',{ disabled: !allowed },'Authorize') }
function Legacy() { legacy(); return createElement('span',null,'Legacy accounts') }
const render = () => renderWithAppProviders(harness,createElement(ConnectionRouteBoundary,{ legacy: createElement(Legacy),owner: value => {
  owner(value); return createElement('div',null,`Owner accounts ${value.epoch}`,createElement(Owner))
} }),{ auth: { id: 'boundary-owner' } })
describe('connection shell authority boundary without a query provider', () => {
  it('retains legacy rendering without opening owner data or an assistant from the routing reader', async () => {
    await render()
    await vi.waitFor(() => expect(harness.container.textContent).toContain('Legacy accounts'))
    expect(owner).not.toHaveBeenCalled()
  })
  it('opens owner settings without mounting the legacy assistant-dependent shell', async () => {
    route = { ...route,mode: 'owner',epoch: '3' }
    await render()
    await vi.waitFor(() => expect(harness.container.textContent).toContain('Owner accounts 3'))
    expect(legacy).not.toHaveBeenCalled()
    route = { ...route,epoch: '4',phase: 'quiescing',acceptingNewOperations: false }
    await act(async () => { refresh() })
    await vi.waitFor(() => expect(harness.container.querySelector('button')?.disabled).toBe(true))
    expect(harness.container.textContent).not.toContain('连接正在切换')
  })
  it('retains a successful route when a background refresh fails',async () => {
    route = { ...route,mode: 'owner',epoch: '3' }
    await render()
    await vi.waitFor(() => expect(harness.container.textContent).toContain('Owner accounts 3'))
    read.mockRejectedValue(Object.assign(new Error('OFFLINE'),{ code: 'unavailable' }))
    await act(async () => { refresh() })
    expect(harness.container.textContent).toContain('Owner accounts 3')
    expect(legacy).not.toHaveBeenCalled()
    expect(notice).not.toHaveBeenCalled()
  })
  it('backs off empty reads and sends only one transient notice after four failures',async () => {
    vi.useFakeTimers()
    read.mockRejectedValue(Object.assign(new Error('OFFLINE'),{ code: 'unavailable' }))
    await render()
    expect(read).toHaveBeenCalledTimes(1)
    for (const delay of [1000,2000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay) })
      expect(notice).not.toHaveBeenCalled()
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(read).toHaveBeenCalledTimes(4)
    expect(notice).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(notice).toHaveBeenCalledTimes(1)
    expect(harness.container.querySelector('[data-testid="application-list-pending"]')).toBeTruthy()
  })
  it('keeps authority failures silent while preserving the unread skeleton and never treats a permission error as legacy or empty accounts', async () => {
    read.mockRejectedValue(Object.assign(new Error('DENIED'),{ code: '42501' }))
    await render()
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    expect(harness.container.querySelector('[data-testid="application-list-pending"]')).toBeTruthy()
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
    expect(notice).not.toHaveBeenCalled()
    expect(owner).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled()
  })
})
