import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetElectronRealtimeChannelRegistryForTesting,
  reconnectElectronRealtimeChannels,
  listElectronRealtimeChannelRegistry,
  pauseElectronRealtimeChannels,
  subscribeAuthenticatedElectronRealtimeChannel,
  type ElectronManagedRealtimeChannel,
  type ElectronRealtimeClient,
} from '../../../../apps/desktop/electron/realtime-channel'

type FakeChannel = ElectronManagedRealtimeChannel & {
  emit: (status: string, error?: Error) => void
}

function makeChannel(closeOnUnsubscribe = false): FakeChannel {
  let statusHandler: ((status: string, error?: Error) => void) | null = null
  const channel = {
    subscribe: vi.fn((handler: (status: string, error?: Error) => void) => {
      statusHandler = handler
      return channel
    }),
    unsubscribe: vi.fn(async () => {
      if (closeOnUnsubscribe) statusHandler?.('CLOSED')
      return 'ok'
    }),
    emit: (status: string, error?: Error) => statusHandler?.(status, error),
  } as FakeChannel
  return channel
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Electron Realtime physical channel replacement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetElectronRealtimeChannelRegistryForTesting()
  })

  afterEach(() => {
    _resetElectronRealtimeChannelRegistryForTesting()
    vi.useRealTimers()
  })

  it('withdraws continuity synchronously before awaiting the old channel leave', async () => {
    const old = makeChannel(), fresh = makeChannel(), onUnavailable = vi.fn()
    let finish!: () => void
    vi.mocked(old.unsubscribe!).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel: async () => {} }, old,
      { label: 'policy-reconnect', createChannel: () => fresh, onUnavailable })
    old.emit('SUBSCRIBED'); onUnavailable.mockClear()
    const replacing = reconnectElectronRealtimeChannels()
    expect(onUnavailable).toHaveBeenCalledOnce(); expect(fresh.subscribe).not.toHaveBeenCalled()
    finish(); await replacing; await stop()
  })

  it('withdraws continuity immediately when account authentication is paused', async () => {
    const channel = makeChannel(), onUnavailable = vi.fn()
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel: async () => {} }, channel,
      { label: 'policy-auth', onUnavailable })
    channel.emit('SUBSCRIBED'); onUnavailable.mockClear()
    const resume = pauseElectronRealtimeChannels()
    expect(onUnavailable).toHaveBeenCalledOnce()
    resume(); await stop()
  })

  it('ignores old SUBSCRIBED throughout a pending leave and accepts only the fresh authenticated attempt', async () => {
    const old = makeChannel(), fresh = makeChannel()
    let finish!: () => void, live = false
    vi.mocked(old.unsubscribe!).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel: async () => {} }, old,
      { label: 'policy-late-status', createChannel: () => fresh, onUnavailable: () => { live = false }, onStatus: status => { live = status === 'SUBSCRIBED' } })
    old.emit('SUBSCRIBED'); expect(live).toBe(true)
    const replacing = reconnectElectronRealtimeChannels()
    old.emit('SUBSCRIBED'); expect(live).toBe(false)
    finish(); await replacing; expect(live).toBe(false)
    old.emit('SUBSCRIBED'); expect(live).toBe(false)
    fresh.emit('SUBSCRIBED'); expect(live).toBe(true)
    old.emit('CLOSED'); expect(live).toBe(true)
    await stop()
  })

  it('keeps nested authentication pauses closed and never revives the old callback after release', async () => {
    const old = makeChannel(), fresh = makeChannel(), createChannel = vi.fn(() => fresh)
    let live = false
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel: async () => {} }, old,
      { label: 'policy-nested-pause', createChannel, onUnavailable: () => { live = false }, onStatus: status => { live = status === 'SUBSCRIBED' } })
    old.emit('SUBSCRIBED'); expect(live).toBe(true)
    const first = pauseElectronRealtimeChannels(), second = pauseElectronRealtimeChannels()
    old.emit('SUBSCRIBED'); expect(live).toBe(false)
    first(); first(); await reconnectElectronRealtimeChannels(); expect(createChannel).not.toHaveBeenCalled()
    old.emit('SUBSCRIBED'); expect(live).toBe(false)
    second(); old.emit('SUBSCRIBED'); expect(live).toBe(false)
    await reconnectElectronRealtimeChannels(); fresh.emit('SUBSCRIBED'); expect(live).toBe(true)
    await stop()
  })

  it('does not let late SUBSCRIBED cancel replacement after a failed attempt', async () => {
    const old = makeChannel(), fresh = makeChannel(), createChannel = vi.fn(() => fresh)
    let live = false
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel: async () => {} }, old,
      { label: 'policy-failed-attempt', createChannel, reconnectOnStatus: () => true,
        onUnavailable: () => { live = false }, onStatus: status => { live = status === 'SUBSCRIBED' } })
    old.emit('SUBSCRIBED'); old.emit('CHANNEL_ERROR'); old.emit('SUBSCRIBED'); expect(live).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000); expect(createChannel).toHaveBeenCalledOnce()
    fresh.emit('SUBSCRIBED'); expect(live).toBe(true)
    await stop()
  })

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])('rejoins App default-options channels through fresh authentication after %s', async status => {
    const old = makeChannel(), fresh = makeChannel(), createChannel = vi.fn(() => fresh), onSubscribed = vi.fn()
    const setAuth = vi.fn(async () => {})
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth }, removeChannel: async () => {} }, old,
      { label: 'cloud:app', createChannel, onStatus: value => { if (value === 'SUBSCRIBED') onSubscribed() } })
    old.emit('SUBSCRIBED'); old.emit(status); old.emit('SUBSCRIBED')
    expect(onSubscribed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(createChannel).toHaveBeenCalledOnce(); expect(setAuth).toHaveBeenCalledTimes(2)
    fresh.emit('SUBSCRIBED'); old.emit('SUBSCRIBED')
    expect(onSubscribed).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('preserves SDK rejoin notifications for legacy callers without a factory or continuity observer', async () => {
    const channel = makeChannel(), onSubscribed = vi.fn()
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel: async () => {} }, channel,
      { label: 'device-rpc:legacy', onStatus: value => { if (value === 'SUBSCRIBED') onSubscribed() } })
    channel.emit('SUBSCRIBED'); channel.emit('CHANNEL_ERROR'); channel.emit('SUBSCRIBED')
    expect(onSubscribed).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('removes a failed one-shot default-options channel instead of replacing it', async () => {
    const old = makeChannel(), fresh = makeChannel(), createChannel = vi.fn(() => fresh), removeChannel = vi.fn(async () => {})
    await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel }, old,
      { label: 'one-shot', createChannel, unsubscribeOnStatus: () => true })
    old.emit('CHANNEL_ERROR'); old.emit('SUBSCRIBED'); await vi.advanceTimersByTimeAsync(1_000)
    expect(removeChannel).toHaveBeenCalledOnce(); expect(createChannel).not.toHaveBeenCalled()
    expect(listElectronRealtimeChannelRegistry()).toHaveLength(0)
  })

  it('honors explicit SDK reconnect for a caller without a continuity observer', async () => {
    const old = makeChannel(), createChannel = vi.fn(() => makeChannel()), onSubscribed = vi.fn()
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel: async () => {} }, old,
      { label: 'explicit-sdk', createChannel, reconnectOnStatus: () => false, onStatus: value => { if (value === 'SUBSCRIBED') onSubscribed() } })
    old.emit('SUBSCRIBED'); old.emit('CHANNEL_ERROR'); old.emit('SUBSCRIBED'); await vi.advanceTimersByTimeAsync(1_000)
    expect(onSubscribed).toHaveBeenCalledTimes(2); expect(createChannel).not.toHaveBeenCalled()
    await stop()
  })

  it('keeps a continuity observer closed without a fresh authenticated replacement', async () => {
    const channel = makeChannel()
    let current = false
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth: async () => {} }, removeChannel: async () => {} }, channel,
      { label: 'strict-without-factory', onUnavailable: () => { current = false }, onStatus: value => { current = value === 'SUBSCRIBED' } })
    channel.emit('SUBSCRIBED'); expect(current).toBe(true)
    channel.emit('CHANNEL_ERROR'); channel.emit('SUBSCRIBED'); expect(current).toBe(false)
    await stop()
  })

  it.each(['resolve', 'reject'] as const)('does not install a subscription from superseded authentication that later %ss', async result => {
    const old = makeChannel(), fresh = makeChannel(), setAuth = vi.fn(async () => {})
    let finish!: () => void
    const stop = await subscribeAuthenticatedElectronRealtimeChannel({ realtime: { setAuth }, removeChannel: async () => {} }, old,
      { label: 'policy-stale-auth', createChannel: () => fresh })
    old.emit('SUBSCRIBED')
    setAuth.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = () => { if (result === 'reject') reject(new Error('synthetic stale authentication')); else resolve() }
    }))
    const replacing = reconnectElectronRealtimeChannels(); await flushPromises()
    expect(setAuth).toHaveBeenCalledTimes(2)
    const resume = pauseElectronRealtimeChannels(); resume(); finish(); await replacing
    expect(fresh.subscribe).not.toHaveBeenCalled()
    await stop()
  })

  it('replaces a stale joined channel immediately after resume, without waiting for an error or timer', async () => {
    const old = makeChannel(true)
    const fresh = makeChannel()
    const createChannel = vi.fn(() => fresh)
    const client: ElectronRealtimeClient = {
      realtime: { setAuth: vi.fn(async () => undefined) }, removeChannel: vi.fn(async () => 'ok'),
    }
    const stop = await subscribeAuthenticatedElectronRealtimeChannel(client, old, {
      label: 'wake', createChannel, reconnectOnStatus: () => true,
    })
    old.emit('SUBSCRIBED')
    await Promise.all([reconnectElectronRealtimeChannels(), reconnectElectronRealtimeChannels()])
    expect(createChannel).toHaveBeenCalledOnce()
    expect(fresh.subscribe).toHaveBeenCalledOnce()
    fresh.emit('SUBSCRIBED')
    old.emit('CLOSED')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(createChannel).toHaveBeenCalledOnce()
    await stop()
  })

  it('旧频道重连不应把共享连接的认证从当前账号的新令牌改回旧令牌', async () => {
    const old = makeChannel()
    const fresh = makeChannel()
    const replacement = makeChannel()
    let ownerToken = 'old-token'
    let installed: string | undefined
    const client: ElectronRealtimeClient = {
      realtime: { setAuth: vi.fn(async (token?: string) => { installed = token ?? ownerToken }) },
      removeChannel: vi.fn(async () => 'ok'),
    }
    const oldOptions = { label: 'old', createChannel: () => replacement, reconnectOnStatus: () => true }
    const stopOld = await subscribeAuthenticatedElectronRealtimeChannel(client, old, oldOptions)
    old.emit('SUBSCRIBED')
    ownerToken = 'new-token'
    const freshOptions = { label: 'fresh' }
    const stopFresh = await subscribeAuthenticatedElectronRealtimeChannel(client, fresh, freshOptions)
    fresh.emit('SUBSCRIBED')
    expect(installed).toBe('new-token')
    old.emit('CLOSED')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(replacement.subscribe).toHaveBeenCalledTimes(1)
    expect(installed).toBe('new-token')
    await stopOld()
    await stopFresh()
  })

  it('ignores intentional and late CLOSED callbacks from the replaced channel', async () => {
    const first = makeChannel(true)
    const recovered = makeChannel()
    const createChannel = vi.fn(() => recovered)
    const onStatus = vi.fn()
    const client: ElectronRealtimeClient = {
      realtime: { setAuth: vi.fn(async () => undefined) },
      removeChannel: vi.fn(async () => 'ok'),
    }

    const unsubscribe = await subscribeAuthenticatedElectronRealtimeChannel(client, first, {
      label: 'device-rpc:test-device',
      createChannel,
      onStatus,
      reconnectOnStatus: (status) => status === 'CLOSED',
    })
    first.emit('SUBSCRIBED')
    first.emit('CLOSED')

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    expect(createChannel).toHaveBeenCalledTimes(1)
    expect(recovered.subscribe).toHaveBeenCalledTimes(1)

    recovered.emit('SUBSCRIBED')
    first.emit('CLOSED')
    await vi.advanceTimersByTimeAsync(60_000)
    await flushPromises()

    expect(createChannel).toHaveBeenCalledTimes(1)
    expect(onStatus.mock.calls.filter(([status]) => status === 'CLOSED')).toHaveLength(1)
    expect(listElectronRealtimeChannelRegistry()).toMatchObject([
      { label: 'device-rpc:test-device', status: 'subscribed', lastError: null },
    ])

    unsubscribe()
  })
})
