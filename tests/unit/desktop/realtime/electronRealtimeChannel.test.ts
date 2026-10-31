import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetElectronRealtimeChannelRegistryForTesting,
  reconnectElectronRealtimeChannels,
  listElectronRealtimeChannelRegistry,
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
