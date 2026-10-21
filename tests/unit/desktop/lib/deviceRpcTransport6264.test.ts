/**
 * #6264「远程 SSH 与远程隧道是两个服务，各走各的通道」:设备 RPC 客户端是全 app 唯一挑通道的地方。
 *  · 远程 SSH 的机器(这台桌面上有它的 SSH 映射)→ 设备连接,字节只走 SSH,连不上 ❌ 退回咕咕云;
 *  · 其余 → 咕咕云 Realtime 频道。
 * 替身只换掉两头「字节真的出去」的那一步(主进程 IPC、Supabase 频道),配对 / 推送分发全是产品代码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { awaitPending } from '../../../support/awaitFact'

type CloudSubscription = { label: string; shouldSubscribe: () => boolean; onSubscribed: () => void; onStatus: (status: string, error?: Error) => void }

const cloud = vi.hoisted(() => ({
  channels: [] as string[],
  sent: [] as unknown[],
  /** 同一批,带上发在哪条 topic 上(上一条用例留下的问超时后会重新报到、重发,按机器认才不混进来)。 */
  sentOn: [] as { topic: string; message: { payload: { type: string; request_id: string } } }[],
  subscriptions: [] as CloudSubscription[],
  unsubscribed: 0,
  /** 每条 topic 上的广播监听(替身里的「这台机器」往发问端自己那条回报到应答用)。 */
  listeners: new Map<string, (payload: unknown) => void>(),
  /** 这一类的问,第二次来才回(第一次当没收到):一问超时后重新报到、原样重发的那一次。 */
  answerSecondOf: null as string | null,
  seenRequests: new Set<string>(),
  /** 设了就让退订挂着,直到叫它(那条「还在退」)。 */
  slowLeave: null as null | (() => void)[],
}))

/**
 * 两头的替身每记下一笔(开频道、发出去、开设备连接)就叫醒等待者:等的是「那一笔记下了」这个事实,
 * ❌ 按 5ms 轮询、到 2 秒就不再等(到点也不报错,直接落进下面的断言)。
 */
const records = vi.hoisted(() => {
  const waiters = new Set<{ ok: () => boolean; done: () => void }>()
  return {
    waiters,
    note(): void {
      for (const waiter of [...waiters]) {
        if (!waiter.ok()) continue
        waiters.delete(waiter)
        waiter.done()
      }
    },
  }
})

vi.mock('@/lib/supabase', () => ({
  getCurrentAuthUserId: async () => 'user-1',
  dataClient: {
    channel: (name: string) => {
      cloud.channels.push(name)
      records.note()
      const channel = {
        on: (_kind: string, _filter: unknown, listener: (payload: unknown) => void) => {
          cloud.listeners.set(name, listener)
          return channel
        },
        send: async (message: unknown) => {
          cloud.sent.push(message)
          cloud.sentOn.push({ topic: name, message: message as (typeof cloud.sentOn)[number]['message'] })
          records.note()
          // #7233 这台机器(协议 9)收到报到:在那个发问端自己的 topic 上回。
          const envelope = (message as { payload?: { type?: string; request_id?: string; payload?: { asker?: string } } }).payload
          if (envelope?.type === 'taskhost.attach') {
            const mine = `${name}:${envelope.payload?.asker}`
            setTimeout(() => cloud.listeners.get(mine)?.({
              type: 'broadcast',
              event: 'broadcast',
              payload: { type: 'taskhost.attach:reply', request_id: envelope.request_id, result: { attached: true, protocol: 9 } },
            }), 0)
          }
          if (envelope?.type && envelope.type === cloud.answerSecondOf && envelope.request_id) {
            const again = cloud.seenRequests.has(envelope.request_id)
            cloud.seenRequests.add(envelope.request_id)
            if (again) {
              setTimeout(() => cloud.listeners.get(name)?.({
                type: 'broadcast',
                event: 'broadcast',
                payload: { type: `${envelope.type}:reply`, request_id: envelope.request_id, result: { asked: 2 } },
              }), 0)
            }
          }
          return 'ok'
        },
      }
      return channel
    },
  },
}))
vi.mock('@/lib/realtimeSessionManager', () => ({ observeRealtimeAuth: () => () => undefined }))
vi.mock('@/lib/realtimeChannel', () => ({
  subscribeAuthenticatedRealtimeChannel: (create: () => unknown, label: string, options: Omit<CloudSubscription, 'label'>) => {
    const channel = create()
    cloud.subscriptions.push({ ...options, label })
    setTimeout(() => options.onSubscribed(), 0)
    return channel
  },
  unsubscribeAuthenticatedRealtimeChannel: () => {
    cloud.unsubscribed += 1
    const slow = cloud.slowLeave
    return slow ? new Promise<void>((resolve) => slow.push(resolve)) : Promise.resolve()
  },
}))

type Listener = (data: unknown) => void

function fakeMainProcess(options: { sshMachines: string[]; open?: (deviceId: string) => unknown }) {
  const listeners = new Map<string, Set<Listener>>()
  const sent: Array<{ deviceId: string; message: { payload: { type: string; request_id: string; payload: unknown } } }> = []
  const opened: string[] = []
  const emit = (channel: string, data: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(data)
  }
  const api = {
    invoke: async (channel: string, arg: unknown) => {
      if (channel === 'server-ssh-machines:list') return options.sshMachines
      if (channel === 'ssh-link:open') {
        opened.push(arg as string)
        records.note()
        return options.open ? options.open(arg as string) : { ok: true }
      }
      if (channel === 'ssh-link:send') {
        sent.push(arg as (typeof sent)[number])
        records.note()
        return true
      }
      return undefined
    },
    eventOn: (channel: string, cb: Listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(cb)
      listeners.set(channel, set)
      return () => set.delete(cb)
    },
  }
  return { api, sent, opened, emit }
}

/** 咕咕云上发出去的、某一类的请求(报到不算)。 */
const sentOf = (type: string) =>
  (cloud.sent as Array<{ payload: { type: string; request_id: string } }>).filter((m) => m.payload.type === type)
/** 发到这台机器(它的两条 topic)上的、某一类的问。 */
const sentTo = (device: string, type: string) =>
  cloud.sentOn.filter((s) => (s.topic === `gugu:${device}:rpc` || s.topic.startsWith(`gugu:${device}:rpc:`)) && s.message.payload.type === type).map((s) => s.message)
const ASKER_TOPIC = (device: string) => expect.stringMatching(new RegExp(`^gugu:${device}:rpc:[A-Za-z0-9_-]{8,64}$`))
/**
 * 这台机器的共用频道 / 这个发问端自己那条的订阅,按名字认:上一条用例留下的问(超时后重新报到、重发一次)可能晚一步才在这里
 * 开频道,❌ 按下标认。
 */
const sharedSub = (device: string) => cloud.subscriptions.find((sub) => sub.label === `device-rpc:${device}:rpc`)!
const askerSub = (device: string) => cloud.subscriptions.find((sub) => sub.label.startsWith(`device-rpc:${device}:rpc:`))!

function whenRecorded(step: string, ok: () => boolean): Promise<void> {
  return ok() ? Promise.resolve() : awaitPending(step, new Promise<void>((done) => { records.waiters.add({ ok, done }) }))
}

async function load(main: ReturnType<typeof fakeMainProcess>) {
  vi.resetModules()
  ;(globalThis as Record<string, unknown>).window = { electronAPI: main.api }
  return import('@/lib/deviceRpc')
}

describe('设备 RPC 按机器挑通道', () => {
  beforeEach(() => {
    cloud.channels.length = 0
    cloud.sent.length = 0
    cloud.sentOn.length = 0
    cloud.subscriptions.length = 0
    cloud.unsubscribed = 0
    cloud.listeners.clear()
    cloud.answerSecondOf = null
    cloud.seenRequests.clear()
    cloud.slowLeave = null
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('远程 SSH 的机器:请求走设备连接(与云端同一种信封),应答从设备连接回来;咕咕云一个字都没碰', async () => {
    const main = fakeMainProcess({ sshMachines: ['ssh-box'] })
    const { callDeviceRpc } = await load(main)
    const pending = callDeviceRpc<{ ok: number }>('ssh-box', 'taskpage.settings.call', { op: 'read' })
    await whenRecorded('请求经设备连接发出', () => main.sent.length > 0)
    expect(main.opened).toEqual(['ssh-box'])
    expect(main.sent).toHaveLength(1)
    const { deviceId, message } = main.sent[0]!
    expect(deviceId).toBe('ssh-box')
    expect(message).toMatchObject({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskpage.settings.call', payload: { op: 'read' } } })
    main.emit('ssh-link:message', {
      deviceId: 'ssh-box',
      message: { type: 'broadcast', event: 'broadcast', payload: { type: 'taskpage.settings.call:reply', request_id: message.payload.request_id, result: { ok: 1 } } },
    })
    await expect(pending).resolves.toEqual({ result: { ok: 1 }, error: undefined })
    expect(cloud.channels).toEqual([])
    expect(cloud.sent).toEqual([])
  })

  it('远程隧道 / 别的桌面 / 别的电脑用远程 SSH 加的(这台没有映射):走咕咕云频道 —— 在共用 topic 上报到,在自己那条上问(#7233)', async () => {
    const main = fakeMainProcess({ sshMachines: ['ssh-box'] })
    const { callDeviceRpc } = await load(main)
    void callDeviceRpc('tunnel-box', 'taskpage.sessions.list', {}, { timeoutMs: 2_000 }).catch(() => undefined)
    await whenRecorded('请求经咕咕云频道发出', () => sentOf('taskpage.sessions.list').length > 0)
    expect(cloud.channels).toEqual(['gugu:tunnel-box:rpc', ASKER_TOPIC('tunnel-box')])
    expect((cloud.sent as Array<{ payload: { type: string } }>).map((m) => m.payload.type)).toEqual(['taskhost.attach', 'taskpage.sessions.list'])
    expect(main.opened).toEqual([])
  })

  it('库拒绝读这台设备的频道(设备已不在账号名下):当场拆掉、在途的问失败,❌ 留给 Realtime 循环重订;断线照旧交给它', async () => {
    const main = fakeMainProcess({ sshMachines: [] })
    const { callDeviceRpc } = await load(main)
    const pending = callDeviceRpc('gone-box', 'taskpage.sessions.list', {}, { timeoutMs: 2_000 })
    await whenRecorded('请求经咕咕云频道发出', () => sentOf('taskpage.sessions.list').length > 0)
    const subscription = sharedSub('gone-box')
    subscription!.onStatus('CHANNEL_ERROR', new Error('"socket closed"'))
    expect(subscription!.shouldSubscribe()).toBe(true)
    expect(cloud.unsubscribed).toBe(0)

    const forbidden = new Error('"Unauthorized: You do not have permissions to read from this Channel topic: gugu:gone-box:rpc"')
    subscription!.onStatus('CHANNEL_ERROR', forbidden)
    await expect(pending).rejects.toBe(forbidden)
    expect(subscription!.shouldSubscribe()).toBe(false)
    // 两条(共用的、自己的)一起拆。
    await whenRecorded('两条都拆掉', () => cloud.unsubscribed === 2)

    void callDeviceRpc('gone-box', 'taskpage.sessions.list', {}, { timeoutMs: 50 }).catch(() => undefined)
    await whenRecorded('重新开了一次频道', () => cloud.channels.filter((name) => name === 'gugu:gone-box:rpc').length >= 2)
    expect(cloud.channels.slice(0, 3)).toEqual(['gugu:gone-box:rpc', ASKER_TOPIC('gone-box'), 'gugu:gone-box:rpc'])
  })

  // #6737:断着发出去的问,应答回来时这边不在频道上,只能干等到超时。#7233 之后:断着时照旧不发;重新订上了 = 这条管道
  // 作废(断着那段的帧可能丢了),在途的问换一条新管道(两条重新订、重新报到)原样重发一次 —— 同一个 request_id,宿主去重。
  it('连上过又断了(手机切去系统选择器再回来):断着时不发;重新订上后换新管道,这一问原样发一次,应答回来就算数', async () => {
    const main = fakeMainProcess({ sshMachines: [] })
    const { callDeviceRpc, _injectDeviceRpcReplyForTesting } = await load(main)
    void callDeviceRpc('picker-box', 'taskpage.session.subscribe', {}, { timeoutMs: 2_000 }).catch(() => undefined)
    await whenRecorded('第一问经咕咕云频道发出', () => sentOf('taskpage.session.subscribe').length === 1)
    const mine = askerSub('picker-box')
    mine.onStatus('CHANNEL_ERROR', new Error('"socket closed"'))

    const pending = callDeviceRpc<{ received: number }>('picker-box', 'taskpage.attachment.chunk', { offset: 0 }, { timeoutMs: 2_000 })
    // 让这一问把不用等频道的那几步都走完(全是微任务),再看它发没发。
    await new Promise((settled) => setTimeout(settled, 0))
    expect(sentOf('taskpage.attachment.chunk')).toHaveLength(0)

    mine.onSubscribed()
    await whenRecorded('换上新管道后这一问发出', () => sentOf('taskpage.attachment.chunk').length === 1)
    expect(cloud.channels.filter((name) => name === 'gugu:picker-box:rpc')).toHaveLength(2)
    const { payload } = sentOf('taskpage.attachment.chunk')[0]!
    _injectDeviceRpcReplyForTesting('picker-box', {
      type: 'broadcast',
      event: 'broadcast',
      payload: { type: 'taskpage.attachment.chunk:reply', request_id: payload.request_id, result: { received: 27 } },
    })
    await expect(pending).resolves.toEqual({ result: { received: 27 }, error: undefined })
    expect(sentOf('taskpage.attachment.chunk')).toHaveLength(1)
  })

  // 10-16 mac1:宿主重启后手机那一页一句都问不出去 —— 咕咕云这条管道的 recover 没交到请求方手里,超时的一问不会重新报到。
  // 等的是这一问自己的结局(第二次回了 = 成;没重发 = 到期超时),❌ 等一件可能永远不来的事。
  it('咕咕云:一问没回 ⇒ 重新报到、原样重发一次(同一个 request_id),第二次回了就算数(#7233)', async () => {
    cloud.answerSecondOf = 'taskpage.session.send'
    const main = fakeMainProcess({ sshMachines: [] })
    const { callDeviceRpc } = await load(main)
    const reply = await callDeviceRpc('quiet-box', 'taskpage.session.send', { text: 'hi' }, { timeoutMs: 200 })
    expect(reply).toEqual({ result: { asked: 2 }, error: undefined })
    expect(sentTo('quiet-box', 'taskhost.attach')).toHaveLength(2)
    const ids = sentTo('quiet-box', 'taskpage.session.send').map((m) => m.payload.request_id)
    expect(ids).toEqual([ids[0], ids[0]])
  })

  // realtime-js 的 channel(topic) 在同名那条退完之前把它交回来(订在上面等不到 SUBSCRIBED):宿主重启那一声 ready 一来,
  // 自己那条当场退,紧接着的下一问要等它退完才开新的那条。
  it('咕咕云:宿主重启(ready)后自己那条还在退,下一问等它退完再开新的、再报到', async () => {
    const main = fakeMainProcess({ sshMachines: [] })
    const { callDeviceRpc, _injectDeviceRpcReplyForTesting } = await load(main)
    const asks = () => sentTo('ready-box', 'taskpage.sessions.list')
    const answer = (n: number) => _injectDeviceRpcReplyForTesting('ready-box', {
      type: 'broadcast',
      event: 'broadcast',
      payload: { type: 'taskpage.sessions.list:reply', request_id: asks()[n]!.payload.request_id, result: { ok: 1 } },
    })
    const first = callDeviceRpc('ready-box', 'taskpage.sessions.list', {}, { timeoutMs: 2_000 })
    await whenRecorded('第一问发出', () => asks().length === 1)
    answer(0)
    await first
    const mineTopics = () => cloud.channels.filter((name) => /^gugu:ready-box:rpc:/.test(name))
    expect(mineTopics()).toHaveLength(1)

    const leaves: (() => void)[] = []
    cloud.slowLeave = leaves
    cloud.listeners.get('gugu:ready-box:rpc')!({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskhost.ready' } })
    const pending = callDeviceRpc<{ ok: number }>('ready-box', 'taskpage.sessions.list', {}, { timeoutMs: 2_000 })
    await new Promise((settled) => setTimeout(settled, 0))
    expect(leaves).toHaveLength(1)
    expect(mineTopics()).toHaveLength(1)

    cloud.slowLeave = null
    leaves.splice(0).forEach((finish) => finish())
    await whenRecorded('退完后这一问发出', () => asks().length === 2)
    expect(mineTopics()).toHaveLength(2)
    expect(sentTo('ready-box', 'taskhost.attach')).toHaveLength(2)
    answer(1)
    await expect(pending).resolves.toEqual({ result: { ok: 1 }, error: undefined })
  })

  it('远程 SSH 的机器连不上:如实报原因(要先登录),❌ 退回咕咕云', async () => {
    const main = fakeMainProcess({ sshMachines: ['ssh-box'], open: () => ({ ok: false, reason: 'signInRequired' }) })
    const { callDeviceRpc } = await load(main)
    await expect(callDeviceRpc('ssh-box', 'taskpage.sessions.list', {})).rejects.toMatchObject({ code: 'ssh_sign_in_required' })
    expect(cloud.channels).toEqual([])
  })

  it('接上之后断了:在途的问当场失败;还有人听推送就隔一会儿重开,接上后通知订阅者补缺口', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const main = fakeMainProcess({ sshMachines: ['ssh-box'] })
      const { callDeviceRpc, subscribeDeviceRpcEvents } = await load(main)
      const resubscribed = vi.fn()
      const events: unknown[] = []
      subscribeDeviceRpcEvents('ssh-box', (payload) => events.push(payload), { onChannelResubscribed: resubscribed })
      await vi.advanceTimersByTimeAsync(5)
      expect(resubscribed).toHaveBeenCalledTimes(1)
      main.emit('ssh-link:message', { deviceId: 'ssh-box', message: { type: 'broadcast', event: 'broadcast', payload: { type: 'taskpage.session.event', n: 1 } } })
      expect(events).toHaveLength(1)

      const pending = callDeviceRpc('ssh-box', 'taskpage.session.send', { text: 'hi' })
      await vi.advanceTimersByTimeAsync(5)
      main.emit('ssh-link:closed', { deviceId: 'ssh-box', reason: 'unreachable' })
      await expect(pending).rejects.toMatchObject({ code: 'ssh_unreachable' })
      expect(main.opened).toEqual(['ssh-box'])
      await vi.advanceTimersByTimeAsync(2_100)
      expect(main.opened).toEqual(['ssh-box', 'ssh-box'])
      expect(resubscribed).toHaveBeenCalledTimes(2)
      // 每次都是新开的连接,旧连接上在途的问已当场失败(上面的 pending):不是「同一条断过又订上」。
      expect(resubscribed.mock.calls).toEqual([[false], [false]])
      expect(cloud.channels).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  // 冷启动实撞(手机点进一台机器晚 5 s):频道头一回订上被当成「重接」,开线那一问被放弃。头一回订上 rejoin=false,
  // 同一条管道断过又订上才是 true。
  it('咕咕云:同一条管道头一回订上报 rejoin=false,断过又订上报 true', async () => {
    const main = fakeMainProcess({ sshMachines: [] })
    const { subscribeDeviceRpcEvents } = await load(main)
    const resubscribed = vi.fn()
    subscribeDeviceRpcEvents('cloud-box', () => undefined, { onChannelResubscribed: resubscribed })
    for (let i = 0; i < 50 && resubscribed.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 0))
    expect(resubscribed.mock.calls).toEqual([[false]])
    sharedSub('cloud-box').onSubscribed()
    expect(resubscribed.mock.calls).toEqual([[false], [true]])
  })
})
