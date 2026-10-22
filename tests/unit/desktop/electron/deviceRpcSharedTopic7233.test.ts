// #7233 共用 topic `gugu:<dev>:rpc` 上只剩报到、ready、alive(apps/desktop/electron/device-rpc-responder.ts):
// 不报到直接问的(协议 9 以前的咕咕)当场回 client_outdated;库里中转来的 MessagePreview 照常收;每 60 s 一条 alive。
import { afterEach, describe, expect, it, vi } from 'vitest'

const subs = vi.hoisted(() => ({ list: [] as { topic: string; onStatus: (status: string) => void }[] }))
vi.mock('../../../../apps/desktop/electron/realtime-channel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/electron/realtime-channel')>()),
  subscribeAuthenticatedElectronRealtimeChannel: async (_client: unknown, channel: { topic: string }, options: { onStatus: (status: string) => void }) => {
    subs.list.push({ topic: channel.topic, onStatus: options.onStatus })
    return () => undefined
  },
}))

import { createDesktopDeviceRpcSubscription } from '../../../../apps/desktop/electron/device-rpc-responder'

function fakeSupabase() {
  subs.list.length = 0
  const channels = new Map<string, { sent: unknown[]; listeners: ((payload: unknown) => void)[] }>()
  const supabase = {
    realtime: { setAuth: () => undefined },
    removeChannel: () => undefined,
    channel: (topic: string) => {
      const record = channels.get(topic) ?? { sent: [], listeners: [] }
      channels.set(topic, record)
      const channel = {
        topic,
        on: (_kind: string, _filter: unknown, callback: (payload: unknown) => void) => {
          record.listeners.push(callback)
          return channel
        },
        subscribe: () => channel,
        send: async (message: { payload: unknown }) => {
          record.sent.push(message.payload)
          return 'ok'
        },
      }
      return channel
    },
  }
  const say = (topic: string, payload: unknown) => channels.get(topic)!.listeners.forEach((listener) => listener({ type: 'broadcast', event: 'broadcast', payload }))
  return { supabase, channels, say }
}

const SHARED = 'gugu:dev-1:rpc'
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => vi.useRealTimers())

describe('共用 topic', () => {
  it('不报到直接问(协议 9 以前的咕咕):回 client_outdated,❌ 办', async () => {
    const { supabase, channels, say } = fakeSupabase()
    const handler = vi.fn(() => ({ result: 1 }))
    const subscribe = createDesktopDeviceRpcSubscription({
      supabase: supabase as never,
      warn: () => undefined,
      createHandlers: () => ({ handlers: { 'taskhost.call': handler }, dispose: () => undefined }),
    })
    await subscribe({ deviceId: 'dev-1', accessToken: 'token' } as never)
    say(SHARED, { type: 'taskhost.call', request_id: 'r1', user_id: 'u1', payload: {} })
    await settle()
    expect(handler).not.toHaveBeenCalled()
    expect(channels.get(SHARED)!.sent).toEqual([expect.objectContaining({ type: 'taskhost.call:reply', request_id: 'r1', error: expect.objectContaining({ code: 'client_outdated' }) })])
  })

  it('库里中转来的 MessagePreview(taskpage.preview.*,#6357)照常在共用 topic 上收', async () => {
    const { supabase, say } = fakeSupabase()
    const handler = vi.fn(() => ({ result: { ok: true } }))
    const subscribe = createDesktopDeviceRpcSubscription({
      supabase: supabase as never,
      warn: () => undefined,
      createHandlers: () => ({ handlers: { 'taskpage.preview.subscribe': handler }, dispose: () => undefined }),
    })
    await subscribe({ deviceId: 'dev-1', accessToken: 'token' } as never)
    say(SHARED, { type: 'taskpage.preview.subscribe', request_id: 'p1', user_id: 'viewer', payload: { chatId: 'c' } })
    await settle()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('报到:订上那个发问端自己的 topic(gugu:<dev>:rpc:<asker>)', async () => {
    const { supabase, channels, say } = fakeSupabase()
    const subscribe = createDesktopDeviceRpcSubscription({ supabase: supabase as never, warn: () => undefined })
    await subscribe({ deviceId: 'dev-1', accessToken: 'token' } as never)
    say(SHARED, { type: 'taskhost.attach', request_id: 'a1', user_id: 'u1', payload: { asker: 'askerAAAA1111', protocol: 9 } })
    expect([...channels.keys()]).toEqual([SHARED, `${SHARED}:askerAAAA1111`])
  })

  it('每 60 s 在共用 topic 上发一条 alive(订阅方的看门狗靠它,#840);收摊后不再发', async () => {
    vi.useFakeTimers()
    const { supabase, channels } = fakeSupabase()
    const subscribe = createDesktopDeviceRpcSubscription({ supabase: supabase as never, warn: () => undefined })
    const stop = await subscribe({ deviceId: 'dev-1', accessToken: 'token' } as never)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(channels.get(SHARED)!.sent).toEqual([{ type: 'taskhost.alive' }])
    stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(channels.get(SHARED)!.sent).toHaveLength(1)
  })
})
