import { describe, expect, test, vi } from 'vitest'
import { createDesktopDeviceCommandWakeSubscription } from '../../../../apps/desktop/electron/device-command-wake'
import {
  _resetElectronRealtimeChannelRegistryForTesting,
  listElectronRealtimeChannelRegistry
} from '../../../../apps/desktop/electron/realtime-channel'

describe('desktop device command wake subscription', () => {
  function createHarness() {
    const broadcastRef: { current: ((message?: unknown) => void) | null } = { current: null }
    const subscribeRef: { current: ((status: string, err?: Error) => void) | null } = {
      current: null
    }
    const channel = {
      on: vi.fn((_kind: string, _filter: unknown, callback: (message?: unknown) => void) => {
        broadcastRef.current = callback
        return channel
      }),
      subscribe: vi.fn((callback: (status: string, err?: Error) => void) => {
        subscribeRef.current = callback
        return channel
      }),
      unsubscribe: vi.fn(async () => undefined)
    }
    const supabase = {
      realtime: { setAuth: vi.fn(async () => undefined) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn()
    }
    const onCommand = vi.fn(async (_commandId?: string) => undefined)
    const onSubscribeFailure = vi.fn()
    const warn = vi.fn()

    return {
      broadcastRef,
      channel,
      onCommand,
      onSubscribeFailure,
      subscribeRef,
      supabase,
      warn
    }
  }

  function createMultiChannelHarness() {
    const subscribeRefs: Array<((status: string, err?: Error) => void) | null> = []
    const channels: Array<{
      on: ReturnType<typeof vi.fn>
      subscribe: ReturnType<typeof vi.fn>
      unsubscribe: ReturnType<typeof vi.fn>
    }> = []
    const supabase = {
      realtime: { setAuth: vi.fn(async () => undefined) },
      channel: vi.fn(() => {
        const index = channels.length
        const channel = {
          on: vi.fn(() => channel),
          subscribe: vi.fn((callback: (status: string, err?: Error) => void) => {
            subscribeRefs[index] = callback
            return channel
          }),
          unsubscribe: vi.fn(async () => undefined)
        }
        channels.push(channel)
        subscribeRefs.push(null)
        return channel
      }),
      removeChannel: vi.fn()
    }
    return { channels, subscribeRefs, supabase }
  }

  test('reconnects an already subscribed command wake channel without dropping the host wake', async () => {
    vi.useFakeTimers()
    try {
      _resetElectronRealtimeChannelRegistryForTesting()
      const { channels, subscribeRefs, supabase } = createMultiChannelHarness()
      const onCommand = vi.fn(async () => undefined)
      const onSubscribeFailure = vi.fn()
      const warn = vi.fn()

      const unsubscribe = await createDesktopDeviceCommandWakeSubscription({ supabase, warn })({
        deviceId: 'device-reconnect',
        onCommand,
        onSubscribeFailure
      })

      subscribeRefs[0]?.('SUBSCRIBED')
      await Promise.resolve()
      expect(onCommand).toHaveBeenCalledTimes(1)
      expect(listElectronRealtimeChannelRegistry()).toMatchObject([
        { label: 'device-command-wake:device-reconnect', status: 'subscribed', lastError: null }
      ])

      subscribeRefs[0]?.('TIMED_OUT')
      expect(onSubscribeFailure).toHaveBeenCalledTimes(0)
      expect(listElectronRealtimeChannelRegistry()).toMatchObject([
        { label: 'device-command-wake:device-reconnect', status: 'error', lastError: 'TIMED_OUT' }
      ])

      await vi.advanceTimersByTimeAsync(1000)
      expect(channels[0].unsubscribe).toHaveBeenCalledTimes(1)
      expect(supabase.channel).toHaveBeenCalledTimes(2)
      expect(listElectronRealtimeChannelRegistry()).toMatchObject([
        { label: 'device-command-wake:device-reconnect', status: 'subscribing', lastError: null }
      ])

      subscribeRefs[1]?.('SUBSCRIBED')
      await Promise.resolve()
      expect(onCommand).toHaveBeenCalledTimes(2)
      expect(listElectronRealtimeChannelRegistry()).toMatchObject([
        { label: 'device-command-wake:device-reconnect', status: 'subscribed', lastError: null }
      ])

      unsubscribe()
      expect(supabase.removeChannel).toHaveBeenCalledWith(channels[1])
      expect(listElectronRealtimeChannelRegistry()).toEqual([])
    } finally {
      vi.useRealTimers()
      _resetElectronRealtimeChannelRegistryForTesting()
    }
  })

  test('subscribes to private command broadcasts and removes the channel on unsubscribe', async () => {
    const { broadcastRef, channel, onCommand, onSubscribeFailure, subscribeRef, supabase, warn } =
      createHarness()

    const unsubscribe = await createDesktopDeviceCommandWakeSubscription({ supabase, warn })({
      deviceId: 'device-1',
      onCommand,
      onSubscribeFailure
    })

    expect(supabase.realtime.setAuth).toHaveBeenCalledWith()
    expect(supabase.channel).toHaveBeenCalledWith('gugu:device-1:commands', {
      config: {
        private: true,
        broadcast: { self: false, ack: true }
      }
    })
    expect(channel.on).toHaveBeenCalledWith('broadcast', { event: 'command_created' }, expect.any(Function))

    expect(broadcastRef.current).not.toBeNull()
    expect(subscribeRef.current).not.toBeNull()
    ;(subscribeRef.current as (status: string, err?: Error) => void)('SUBSCRIBED')
    await Promise.resolve()
    expect(onCommand).toHaveBeenCalledTimes(1)

    // #5906 —— 订上时的补拉是泛指(不带 id);广播点名它说的是哪一行(触发器写进负载的 `id`)。
    expect(onCommand.mock.calls.at(-1)).toEqual([])
    ;(broadcastRef.current as (message?: unknown) => void)({
      type: 'broadcast',
      event: 'command_created',
      payload: { id: 'cmd-42', type: 'agent.deliver', status: 'pending' }
    })
    await Promise.resolve()
    expect(onCommand).toHaveBeenCalledTimes(2)
    expect(onCommand).toHaveBeenLastCalledWith('cmd-42')

    ;(subscribeRef.current as (status: string, err?: Error) => void)('TIMED_OUT', new Error('slow'))
    expect(onSubscribeFailure).toHaveBeenCalledTimes(0)
    expect(warn).toHaveBeenCalledWith('[device-runtime] command wake subscribe failed: TIMED_OUT slow')

    unsubscribe()
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel)

    ;(broadcastRef.current as () => void)()
    await Promise.resolve()
    expect(onCommand).toHaveBeenCalledTimes(2)

    ;(subscribeRef.current as (status: string, err?: Error) => void)('CHANNEL_ERROR')
    expect(onSubscribeFailure).toHaveBeenCalledTimes(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  test('reports async removeChannel failure without leaving an unhandled rejection', async () => {
    _resetElectronRealtimeChannelRegistryForTesting()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { channel, onCommand, onSubscribeFailure, subscribeRef, supabase, warn } = createHarness()
      const removeError = new Error('socket teardown failed')
      supabase.removeChannel.mockReturnValue(Promise.reject(removeError))

      const unsubscribe = await createDesktopDeviceCommandWakeSubscription({ supabase, warn })({
        deviceId: 'device-remove-fails',
        onCommand,
        onSubscribeFailure
      })

      ;(subscribeRef.current as (status: string, err?: Error) => void)('SUBSCRIBED')
      unsubscribe()
      await Promise.resolve()

      expect(supabase.removeChannel).toHaveBeenCalledWith(channel)
      expect(consoleError).toHaveBeenCalledWith(
        '[Electron Realtime] device-command-wake:device-remove-fails removeChannel failed',
        removeError
      )
      expect(listElectronRealtimeChannelRegistry()).toEqual([])
    } finally {
      consoleError.mockRestore()
      _resetElectronRealtimeChannelRegistryForTesting()
    }
  })

  test('cleans up the command wake channel immediately after subscribe failure', async () => {
    const { broadcastRef, channel, onCommand, onSubscribeFailure, subscribeRef, supabase, warn } =
      createHarness()

    const unsubscribe = await createDesktopDeviceCommandWakeSubscription({ supabase, warn })({
      deviceId: 'device-fail',
      onCommand,
      onSubscribeFailure
    })

    ;(subscribeRef.current as (status: string, err?: Error) => void)('TIMED_OUT', new Error('slow'))

    expect(onSubscribeFailure).toHaveBeenCalledTimes(1)
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel)

    ;(broadcastRef.current as () => void)()
    await Promise.resolve()
    expect(onCommand).toHaveBeenCalledTimes(0)

    unsubscribe()
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
  })

  test('cleans up safely when subscribe reports failure synchronously', async () => {
    const { channel, onCommand, onSubscribeFailure, supabase, warn } = createHarness()
    channel.subscribe.mockImplementation((callback: (status: string, err?: Error) => void) => {
      callback('TIMED_OUT', new Error('slow'))
      return channel
    })

    const unsubscribe = await createDesktopDeviceCommandWakeSubscription({ supabase, warn })({
      deviceId: 'device-sync-fail',
      onCommand,
      onSubscribeFailure
    })

    expect(onSubscribeFailure).toHaveBeenCalledTimes(1)
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel)

    unsubscribe()
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
  })
})
