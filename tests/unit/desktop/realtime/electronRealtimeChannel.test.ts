import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetElectronRealtimeChannelRegistryForTesting,
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
      accessToken: 'access-token',
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
