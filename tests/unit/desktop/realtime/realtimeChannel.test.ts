// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
type SubscribeCallback = (status: string, error?: Error) => void
type BroadcastCallback = (payload: unknown) => void
type FakeChannel = {
  on: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  _subscribe: (status: string, error?: Error) => void
  _broadcast: (event: string, payload: unknown) => void
}
const { authPushedListeners } = vi.hoisted(() => ({
  authPushedListeners: new Set<() => void>(),
}))
let fakeChannel: FakeChannel
function makeFakeChannel(): FakeChannel {
  let callback: SubscribeCallback | null = null
  let joinedOnce = false
  const broadcastListeners = new Map<string, BroadcastCallback[]>()
  const channel = {
    on: vi.fn((_type: string, filter: { event: string }, handler: BroadcastCallback) => {
      const listeners = broadcastListeners.get(filter.event) ?? []
      listeners.push(handler)
      broadcastListeners.set(filter.event, listeners)
      return channel
    }),
    subscribe: vi.fn((cb: SubscribeCallback) => {
      if (joinedOnce) throw new Error("tried to join multiple times. 'join' can only be called a single time per channel instance")
      joinedOnce = true
      callback = cb
      return channel
    }),
    unsubscribe: vi.fn(async () => 'ok'),
    _subscribe: (status: string, error?: Error) => {
      callback?.(status, error)
    },
    _broadcast: (event: string, payload: unknown) => {
      for (const listener of broadcastListeners.get(event) ?? []) listener(payload)
      for (const listener of broadcastListeners.get('*') ?? []) listener({ event, payload })
    },
  }
  return channel
}
vi.mock('../../../../apps/desktop/src/lib/supabase', () => {
  const dataClient = {
    channel: vi.fn(() => fakeChannel),
    removeChannel: vi.fn(async () => 'ok'),
    realtime: { sendHeartbeat: vi.fn(async () => undefined) },
  }
  return { dataClient }
})
vi.mock('../../../../apps/desktop/src/lib/realtimeSessionManager', () => ({
  ensureRealtimeAuth: vi.fn(async () => undefined),
  onRealtimeAuthPushed: vi.fn((listener: () => void) => {
    authPushedListeners.add(listener)
    return () => authPushedListeners.delete(listener)
  }),
}))
import { dataClient } from '../../../../apps/desktop/src/lib/supabase'
import { ensureRealtimeAuth } from '../../../../apps/desktop/src/lib/realtimeSessionManager'
import {
  _resetRealtimeChannelRegistryForTesting,
  _simulateStaleSubscriptionForTesting,
  debugEmitRealtimeChannelStatus,
  listRealtimeChannelRegistry,
  runStaleSubscriptionCheck,
  subscribePrivateUserEventBus,
  subscribeAuthenticatedRealtimeChannel,
  unsubscribePrivateUserEventBus,
  unsubscribeAuthenticatedRealtimeChannel,
} from '../../../../apps/desktop/src/lib/realtimeChannel'
async function flushAuthQueue(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
beforeEach(() => {
  vi.useRealTimers()
  fakeChannel = makeFakeChannel()
  vi.mocked(dataClient.channel).mockReset()
  vi.mocked(dataClient.channel).mockImplementation(() => fakeChannel as never)
  vi.mocked(dataClient.removeChannel).mockReset()
  vi.mocked(dataClient.removeChannel).mockResolvedValue('ok')
  vi.mocked(ensureRealtimeAuth).mockClear()
  vi.mocked(ensureRealtimeAuth).mockResolvedValue(undefined)
  _resetRealtimeChannelRegistryForTesting()
})
afterEach(() => {
  vi.useRealTimers()
})
describe('realtime channel registry', () => {
  it('tracks a subscribed channel through the shared auth boundary', async () => {
    subscribeAuthenticatedRealtimeChannel(fakeChannel as never, 'chat:list:user-1')
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list:user-1', status: 'authenticating', lastError: null },
    ])
    await flushAuthQueue()
    expect(ensureRealtimeAuth).toHaveBeenCalledTimes(1)
    expect(fakeChannel.subscribe).toHaveBeenCalledTimes(1)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list:user-1', status: 'subscribing', lastError: null },
    ])
    fakeChannel._subscribe('SUBSCRIBED')
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list:user-1', status: 'subscribed', lastError: null },
    ])
  })
  it('reports raw subscribe status to the owner before registry mapping', async () => {
    const onStatus = vi.fn()
    subscribeAuthenticatedRealtimeChannel(fakeChannel as never, 'device-rpc:dev-1', { onStatus })
    await flushAuthQueue()
    const error = new Error('socket closed')
    fakeChannel._subscribe('TIMED_OUT', error)
    expect(onStatus).toHaveBeenCalledWith('TIMED_OUT', error)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'device-rpc:dev-1', status: 'error', lastError: 'TIMED_OUT' },
    ])
  })
  it('marks failures and releases owned channels through the same owner', async () => {
    subscribeAuthenticatedRealtimeChannel(fakeChannel as never, 'agent:runtime')
    await flushAuthQueue()
    fakeChannel._subscribe('CHANNEL_ERROR', new Error('socket closed'))
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'agent:runtime', status: 'error', lastError: 'CHANNEL_ERROR' },
    ])
    unsubscribeAuthenticatedRealtimeChannel(fakeChannel as never)
    expect(dataClient.removeChannel).toHaveBeenCalledWith(fakeChannel)
    await flushAuthQueue()
    expect(listRealtimeChannelRegistry()).toEqual([])
  })
  it('reports unexpected remote closed callbacks as realtime failures', async () => {
    subscribeAuthenticatedRealtimeChannel(fakeChannel as never, 'chat:list')
    await flushAuthQueue()
    fakeChannel._subscribe('CLOSED')
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'error', lastError: 'CLOSED' },
    ])
  })
  it('keeps channel cleanup failures visible in the realtime registry', async () => {
    const removeError = new Error('remove boom')
    vi.mocked(dataClient.removeChannel).mockRejectedValue(removeError)
    subscribeAuthenticatedRealtimeChannel(fakeChannel as never, 'chat:list')
    await flushAuthQueue()
    fakeChannel._subscribe('SUBSCRIBED')
    unsubscribeAuthenticatedRealtimeChannel(fakeChannel as never)
    await flushAuthQueue()
    expect(dataClient.removeChannel).toHaveBeenCalledWith(fakeChannel)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'error', lastError: 'remove boom' },
    ])
  })
  it('drops channels from the registry only after cleanup succeeds', async () => {
    subscribeAuthenticatedRealtimeChannel(fakeChannel as never, 'chat:list')
    await flushAuthQueue()
    fakeChannel._subscribe('SUBSCRIBED')
    unsubscribeAuthenticatedRealtimeChannel(fakeChannel as never)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'closed', lastError: null },
    ])
    await flushAuthQueue()
    expect(listRealtimeChannelRegistry()).toEqual([])
  })
  it('does not resurrect a channel when the owner releases it mid-reconnect', async () => {
    vi.useFakeTimers()
    const firstChannel = makeFakeChannel()
    const secondChannel = makeFakeChannel()
    // Hold the reconnect's unsubscribe() open so the owner can release during the in-flight window.
    let resolveRetryUnsub: () => void = () => undefined
    firstChannel.unsubscribe = vi.fn(() => new Promise<'ok'>((resolve) => {
      resolveRetryUnsub = () => resolve('ok')
    })) as never
    // Keep removeChannel pending so the registry entry survives — the 'closed' status, not entry
    // deletion, must be what stops the reconnect from rebuilding the channel.
    vi.mocked(dataClient.removeChannel).mockReturnValue(new Promise(() => undefined) as never)
    vi.mocked(dataClient.channel)
      .mockReturnValueOnce(firstChannel as never)
      .mockReturnValueOnce(secondChannel as never)
    const ownerHandle = subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('chat:list'), 'chat:list')
    await flushAuthQueue()
    firstChannel._subscribe('SUBSCRIBED')
    firstChannel._subscribe('CHANNEL_ERROR')
    vi.advanceTimersByTime(1000)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'reconnecting', lastError: 'CHANNEL_ERROR' },
    ])
    expect(firstChannel.unsubscribe).toHaveBeenCalledTimes(1)
    unsubscribeAuthenticatedRealtimeChannel(ownerHandle)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'closed' },
    ])
    resolveRetryUnsub()
    await flushAuthQueue()
    await flushAuthQueue()
    expect(dataClient.channel).toHaveBeenCalledTimes(1)
    expect(secondChannel.subscribe).not.toHaveBeenCalled()
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'closed' },
    ])
  })
  it('reconnects an errored channel and restores subscribed state', async () => {
    vi.useFakeTimers()
    const firstChannel = makeFakeChannel()
    const secondChannel = makeFakeChannel()
    vi.mocked(dataClient.channel)
      .mockReturnValueOnce(firstChannel as never)
      .mockReturnValueOnce(secondChannel as never)
    subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('chat:list'), 'chat:list')
    await flushAuthQueue()
    firstChannel._subscribe('CHANNEL_ERROR')
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'error', lastError: 'CHANNEL_ERROR' },
    ])
    vi.advanceTimersByTime(1000)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'reconnecting', lastError: 'CHANNEL_ERROR' },
    ])
    expect(firstChannel.unsubscribe).toHaveBeenCalledTimes(1)
    await flushAuthQueue()
    await flushAuthQueue()
    expect(secondChannel.subscribe).toHaveBeenCalledTimes(1)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'subscribing', lastError: null },
    ])
    secondChannel._subscribe('SUBSCRIBED')
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'subscribed', lastError: null },
    ])
  })
  it('network back (online): every channel not subscribed (in backoff, or hung in a join sent offline) retries now', async () => {
    vi.useFakeTimers()
    const channels = [makeFakeChannel(), makeFakeChannel(), makeFakeChannel(), makeFakeChannel()]
    for (const c of channels) vi.mocked(dataClient.channel).mockReturnValueOnce(c as never)
    subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('device-rpc'), 'device-rpc')
    await flushAuthQueue()
    // offline: two failed rounds push the next wait to 5 s (1 s, 2 s, 5 s, …)
    for (const [i, delay] of [[0, 1000], [1, 2000]] as const) {
      channels[i]!._subscribe('CHANNEL_ERROR')
      vi.advanceTimersByTime(delay)
      await flushAuthQueue()
      await flushAuthQueue()
    }
    channels[2]!._subscribe('CHANNEL_ERROR')
    vi.advanceTimersByTime(5000)
    await flushAuthQueue()
    await flushAuthQueue()
    // the 5 s round's join went out while still offline and hangs in subscribing (its watchdog has not fired yet)
    expect(listRealtimeChannelRegistry()[0]).toMatchObject({ status: 'subscribing' })
    const stuck = channels[3]!
    channels.push(makeFakeChannel())
    vi.mocked(dataClient.channel).mockReturnValueOnce(channels[4] as never)
    expect(channels[4]!.subscribe).not.toHaveBeenCalled()
    vi.mocked(dataClient.realtime.sendHeartbeat).mockClear()
    window.dispatchEvent(new Event('online'))
    await flushAuthQueue()
    await flushAuthQueue()
    // the socket is asked too: a heartbeat left unanswered while offline makes Phoenix tear the dead socket down at once
    expect(dataClient.realtime.sendHeartbeat).toHaveBeenCalledTimes(1)
    expect(stuck.unsubscribe, 'the hung join is dropped').toHaveBeenCalledTimes(1)
    expect(channels[4]!.subscribe, 'and a fresh join goes out right away').toHaveBeenCalledTimes(1)
    // control: a healthy subscribed channel is not churned by online
    channels[4]!._subscribe('SUBSCRIBED')
    window.dispatchEvent(new Event('online'))
    expect(channels[4]!.unsubscribe).not.toHaveBeenCalled()
  })

  it('retries a reconnect attempt that gets stuck in subscribing', async () => {
    vi.useFakeTimers()
    const firstChannel = makeFakeChannel()
    const stuckChannel = makeFakeChannel()
    const recoveredChannel = makeFakeChannel()
    vi.mocked(dataClient.channel)
      .mockReturnValueOnce(firstChannel as never)
      .mockReturnValueOnce(stuckChannel as never)
      .mockReturnValueOnce(recoveredChannel as never)
    subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('chat:list'), 'chat:list')
    await flushAuthQueue()
    firstChannel._subscribe('SUBSCRIBED')
    firstChannel._subscribe('CHANNEL_ERROR')
    vi.advanceTimersByTime(1000)
    await flushAuthQueue()
    await flushAuthQueue()
    expect(stuckChannel.subscribe).toHaveBeenCalledTimes(1)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'subscribing', lastError: null },
    ])
    vi.advanceTimersByTime(5000)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'error', lastError: 'SUBSCRIBE_TIMEOUT' },
    ])
    vi.advanceTimersByTime(2000)
    await flushAuthQueue()
    await flushAuthQueue()
    expect(recoveredChannel.subscribe).toHaveBeenCalledTimes(1)
    recoveredChannel._subscribe('SUBSCRIBED')
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'subscribed', lastError: null },
    ])
  })
  it('cleans up the recovered physical channel when the owner releases a stale handle', async () => {
    vi.useFakeTimers()
    const firstChannel = makeFakeChannel()
    const secondChannel = makeFakeChannel()
    vi.mocked(dataClient.channel)
      .mockReturnValueOnce(firstChannel as never)
      .mockReturnValueOnce(secondChannel as never)
    const ownerHandle = subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('chat:list'), 'chat:list')
    await flushAuthQueue()
    firstChannel._subscribe('SUBSCRIBED')
    firstChannel._subscribe('CHANNEL_ERROR')
    vi.advanceTimersByTime(1000)
    await flushAuthQueue()
    await flushAuthQueue()
    secondChannel._subscribe('SUBSCRIBED')
    unsubscribeAuthenticatedRealtimeChannel(ownerHandle)
    expect(dataClient.removeChannel).toHaveBeenCalledWith(secondChannel)
    await flushAuthQueue()
    expect(listRealtimeChannelRegistry()).toEqual([])
  })
  it('keeps realtime auth failures explicit and retries them after auth changes', async () => {
    const firstChannel = makeFakeChannel()
    const secondChannel = makeFakeChannel()
    vi.mocked(dataClient.channel)
      .mockReturnValueOnce(firstChannel as never)
      .mockReturnValueOnce(secondChannel as never)
    vi.mocked(ensureRealtimeAuth)
      .mockRejectedValueOnce(new Error('missing realtime token'))
      .mockResolvedValue(undefined)
    subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('chat:list'), 'chat:list')
    await flushAuthQueue()
    expect(firstChannel.subscribe).not.toHaveBeenCalled()
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'auth_error', lastError: 'missing realtime token' },
    ])
    for (const listener of authPushedListeners) listener()
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'reconnecting', lastError: 'missing realtime token' },
    ])
    await flushAuthQueue()
    await flushAuthQueue()
    expect(secondChannel.subscribe).toHaveBeenCalledTimes(1)
  })
  it('keeps injected auth-error debug status explicit for visible diagnostics', async () => {
    vi.useFakeTimers()
    const firstChannel = makeFakeChannel()
    const secondChannel = makeFakeChannel()
    vi.mocked(dataClient.channel)
      .mockReturnValueOnce(firstChannel as never)
      .mockReturnValueOnce(secondChannel as never)
    subscribeAuthenticatedRealtimeChannel(() => dataClient.channel('chat:list'), 'chat:list')
    await flushAuthQueue()
    firstChannel._subscribe('SUBSCRIBED')
    const injected = debugEmitRealtimeChannelStatus('chat:list', 'auth_error', 'JWT expired')
    expect(injected).toMatchObject({
      id: 'rt-1',
      label: 'chat:list',
      status: 'auth_error',
      lastError: 'JWT expired',
      receivedBroadcastCount: 0,
      lastBroadcastEvent: null,
      lastBroadcastPayloadJson: null,
      broadcastEventCounts: {},
      lastBroadcastPayloadJsonByEvent: {},
    })
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'auth_error', lastError: 'JWT expired' },
    ])
    vi.advanceTimersByTime(1000)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'reconnecting', lastError: 'JWT expired' },
    ])
    expect(firstChannel.unsubscribe).toHaveBeenCalledTimes(1)
    await flushAuthQueue()
    await flushAuthQueue()
    expect(secondChannel.subscribe).toHaveBeenCalledTimes(1)
    secondChannel._subscribe('SUBSCRIBED')
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'chat:list', status: 'subscribed', lastError: null },
    ])
  })
  it('does not subscribe when the owner has already released intent', async () => {
    const live = false
    subscribeAuthenticatedRealtimeChannel(fakeChannel as never, 'stale', { shouldSubscribe: () => live })
    await flushAuthQueue()
    expect(fakeChannel.subscribe).not.toHaveBeenCalled()
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'stale', status: 'authenticating' },
    ])
  })
  it('shares one private user event bus channel across removable listeners', async () => {
    const messageListener = vi.fn()
    const collabListener = vi.fn()
    const messageHandle = subscribePrivateUserEventBus('user-1', 'message_created', messageListener)
    const collabHandle = subscribePrivateUserEventBus('user-1', 'group_collab_changed', collabListener)
    await flushAuthQueue()
    expect(dataClient.channel).toHaveBeenCalledTimes(1)
    expect(fakeChannel.subscribe).toHaveBeenCalledTimes(1)
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'gugu:user:user-1:events', status: 'subscribing', lastError: null },
    ])
    fakeChannel._broadcast('message_created', { payload: { id: 'message-1' } })
    expect(messageListener).toHaveBeenCalledTimes(1)
    expect(messageListener).toHaveBeenCalledWith({ payload: { id: 'message-1' } })
    expect(collabListener).not.toHaveBeenCalled()
    unsubscribePrivateUserEventBus(messageHandle)
    expect(dataClient.removeChannel).not.toHaveBeenCalled()
    fakeChannel._broadcast('message_created', { payload: { id: 'message-2' } })
    fakeChannel._broadcast('group_collab_changed', { payload: { chat_id: 'chat-1' } })
    expect(messageListener).toHaveBeenCalledTimes(1)
    expect(collabListener).toHaveBeenCalledTimes(1)
    unsubscribePrivateUserEventBus(collabHandle)
    expect(dataClient.removeChannel).toHaveBeenCalledTimes(1)
    expect(dataClient.removeChannel).toHaveBeenCalledWith(fakeChannel)
    await flushAuthQueue()
    expect(listRealtimeChannelRegistry()).toEqual([])
  })
  it('recreates the private user event bus physical channel when recovering', async () => {
    vi.useFakeTimers()
    const firstChannel = makeFakeChannel()
    const secondChannel = makeFakeChannel()
    vi.mocked(dataClient.channel)
      .mockReturnValueOnce(firstChannel as never)
      .mockReturnValueOnce(secondChannel as never)
    const listener = vi.fn()
    subscribePrivateUserEventBus('user-1', 'message_created', listener)
    await flushAuthQueue()
    firstChannel._subscribe('SUBSCRIBED')
    const injected = debugEmitRealtimeChannelStatus('gugu:user:user-1:events', 'CHANNEL_ERROR')
    expect(injected).toMatchObject({ status: 'error', lastError: 'CHANNEL_ERROR' })
    vi.advanceTimersByTime(1000)
    expect(firstChannel.unsubscribe).toHaveBeenCalledTimes(1)
    await flushAuthQueue()
    await flushAuthQueue()
    expect(secondChannel.subscribe).toHaveBeenCalledTimes(1)
    secondChannel._subscribe('SUBSCRIBED')
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'gugu:user:user-1:events', status: 'subscribed', lastError: null },
    ])
    const beforePayload = listRealtimeChannelRegistry()[0]
    expect(beforePayload).toMatchObject({ receivedBroadcastCount: 0 })
    secondChannel._broadcast('message_created', { payload: { id: 'message-after-recovery' } })
    expect(listener).toHaveBeenCalledWith({ payload: { id: 'message-after-recovery' } })
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { id: 'rt-1', label: 'gugu:user:user-1:events', receivedBroadcastCount: 1 },
    ])
    expect(listRealtimeChannelRegistry()[0]).toMatchObject({
      lastBroadcastEvent: 'message_created',
      lastBroadcastPayloadJson: JSON.stringify({ payload: { id: 'message-after-recovery' } }),
      broadcastEventCounts: { message_created: 1 },
      lastBroadcastPayloadJsonByEvent: {
        message_created: JSON.stringify({ payload: { id: 'message-after-recovery' } }),
      },
    })
  })
  it('does not use healthy silence as a reconnect signal for the durable account wake bus', async () => {
    subscribePrivateUserEventBus('user-1', 'im_revision_advanced', vi.fn())
    await flushAuthQueue()
    fakeChannel._subscribe('SUBSCRIBED')
    expect(_simulateStaleSubscriptionForTesting('gugu:user:user-1:events')).toBe(true)
    runStaleSubscriptionCheck()
    expect(listRealtimeChannelRegistry()).toMatchObject([
      { label: 'gugu:user:user-1:events', status: 'subscribed', lastError: null },
    ])
  })
  it('runs catch-up when a private user event bus listener joins an already subscribed bus', async () => {
    const firstSubscribed = vi.fn()
    const lateSubscribed = vi.fn()
    subscribePrivateUserEventBus('user-1', 'chat_meta_changed', vi.fn(), { onSubscribed: firstSubscribed })
    await flushAuthQueue()
    fakeChannel._subscribe('SUBSCRIBED')
    expect(firstSubscribed).toHaveBeenCalledTimes(1)
    subscribePrivateUserEventBus('user-1', 'message_created', vi.fn(), { onSubscribed: lateSubscribed })
    await flushAuthQueue()
    expect(dataClient.channel).toHaveBeenCalledTimes(1)
    expect(fakeChannel.subscribe).toHaveBeenCalledTimes(1)
    expect(lateSubscribed).toHaveBeenCalledTimes(1)
  })
})
// @@@stale-subscription-watchdog (#840)
describe('stale subscription watchdog', () => {
  async function subscribeAndJoin(label: string): Promise<void> {
    subscribeAuthenticatedRealtimeChannel(fakeChannel as never, label)
    await flushAuthQueue()
    fakeChannel._subscribe('SUBSCRIBED')
  }
  it('does NOT reconnect when a real broadcast refreshed lastEventAt (the #840 fix)', async () => {
    await subscribeAndJoin('agent:a2:presence')
    // Age it stale, then deliver a real broadcast — the layer-owned wildcard listener must bump
    // lastEventAt back to now. Without the fix the broadcast would not bump it → still stale.
    expect(_simulateStaleSubscriptionForTesting('agent:a2:presence')).toBe(true)
    fakeChannel._broadcast('presence_changed', { agentUserId: 'a2' })
    runStaleSubscriptionCheck()
    expect(listRealtimeChannelRegistry()[0]).toMatchObject({ status: 'subscribed' })
  })
})
