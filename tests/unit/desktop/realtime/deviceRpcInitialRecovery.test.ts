import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDesktopDeviceRpcSubscription } from '../../../../apps/desktop/electron/device-rpc-responder'
import { _resetElectronRealtimeChannelRegistryForTesting, listElectronRealtimeChannelRegistry } from '../../../../apps/desktop/electron/realtime-channel'

function cloud() {
  const channels: ReturnType<typeof make>[] = []
  let token = 'expired'
  const auths: string[] = []
  function make(topic: string) {
    const listeners = new Map<string, (payload: unknown) => void>()
    let status: (status: string, error?: Error) => void = () => {}
    const channel = {
      topic, sent: [] as Array<{ type: string }>,
      on: (_type: string, filter: { event: string }, receive: (payload: unknown) => void) => { listeners.set(filter.event, receive); return channel },
      subscribe: vi.fn((receive: typeof status) => { status = receive; return channel }),
      unsubscribe: vi.fn(async () => { status('CLOSED'); return 'ok' }),
      emit: (name: string, error?: Error) => status(name, error),
      receive: (payload: unknown) => listeners.get('broadcast')?.({ type: 'broadcast', event: 'broadcast', payload }),
      send: async (message: { payload: { type: string } }) => { channel.sent.push(message.payload); return 'ok' },
    }
    return channel
  }
  return { channels, auths, rotate: () => { token = 'current' }, supabase: {
    channel: (topic: string) => { const channel = make(topic); channels.push(channel); return channel },
    removeChannel: vi.fn(async () => {}),
    realtime: { setAuth: vi.fn(async () => { auths.push(token) }) },
  } }
}

beforeEach(() => { vi.useFakeTimers(); _resetElectronRealtimeChannelRegistryForTesting() })
afterEach(() => { _resetElectronRealtimeChannelRegistryForTesting(); vi.useRealTimers() })

it('recovers first Unauthorized with fresh auth, then answers taskhost.attach', async () => {
  const c = cloud()
  const stop = await createDesktopDeviceRpcSubscription({ supabase: c.supabase, warn: () => {},
    createHandlers: () => ({ handlers: {}, dispose: () => {} }),
  })({ deviceId: 'dev-1' })
  try {
    const first = c.channels[0]!
    first.emit('CHANNEL_ERROR', new Error('Unauthorized'))
    c.rotate()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(c.channels).toHaveLength(2)
    expect(c.auths).toEqual(['expired', 'current'])
    expect(c.channels.flatMap(channel => channel.sent)).toEqual([])
    const recovered = c.channels[1]!
    recovered.emit('SUBSCRIBED')
    recovered.receive({ type: 'taskhost.attach', request_id: 'attach-1', user_id: 'u1', payload: { asker: 'askerAAAA1111', protocol: REMOTE_PROTOCOL_VERSION } })
    await vi.advanceTimersByTimeAsync(0)
    const asker = c.channels.find(channel => channel.topic.endsWith(':askerAAAA1111'))!
    asker.emit('SUBSCRIBED')
    await vi.advanceTimersByTimeAsync(0)
    expect(asker.sent).toContainEqual(expect.objectContaining({ type: 'taskhost.attach:reply', request_id: 'attach-1', result: expect.objectContaining({ attached: true }) }))
    expect(listElectronRealtimeChannelRegistry()).toContainEqual(expect.objectContaining({ label: 'device-rpc:dev-1', status: 'subscribed' }))
  } finally { stop() }
})

it('never announces taskhost alive before successful subscription, or while disconnected', async () => {
  const c = cloud()
  const stop = await createDesktopDeviceRpcSubscription({ supabase: c.supabase, warn: () => {},
    createHandlers: () => ({ handlers: {}, dispose: () => {} }),
  })({ deviceId: 'dev-1' })
  try {
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.channels[0]!.sent).toEqual([])
    c.channels[0]!.emit('SUBSCRIBED')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.channels[0]!.sent.map(item => item.type)).toContain('taskhost.alive')
    c.channels[0]!.emit('CHANNEL_ERROR', new Error('Unauthorized'))
    const before = c.channels.reduce((n, channel) => n + channel.sent.length, 0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.channels.reduce((n, channel) => n + channel.sent.length, 0)).toBe(before)
  } finally { stop() }
})
