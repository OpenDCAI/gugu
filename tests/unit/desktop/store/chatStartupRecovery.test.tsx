// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, createReactHarness, deferred, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'
import { createChatProjectionStub, chatProjectionModuleStub } from '../../../support/chatProjectionStub'
import type { ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
import { REVISION_RECONCILE_INTERVAL_MS } from '../../../../apps/desktop/src/lib/accountRevisionReconcile'

const { rpc, shell, consumer, subscribeWake } = vi.hoisted(() => ({
  rpc: vi.fn(), consumer: vi.fn(), subscribeWake: vi.fn(),
  shell: { native: false, foreground: new Set<() => void>() },
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/supabase')>(),
  chatDb: { rpc }, dataClient: { schema: () => ({ rpc }) },
}))
vi.mock('../../../../apps/desktop/src/lib/localSyncDb', async original => {
  const actual = await original<typeof import('../../../../apps/desktop/src/lib/localSyncDb')>()
  return { ...actual, openLocalSyncDb: async () => actual.createMemoryLocalSyncDb() }
})
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: subscribeWake,
  unsubscribePrivateUserEventBus: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/platform', async original => {
  const actual = await original<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform,
    get kind() { return shell.native ? 'capacitor' : 'web' },
    subscribeAppForeground: (listener: () => void) => {
      shell.foreground.add(listener)
      return () => { shell.foreground.delete(listener) }
    },
  } }
})
const projection = createChatProjectionStub()
vi.mock('../../../../apps/desktop/src/lib/chatProjection', async original => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/chatProjection')>(),
  ...chatProjectionModuleStub(() => projection),
}))
vi.mock('../../../../apps/desktop/src/lib/notificationSettings', () => ({
  useNotificationSettings: () => ({ chatMessages: false, sound: false }),
}))

const { ChatProvider } = await import('../../../../apps/desktop/src/store/chat')
const { useChatStore } = await import('../../../../apps/desktop/src/store/chatContext')
let view: Pick<ChatContextValue, 'chats' | 'chatsLoadFailed' | 'chatsRead' | 'getImRepository'>
function Probe() {
  view = useChatStore('chats', 'chatsLoadFailed', 'chatsRead', 'getImRepository')
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  useEffect(() => subscribeAccountRevision('workspace_changed', consumer), [subscribeAccountRevision])
  return null
}
const snapshot = {
  account_id: 'account-a', revision: '10', chats: [], memberships: [], identities: [displayIdentity('account-a')],
  previews: [], unread: [], overrides: [], presence: {},
}
const failure = { code: '57014', message: 'canceling statement due to statement timeout' }
let harness: ReturnType<typeof createReactHarness> | undefined
function timeoutOnce(healthyAccount = 'account-a') {
  const first = deferred<{ data: unknown; error: unknown }>()
  let snapshots = 0
  rpc.mockImplementation((name: string, args?: { p_after_revision?: string }) => ({ abortSignal: () => {
    if (name === 'sync_snapshot') return ++snapshots === 1 ? first.promise : Promise.resolve({ data: {
      ...snapshot, account_id: healthyAccount, identities: [displayIdentity(healthyAccount)],
    }, error: null })
    if (name === 'sync_since') return Promise.resolve({ data: {
      operations: args?.p_after_revision === '10'
        ? [{ revision: '11', event: 'workspace_changed', payload: { chat_id: 'group-a', entity_id: 'file-a' } }]
        : [],
      has_more: false,
    }, error: null })
    throw new Error(`unexpected RPC ${name}`)
  } }))
  return { first, snapshots: () => snapshots }
}
async function mountAccount() {
  harness = createReactHarness()
  await renderWithAppProviders(harness, <ChatProvider><Probe /></ChatProvider>, { auth: { id: 'account-a' } })
}
beforeEach(() => {
  vi.useFakeTimers()
  shell.foreground.clear()
  rpc.mockReset()
  consumer.mockReset()
  subscribeWake.mockReset().mockReturnValue({ userId: 'account-a', eventName: 'im_revision_advanced', listenerId: 1 })
  projection.reset()
  projection.rows = [chat({ id: 'group-a', kind: 'group', name: 'Recovered group' })]
})
afterEach(() => { harness?.cleanup(); harness = undefined; vi.useRealTimers() })

describe('account startup recovery', () => {
  it.each([false, true])('recovers one snapshot timeout on the existing reconcile beat (phone=%s)', async native => {
    shell.native = native
    const fault = timeoutOnce()
    await mountAccount()
    // Positive control: the mounted provider reached the real snapshot initializer.
    expect(rpc).toHaveBeenCalledWith('sync_snapshot')
    await act(async () => { fault.first.resolve({ data: null, error: failure }) })
    expect(view.chatsLoadFailed).toBe(true)
    expect(rpc.mock.calls.filter(([name]) => name === 'sync_since')).toEqual([])
    expect(consumer).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(REVISION_RECONCILE_INTERVAL_MS) })
    await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    expect(fault.snapshots()).toBe(2)
    expect(view.chats.map(row => row.id)).toEqual(['group-a'])
    expect(view.chatsLoadFailed).toBe(false)
    expect(view.chatsRead).toBe(true)
    expect(subscribeWake).toHaveBeenCalledOnce()
    expect(consumer).toHaveBeenCalledOnce()
    expect(consumer.mock.calls[0]![0]).toMatchObject([{ revision: '11', event: 'workspace_changed' }])
    expect((await view.getImRepository()).snapshot().sync_state).toMatchObject([
      { key: 'account-revision-cursor', value: { revision: '11' } },
    ])
  })

  it.each([false, true])('positive control: remount reaches the healthy service (phone=%s)', async native => {
    shell.native = native
    const fault = timeoutOnce()
    await mountAccount()
    await act(async () => { fault.first.resolve({ data: null, error: failure }) })
    expect(view.chatsLoadFailed).toBe(true)
    harness!.cleanup()
    await mountAccount()
    await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    expect(fault.snapshots()).toBe(2)
    expect(view.chats.map(row => row.id)).toEqual(['group-a'])
    expect(view.chatsLoadFailed).toBe(false)
    expect(view.chatsRead).toBe(true)
    expect(consumer).toHaveBeenCalledOnce()
    const reads = rpc.mock.calls.filter(([name]) => name === 'sync_since').length
    await act(async () => { await vi.advanceTimersByTimeAsync(REVISION_RECONCILE_INTERVAL_MS + 16) })
    // Positive control for the rig's clock: the installed watcher really wakes the runtime.
    expect(rpc.mock.calls.filter(([name]) => name === 'sync_since')).toHaveLength(reads + 1)
    expect(consumer).toHaveBeenCalledOnce()
  })

  it.each([false, true])('does not revive a disposed account after a late snapshot (phone=%s)', async native => {
    shell.native = native
    const fault = timeoutOnce()
    await mountAccount()
    expect(rpc).toHaveBeenCalledWith('sync_snapshot')
    await renderWithAppProviders(harness!, <ChatProvider><Probe /></ChatProvider>, { auth: null })
    await act(async () => { fault.first.resolve({ data: snapshot, error: null }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(REVISION_RECONCILE_INTERVAL_MS) })
    expect(fault.snapshots()).toBe(1)
    expect(subscribeWake).not.toHaveBeenCalled()
    expect(consumer).not.toHaveBeenCalled()
    expect(view.chats).toEqual([])
    expect(shell.foreground.size).toBe(0)
  })

  it.each([false, true])('keeps the new account when the previous snapshot resolves late (phone=%s)', async native => {
    shell.native = native
    const fault = timeoutOnce('account-b')
    await mountAccount()
    expect(rpc).toHaveBeenCalledWith('sync_snapshot')
    projection.rows = [chat({ id: 'group-b', kind: 'group', name: 'Account B group' })]
    await renderWithAppProviders(harness!, <ChatProvider><Probe /></ChatProvider>, { auth: { id: 'account-b' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    expect((await view.getImRepository()).accountId).toBe('account-b')
    expect(view.chats.map(row => row.id)).toEqual(['group-b'])
    expect(consumer).toHaveBeenCalledOnce()
    await act(async () => { fault.first.resolve({ data: snapshot, error: null }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(REVISION_RECONCILE_INTERVAL_MS) })
    expect(fault.snapshots()).toBe(2)
    expect((await view.getImRepository()).accountId).toBe('account-b')
    expect(view.chats.map(row => row.id)).toEqual(['group-b'])
    expect(consumer).toHaveBeenCalledOnce()
    expect(subscribeWake).toHaveBeenCalledOnce()
    expect(subscribeWake.mock.calls[0]![0]).toBe('account-b')
  })

  it.each([false, true])('shares one pending initializer across overlapping lifecycle signals (phone=%s)', async native => {
    shell.native = native
    const fault = timeoutOnce()
    await mountAccount()
    expect(fault.snapshots()).toBe(1)
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
      for (const listener of [...shell.foreground]) listener()
      await vi.advanceTimersByTimeAsync(REVISION_RECONCILE_INTERVAL_MS)
    })
    expect(fault.snapshots()).toBe(1)
    await act(async () => { fault.first.resolve({ data: snapshot, error: null }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    expect(fault.snapshots()).toBe(1)
    expect(view.chats.map(row => row.id)).toEqual(['group-a'])
    expect(view.chatsLoadFailed).toBe(false)
    expect(consumer).toHaveBeenCalledOnce()
    expect(subscribeWake).toHaveBeenCalledOnce()
  })
})
