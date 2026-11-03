import { afterEach, describe, expect, test, vi } from 'vitest'
import { createDesktopOwnedAgentChangesSubscription } from '../../../../apps/desktop/electron/owned-agent-changes'
import { _resetElectronRealtimeChannelRegistryForTesting, listElectronRealtimeChannelRegistry } from '../../../../apps/desktop/electron/realtime-channel'

function harness() {
  const channels: Array<{
    event?: () => void
    status?: (status: string, error?: Error) => void
    on: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
  }> = []
  const supabase = {
    realtime: { setAuth: vi.fn(async () => undefined) },
    channel: vi.fn(() => {
      const channel: typeof channels[number] = {
        on: vi.fn((_kind, _filter, callback) => { channel.event = callback; return channel }),
        subscribe: vi.fn(callback => { channel.status = callback; return channel }),
        unsubscribe: vi.fn(async () => undefined),
      }
      channels.push(channel)
      return channel
    }),
    removeChannel: vi.fn(),
  }
  const changed = vi.fn(async () => undefined)
  const warn = vi.fn()
  return { channels, supabase, changed, warn }
}

afterEach(() => { _resetElectronRealtimeChannelRegistryForTesting(); vi.useRealTimers() })

describe('main-process owned agent changes', () => {
  test('uses the private owner topic and catches up on every SUBSCRIBED', async () => {
    const { channels, supabase, changed, warn } = harness()
    const stop = await createDesktopOwnedAgentChangesSubscription({ supabase, warn })({ ownerUserId: 'owner-a', onChanged: changed })
    expect(supabase.realtime.setAuth).toHaveBeenCalledOnce()
    expect(supabase.channel).toHaveBeenCalledWith('gugu:user:owner-a:agents', {
      config: { private: true, broadcast: { self: false, ack: true } },
    })
    expect(channels[0].on).toHaveBeenCalledWith('broadcast', { event: 'agent_changed' }, expect.any(Function))
    channels[0].status?.('SUBSCRIBED')
    channels[0].event?.()
    channels[0].status?.('RealtimeSubscribeStates.SUBSCRIBED')
    expect(changed).toHaveBeenCalledTimes(3)
    stop()
    channels[0].event?.()
    channels[0].status?.('SUBSCRIBED')
    expect(changed).toHaveBeenCalledTimes(3)
    expect(supabase.removeChannel).toHaveBeenCalledWith(channels[0])
    expect(listElectronRealtimeChannelRegistry()).toEqual([])
  })

  test('warns and reconnects even when its initial subscription fails', async () => {
    vi.useFakeTimers()
    const { channels, supabase, changed, warn } = harness()
    const stop = await createDesktopOwnedAgentChangesSubscription({ supabase, warn })({ ownerUserId: 'owner-a', onChanged: changed })
    channels[0].status?.('CHANNEL_ERROR', new Error('denied'))
    expect(warn).toHaveBeenCalledWith('[device-runtime] owned agents subscribe failed: CHANNEL_ERROR denied')
    await vi.advanceTimersByTimeAsync(1000)
    expect(channels).toHaveLength(2)
    channels[1].status?.('SUBSCRIBED')
    expect(changed).toHaveBeenCalledOnce()
    stop()
  })

  test('reports refresh rejection and keeps the managed subscription alive', async () => {
    const { channels, supabase, changed, warn } = harness()
    changed.mockRejectedValueOnce(new Error('cloud unavailable'))
    const stop = await createDesktopOwnedAgentChangesSubscription({ supabase, warn })({ ownerUserId: 'owner-a', onChanged: changed })
    channels[0].event?.()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith('[device-runtime] owned agents refresh failed: Error: cloud unavailable')
    channels[0].event?.()
    expect(changed).toHaveBeenCalledTimes(2)
    stop()
  })
})
