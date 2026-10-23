// #7233 宿主这一侧:每个报到过的发问端一条 `gugu:<dev>:rpc:<asker>`(apps/desktop/electron/device-rpc-askers.ts)。
// 替身只换掉 Supabase 频道与「订上」那一步;排队、让位、空闲、alive、离开前说 detached 全是产品代码。
import { describe, expect, it, vi } from 'vitest'
import { REMOTE_PROTOCOL_VERSION } from '../../../../packages/core/src/cloud/serverMachineHealth'

type Status = (status: string, err?: Error) => void
const subs = vi.hoisted(() => ({
  list: [] as { topic: string; onStatus: Status; stopped: boolean }[],
  /** 设了就让退订挂着,直到叫它(那条「还在退」)。 */
  slowLeave: null as null | { finish: (() => void)[] },
}))
vi.mock('../../../../apps/desktop/electron/realtime-channel', async (importOriginal) => ({
  // sendBroadcast 用产品那一份(把 send 回的 'error' 变成失败);只换「订上」那一步。
  ...(await importOriginal<typeof import('../../../../apps/desktop/electron/realtime-channel')>()),
  subscribeAuthenticatedElectronRealtimeChannel: async (_client: unknown, channel: { topic: string }, options: { onStatus: Status }) => {
    const sub = { topic: channel.topic, onStatus: options.onStatus, stopped: false }
    subs.list.push(sub)
    return () => {
      sub.stopped = true
      const slow = subs.slowLeave
      return slow ? new Promise<void>((resolve) => slow.finish.push(resolve)) : Promise.resolve()
    }
  },
}))

import { createDeviceRpcAskers, deviceRpcAskerLimitsFromEnv, DEVICE_RPC_ASKER_LIMITS } from '../../../../apps/desktop/electron/device-rpc-askers'

type FakeChannel = { topic: string; sent: unknown[]; listeners: ((payload: unknown) => void)[]; reply: string }

function fakeHost(limits: Partial<typeof DEVICE_RPC_ASKER_LIMITS> = {}) {
  subs.list.length = 0
  subs.slowLeave = null
  const channels: FakeChannel[] = []
  const supabase = {
    realtime: { setAuth: () => undefined },
    removeChannel: () => undefined,
    channel: (topic: string) => {
      const record: FakeChannel = { topic, sent: [], listeners: [], reply: 'ok' }
      channels.push(record)
      const channel = {
        topic,
        on: (_kind: string, _filter: unknown, callback: (payload: unknown) => void) => {
          record.listeners.push(callback)
          return channel
        },
        subscribe: () => channel,
        // realtime-js 的 send:从不 reject,被拒 / 没等到确认时回 'error' / 'timed out'。
        send: async (message: { payload: unknown }) => {
          record.sent.push(message.payload)
          return record.reply
        },
      }
      return channel
    },
  }
  let t = 0
  const shared: unknown[] = []
  const handled: { payload: unknown; asker: string }[] = []
  const handle = vi.fn(async (payload: unknown, reply: (p: unknown) => unknown, event: (p: unknown) => unknown, asker: { id: string; onDetached(cb: () => void): () => void }) => {
    handled.push({ payload, asker: asker.id })
    const body = (payload as { payload: { type: string; request_id: string; payload?: { events?: string[]; window?: boolean } } }).payload
    for (const name of body.payload?.events ?? []) event({ type: 'taskhost.frame', name })
    if (body.payload?.window) asker.onDetached(() => closedWindows.push(asker.id))
    reply({ type: `${body.type}:reply`, request_id: body.request_id, result: { ok: true } })
  })
  const closedWindows: string[] = []
  const warnings: string[] = []
  const askers = createDeviceRpcAskers({
    supabase: supabase as never,
    accessToken: 'token',
    deviceId: 'dev',
    handle: handle as never,
    replyShared: (reply) => { shared.push(reply) },
    limits: { ...DEVICE_RPC_ASKER_LIMITS, ...limits },
    now: () => t,
    detachGraceMs: 0,
    warn: (line) => { warnings.push(line) },
  })
  const channelOf = (asker: string) => channels.filter((c) => c.topic === `gugu:dev:rpc:${asker}`).at(-1)!
  const subOf = (asker: string) => subs.list.filter((s) => s.topic === `gugu:dev:rpc:${asker}`).at(-1)!
  const attach = (asker: string, requestId = `attach-${asker}`, protocol = REMOTE_PROTOCOL_VERSION) =>
    askers.attach({ type: 'taskhost.attach', request_id: requestId, user_id: 'u1', payload: { asker, protocol } })
  const ask = (asker: string, requestId: string, payload: unknown = {}) =>
    channelOf(asker).listeners.forEach((listener) => listener({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskhost.call', request_id: requestId, user_id: 'u1', payload } }))
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return { askers, channels, channelOf, subOf, attach, ask, shared, handled, handle, closedWindows, warnings, settle, setNow: (value: number) => { t = value } }
}

const types = (sent: unknown[]) => sent.map((p) => (p as { type: string }).type)

describe('报到:宿主订上那个发问端的线,在那条上回', () => {
  it('订上之前要发的(报到应答、一问的推送与应答)全按先后排着,订上后照原序发完', async () => {
    const host = fakeHost()
    host.attach('askerAAAA1111')
    expect(host.channelOf('askerAAAA1111').sent).toEqual([])
    host.ask('askerAAAA1111', 'r1', { events: ['e1', 'e2', 'e3'] })
    await host.settle()
    expect(host.channelOf('askerAAAA1111').sent).toEqual([])

    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    const sent = host.channelOf('askerAAAA1111').sent as { type: string; name?: string; request_id?: string }[]
    expect(sent.map((p) => p.name ?? p.type)).toEqual(['taskhost.attach:reply', 'e1', 'e2', 'e3', 'taskhost.call:reply'])
    expect(sent[0]).toMatchObject({ request_id: 'attach-askerAAAA1111', result: { attached: true, protocol: REMOTE_PROTOCOL_VERSION } })
    expect(host.shared).toEqual([])
  })

  it('这条上来的一问交给处理器,带着发问端;应答与推送只回这条', async () => {
    const host = fakeHost()
    host.attach('askerAAAA1111')
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    host.ask('askerAAAA1111', 'r1', { events: ['e1'] })
    await host.settle()
    expect(host.handled).toEqual([{ payload: expect.anything(), asker: 'askerAAAA1111' }])
    expect(types(host.channelOf('askerAAAA1111').sent)).toEqual(['taskhost.attach:reply', 'taskhost.frame', 'taskhost.call:reply'])
  })

  it('报到报的协议比这台机器要的旧 / id 不合法:在共用 topic 上拒(client_outdated / invalid_payload),❌ 开线', () => {
    const host = fakeHost()
    host.attach('askerAAAA1111', 'old', 10)
    host.askers.attach({ type: 'taskhost.attach', request_id: 'bad', user_id: 'u1', payload: { asker: 'has:colon', protocol: REMOTE_PROTOCOL_VERSION } })
    expect(host.shared).toEqual([
      expect.objectContaining({ request_id: 'old', error: expect.objectContaining({ code: 'client_outdated' }) }),
      expect.objectContaining({ request_id: 'bad', error: expect.objectContaining({ code: 'invalid_payload' }) }),
    ])
    expect(host.channels).toEqual([])
  })
})

describe('离开:先在那条上说 detached,经它开的窗口一并关掉', () => {
  it('满了(maxAskers 2):第三个报到时,最久没问过的那个离开,新来的开线', async () => {
    const host = fakeHost({ maxAskers: 2 })
    host.setNow(1)
    host.attach('askerAAAA1111')
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    host.ask('askerAAAA1111', 'r1', { window: true })
    host.setNow(2)
    host.attach('askerBBBB2222')
    host.subOf('askerBBBB2222').onStatus('SUBSCRIBED')
    await host.settle()
    host.setNow(3)
    host.attach('askerCCCC3333')
    await host.settle()
    expect(host.askers.ids()).toEqual(['askerBBBB2222', 'askerCCCC3333'])
    expect(host.channelOf('askerAAAA1111').sent.at(-1)).toEqual({ type: 'taskhost.detached', reason: 'make_room' })
    expect(host.closedWindows).toEqual(['askerAAAA1111'])
    expect(host.subOf('askerAAAA1111').stopped).toBe(true)
    expect(host.subOf('askerBBBB2222').stopped).toBe(false)
  })

  it('一帧发不出去(send 回 error):响亮记下并离开这条(send_failed),经它开的窗口一并关掉,❌ 当成发出去了', async () => {
    const host = fakeHost()
    host.attach('askerAAAA1111')
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    host.ask('askerAAAA1111', 'r1', { window: true })
    await host.settle()
    expect(host.askers.ids()).toEqual(['askerAAAA1111'])
    host.channelOf('askerAAAA1111').reply = 'error'
    host.ask('askerAAAA1111', 'r2', { events: ['frame'] })
    await host.settle()
    await host.settle()
    expect(host.askers.ids()).toEqual([])
    expect(host.closedWindows).toEqual(['askerAAAA1111'])
    expect(host.subOf('askerAAAA1111').stopped).toBe(true)
    expect(host.warnings.some((line) => /send failed on askerAAA.*not delivered: error/.test(line))).toBe(true)
  })

  it('idleMs 里一问都没有:离开(idle);离开之后这条上的推送丢掉,❌ 再发', async () => {
    const host = fakeHost({ idleMs: 1_000 })
    host.attach('askerAAAA1111')
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    host.setNow(999)
    host.askers.sweep()
    expect(host.askers.ids()).toEqual(['askerAAAA1111'])
    host.setNow(1_000)
    host.askers.sweep()
    await host.settle()
    expect(host.askers.ids()).toEqual([])
    const sent = host.channelOf('askerAAAA1111').sent
    expect(sent.at(-1)).toEqual({ type: 'taskhost.detached', reason: 'idle' })
    host.ask('askerAAAA1111', 'late')
    await host.settle()
    expect(host.handle).not.toHaveBeenCalled()
  })

  it('一直订不上、排的帧超了上限:离开这条(没订上就没法说 detached),发问端下一问会重新报到', async () => {
    const host = fakeHost({ queueFrames: 3 })
    host.attach('askerAAAA1111')
    host.ask('askerAAAA1111', 'r1', { events: ['e1', 'e2', 'e3'] })
    await host.settle()
    expect(host.askers.ids()).toEqual([])
    expect(host.subOf('askerAAAA1111').stopped).toBe(true)
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    expect(host.channelOf('askerAAAA1111').sent).toEqual([])
  })

  it('宿主收摊:全部离开(host_closed)', async () => {
    const host = fakeHost()
    for (const id of ['askerAAAA1111', 'askerBBBB2222']) {
      host.attach(id)
      host.subOf(id).onStatus('SUBSCRIBED')
    }
    host.askers.dispose()
    await host.settle()
    expect(host.askers.ids()).toEqual([])
    for (const id of ['askerAAAA1111', 'askerBBBB2222']) expect(host.channelOf(id).sent.at(-1)).toEqual({ type: 'taskhost.detached', reason: 'host_closed' })
  })

  // realtime-js 的 channel(topic) 在同名那条退完之前把它交回来:那时开的新线订在要退的那条上,随它一起没了。
  it('刚离开、那条还没退完时同一个发问端又报到:等退完再开新线,订上后在新线上回报到', async () => {
    const host = fakeHost({ idleMs: 1_000 })
    host.attach('askerAAAA1111')
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    subs.slowLeave = { finish: [] }
    host.setNow(1_000)
    host.askers.sweep()
    await host.settle()
    expect(host.subOf('askerAAAA1111').stopped).toBe(true)

    host.attach('askerAAAA1111', 'attach-again')
    await host.settle()
    expect(host.channels.filter((c) => c.topic === 'gugu:dev:rpc:askerAAAA1111')).toHaveLength(1)

    subs.slowLeave.finish.splice(0).forEach((finish) => finish())
    await host.settle()
    expect(host.channels.filter((c) => c.topic === 'gugu:dev:rpc:askerAAAA1111')).toHaveLength(2)
    expect(host.askers.ids()).toEqual(['askerAAAA1111'])
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    expect(host.channelOf('askerAAAA1111').sent).toEqual([expect.objectContaining({ type: 'taskhost.attach:reply', request_id: 'attach-again' })])
  })

  it('已经在离开时才登记窗口:下一拍叫它关,❌ 同步叫(登记的一方可能还没登记完)', async () => {
    const host = fakeHost({ maxAskers: 1 })
    host.attach('askerAAAA1111')
    let context: { onDetached(cb: () => void): () => void } | null = null
    host.handle.mockImplementationOnce(async (_payload, _reply, _event, asker) => { context = asker })
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    host.ask('askerAAAA1111', 'r1')
    await host.settle()
    host.attach('askerBBBB2222')
    const closed = vi.fn()
    context!.onDetached(closed)
    expect(closed).not.toHaveBeenCalled()
    await host.settle()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('alive', () => {
  it('只在订上了的线上发', () => {
    const host = fakeHost()
    host.attach('askerAAAA1111')
    host.attach('askerBBBB2222')
    host.subOf('askerAAAA1111').onStatus('SUBSCRIBED')
    host.askers.alive()
    expect(types(host.channelOf('askerAAAA1111').sent)).toEqual(['taskhost.attach:reply', 'taskhost.alive'])
    expect(host.channelOf('askerBBBB2222').sent).toEqual([])
  })
})

describe('测试装置的上限', () => {
  it('只在 GUGU_SESSION_TEST_HOOKS=1 时读环境变量', () => {
    const env = { GUGU_TEST_DEVICE_RPC_MAX_ASKERS: '2', GUGU_TEST_DEVICE_RPC_ASKER_IDLE_MS: '30000' }
    expect(deviceRpcAskerLimitsFromEnv(env)).toEqual(DEVICE_RPC_ASKER_LIMITS)
    expect(deviceRpcAskerLimitsFromEnv({ ...env, GUGU_SESSION_TEST_HOOKS: '1' })).toEqual({ ...DEVICE_RPC_ASKER_LIMITS, maxAskers: 2, idleMs: 30_000 })
  })
})
