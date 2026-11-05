/**
 * #6264「远程 SSH 与远程隧道是两个服务，各走各的通道」:设备 RPC 客户端是全 app 唯一挑通道的地方。
 *  · 远程 SSH 的机器(这台桌面上有它的 SSH 映射)→ 设备连接,字节只走 SSH,连不上 ❌ 退回咕咕云;
 *  · 其余 → 咕咕云 Realtime 频道。
 * 替身只换掉两头「字节真的出去」的那一步(主进程 IPC、Supabase 频道),配对 / 推送分发全是产品代码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_PROTOCOL_VERSION } from '../../../../packages/core/src/cloud/serverMachineHealth'
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
          // #7233 当前宿主收到报到:在那个发问端自己的 topic 上回。
          const envelope = (message as { payload?: { type?: string; request_id?: string; payload?: { asker?: string } } }).payload
          if (envelope?.type === 'taskhost.attach') {
            const mine = `${name}:${envelope.payload?.asker}`
            setTimeout(() => cloud.listeners.get(mine)?.({
              type: 'broadcast',
              event: 'broadcast',
              payload: { type: 'taskhost.attach:reply', request_id: envelope.request_id, result: { attached: true, protocol: REMOTE_PROTOCOL_VERSION } },
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
  const closed: string[] = []
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
      if (channel === 'ssh-link:close') {
        closed.push(arg as string)
        records.note()
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
  return { api, sent, opened, closed, emit }
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

function answerSsh(main: ReturnType<typeof fakeMainProcess>, index: number, response: { result?: unknown; error?: { code: string; message: string } } = { result: { ok: true } }): void {
  const { deviceId, message } = main.sent[index]!
  main.emit('ssh-link:message', { deviceId, message: { payload: { type: `${message.payload.type}:reply`, request_id: message.payload.request_id, ...response } } })
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

  it('does not tear down an SSH handshake that has not become an application pipe yet', async () => {
    vi.useFakeTimers()
    let cleanup: (() => void) | undefined
    try {
      let finish!: () => void
      const ready = new Promise<void>((resolve) => { finish = resolve })
      const main = fakeMainProcess({ sshMachines: ['opening-box'], open: () => ready.then(() => ({ ok: true })) })
      const { callDeviceRpc, _resetDeviceRpcForTesting } = await load(main)
      cleanup = _resetDeviceRpcForTesting
      const first = callDeviceRpc('opening-box', 'taskhost.open', {}, { timeoutMs: 200 }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(200)
      expect(await first).toMatchObject({ name: 'DeviceRpcTimeoutError' })
      expect(main.closed).toEqual([])
      expect(main.sent).toEqual([])
      finish()
      await vi.advanceTimersByTimeAsync(0)

      const second = callDeviceRpc('opening-box', 'taskhost.open', {})
      await vi.advanceTimersByTimeAsync(0)
      expect(main.opened).toEqual(['opening-box'])
      expect(main.sent).toHaveLength(1)
      const request = main.sent[0]!.message.payload
      main.emit('ssh-link:message', { deviceId: 'opening-box', message: { payload: { type: 'taskhost.open:reply', request_id: request.request_id, result: { ok: true } } } })
      await expect(second).resolves.toMatchObject({ result: { ok: true } })
    } finally {
      cleanup?.()
      vi.useRealTimers()
    }
  })

  it('retires a ready SSH pipe after three timeout windows, fails other calls, and reopens without replay', async () => {
    vi.useFakeTimers()
    let cleanup: (() => void) | undefined
    try {
      const main = fakeMainProcess({ sshMachines: ['stalled-box'] })
      const { callDeviceRpc, subscribeDeviceRpcEvents, _resetDeviceRpcForTesting } = await load(main)
      const events = vi.fn()
      const resubscribed = vi.fn()
      const off = subscribeDeviceRpcEvents('stalled-box', events, { onChannelResubscribed: resubscribed })
      cleanup = () => { off(); _resetDeviceRpcForTesting() }
      await vi.advanceTimersByTimeAsync(0)
      expect(main.opened).toEqual(['stalled-box'])

      const inFlight = callDeviceRpc('stalled-box', 'taskpage.session.send', { text: 'once' }, { timeoutMs: 5_000 }).catch((error: unknown) => error)
      for (let window = 1; window <= 3; window += 1) {
        const timedOut = callDeviceRpc('stalled-box', 'taskhost.open', {}, { timeoutMs: 200 }).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(200)
        expect(await timedOut).toMatchObject({ name: 'DeviceRpcTimeoutError' })
        expect(main.closed).toHaveLength(window === 3 ? 1 : 0)
      }
      expect(await inFlight).toMatchObject({ name: 'DeviceRpcChannelError', reason: 'closed' })
      expect(main.closed).toEqual(['stalled-box'])

      await vi.advanceTimersByTimeAsync(2_000)
      expect(main.opened).toEqual(['stalled-box', 'stalled-box'])
      expect(resubscribed.mock.calls).toEqual([[false], [false]])
      expect(main.sent).toHaveLength(4)
      main.emit('ssh-link:message', { deviceId: 'stalled-box', message: { payload: { type: 'taskpage.session.event' } } })
      expect(events).toHaveBeenCalledTimes(1)
      const next = callDeviceRpc('stalled-box', 'taskhost.open', {})
      await vi.advanceTimersByTimeAsync(0)
      answerSsh(main, 4)
      await expect(next).resolves.toMatchObject({ result: { ok: true } })
      expect(cloud.channels).toEqual([])
    } finally {
      cleanup?.()
      vi.useRealTimers()
    }
  })

  it('keeps one or two SSH timeouts isolated and lets later requests and unrelated pending calls succeed', async () => {
    vi.useFakeTimers()
    const main = fakeMainProcess({ sshMachines: ['delay-box'] })
    const rpc = await load(main)
    try {
      const other = rpc.callDeviceRpc('delay-box', 'taskpage.session.send', {}, { timeoutMs: 30_000 }).catch((error: unknown) => error)
      for (let window = 0; window < 2; window += 1) {
        const timedOut = rpc.callDeviceRpc('delay-box', 'taskhost.open', {}).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(await timedOut).toMatchObject({ name: 'DeviceRpcTimeoutError' })
        expect(main.closed).toEqual([])
      }
      const next = rpc.callDeviceRpc('delay-box', 'taskhost.open', {})
      await vi.advanceTimersByTimeAsync(0)
      answerSsh(main, 3)
      answerSsh(main, 0)
      await expect(next).resolves.toMatchObject({ result: { ok: true } })
      await expect(other).resolves.toMatchObject({ result: { ok: true } })
      expect(main.opened).toEqual(['delay-box'])
    } finally {
      rpc._resetDeviceRpcForTesting()
      vi.useRealTimers()
    }
  })

  it('counts five overlapping timeouts during an eight-second stall once, then accepts a reply on the same SSH link', async () => {
    vi.useFakeTimers()
    const main = fakeMainProcess({ sshMachines: ['busy-box'] })
    const rpc = await load(main)
    try {
      const calls = Array.from({ length: 5 }, () => rpc.callDeviceRpc('busy-box', 'read', {}).catch((error: unknown) => error))
      await vi.advanceTimersByTimeAsync(8_000)
      expect(await Promise.all(calls)).toEqual(Array.from({ length: 5 }, () => expect.objectContaining({ name: 'DeviceRpcTimeoutError' })))
      expect(main.closed).toEqual([])
      const recovered = rpc.callDeviceRpc('busy-box', 'read', {})
      await vi.advanceTimersByTimeAsync(0)
      answerSsh(main, 5)
      await expect(recovered).resolves.toMatchObject({ result: { ok: true } })
      expect(main.opened).toEqual(['busy-box'])
    } finally {
      rpc._resetDeviceRpcForTesting()
      vi.useRealTimers()
    }
  })

  it.each([undefined, { code: 'denied', message: 'business refusal' }])('a matching reply (%j) resets two four-second probe timeout windows', async (error) => {
    vi.useFakeTimers()
    const main = fakeMainProcess({ sshMachines: ['probe-box'] })
    const rpc = await load(main)
    try {
      const timeout = async () => {
        const pending = rpc.callDeviceRpc('probe-box', 'taskhost.frame', {}, { timeoutMs: 4_000 }).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(4_000)
        expect(await pending).toMatchObject({ name: 'DeviceRpcTimeoutError' })
      }
      await timeout()
      await timeout()
      expect(main.closed).toEqual([])
      const recovered = rpc.callDeviceRpc('probe-box', 'read', {})
      await vi.advanceTimersByTimeAsync(0)
      answerSsh(main, 2, error ? { error } : { result: { ok: true } })
      await recovered
      await timeout()
      await timeout()
      expect(main.closed).toEqual([])
      expect(main.opened).toEqual(['probe-box'])
    } finally {
      rpc._resetDeviceRpcForTesting()
      vi.useRealTimers()
    }
  })

  it.each([4_000, 5_000])('three non-overlapping %i ms windows retire the link within a twenty-second outage', async (timeoutMs) => {
    vi.useFakeTimers()
    const main = fakeMainProcess({ sshMachines: ['dead-box'] })
    const rpc = await load(main)
    try {
      for (let window = 1; window <= 3; window += 1) {
        const pending = rpc.callDeviceRpc('dead-box', 'read', {}, { timeoutMs }).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(timeoutMs)
        expect(await pending).toMatchObject({ name: 'DeviceRpcTimeoutError' })
        expect(main.closed).toHaveLength(window === 3 ? 1 : 0)
      }
      await vi.advanceTimersByTimeAsync(20_000 - timeoutMs * 3)
      const recovered = rpc.callDeviceRpc('dead-box', 'read', {})
      await vi.advanceTimersByTimeAsync(0)
      answerSsh(main, 3)
      await expect(recovered).resolves.toMatchObject({ result: { ok: true } })
      expect(main.opened).toEqual(['dead-box', 'dead-box'])
    } finally {
      rpc._resetDeviceRpcForTesting()
      vi.useRealTimers()
    }
  })

  it('overlapping long deadlines do not add windows and a reply from an expired request does not reset them', async () => {
    vi.useFakeTimers()
    const main = fakeMainProcess({ sshMachines: ['mixed-box'] })
    const rpc = await load(main)
    try {
      const long = rpc.callDeviceRpc('mixed-box', 'read', {}, { timeoutMs: 9_000 }).catch((error: unknown) => error)
      const first = rpc.callDeviceRpc('mixed-box', 'read', {}).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(5_000)
      await first
      const second = rpc.callDeviceRpc('mixed-box', 'read', {}).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(5_000)
      await long
      await second
      expect(main.closed).toEqual([])
      answerSsh(main, 1) // 已超时的旧 request_id,不能替当前连接证明存活。
      const third = rpc.callDeviceRpc('mixed-box', 'read', {}).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(5_000)
      await third
      expect(main.closed).toEqual(['mixed-box'])
    } finally {
      rpc._resetDeviceRpcForTesting()
      vi.useRealTimers()
    }
  })

  it('a replacement pipe starts fresh and ignores replies belonging to its predecessor', async () => {
    vi.useFakeTimers()
    const main = fakeMainProcess({ sshMachines: ['replace-box'] })
    const rpc = await load(main)
    try {
      const timeout = async () => {
        const pending = rpc.callDeviceRpc('replace-box', 'read', {}).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(5_000)
        await pending
      }
      await timeout()
      await timeout()
      rpc._resetDeviceRpcForTesting('replace-box')
      await vi.advanceTimersByTimeAsync(0)
      await timeout()
      await timeout()
      expect(main.closed).toHaveLength(1)
      answerSsh(main, 0)
      await timeout()
      expect(main.closed).toHaveLength(2)
    } finally {
      rpc._resetDeviceRpcForTesting()
      vi.useRealTimers()
    }
  })

  // 2026-10-27 owner「每次打开都闪一下」:开机时到 d22 的频道先走咕咕云,隧道通了再换到设备连接。先断后接时,撤掉咕咕云到
  // 设备连接接好那 2–3 s 里窗口全断,侧栏掉成「重新连接」、文件树「无响应」、在起的会话报错。先接后断:设备连接接好之前
  // 咕咕云照常办事;接好了,窗口先交接(onChannelSwitching),再撤咕咕云,新管道接过这一条(❌ 再拨一次)。
  // 判据能判假吗:换回先断后接(reconcileTransports 当场 requester.close),「接好之前咕咕云还在」那一条红。
  it('咕咕云 → 设备连接(隧道通了):先接后断,窗口先交接再撤咕咕云,新管道用先接好的那一条', async () => {
    let linkUp: (result: unknown) => void = () => undefined
    const main = fakeMainProcess({ sshMachines: [], open: () => new Promise((resolve) => { linkUp = resolve }) })
    const { callDeviceRpc, subscribeDeviceRpcEvents } = await load(main)
    const resubscribed = vi.fn()
    let unsubscribedAtSwitch: number | null = null
    const switching = vi.fn(() => { unsubscribedAtSwitch = cloud.unsubscribed })
    subscribeDeviceRpcEvents('tunnel-box', () => undefined, { onChannelResubscribed: resubscribed, onChannelSwitching: switching })
    await vi.waitFor(() => expect(resubscribed).toHaveBeenCalledTimes(1))

    main.emit('tunnel-machines:changed', { ready: ['tunnel-box'], problems: {} })
    await whenRecorded('设备连接开始拨', () => main.opened.length === 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(cloud.unsubscribed, '设备连接接好之前咕咕云还在').toBe(0)
    expect(switching).not.toHaveBeenCalled()

    linkUp({ ok: true })
    await vi.waitFor(() => expect(resubscribed).toHaveBeenCalledTimes(2))
    expect(switching).toHaveBeenCalledTimes(1)
    expect(unsubscribedAtSwitch, '窗口先交接,再撤咕咕云').toBe(0)
    expect(cloud.unsubscribed).toBeGreaterThan(0)
    expect(main.opened, '新管道接过先接好的那一条,❌ 再拨').toEqual(['tunnel-box'])

    void callDeviceRpc('tunnel-box', 'taskpage.sessions.list', {}, { timeoutMs: 2_000 }).catch(() => undefined)
    await whenRecorded('问走设备连接', () => main.sent.length === 1)
    expect(main.sent[0].deviceId).toBe('tunnel-box')
  })

  // #625 交接走的窗口:那台机器按通道收窗口,关窗那一句要在咕咕云撤掉之前、在咕咕云上说;❌ 落到新的设备连接上(对不上号,
  // 那台机器要等约 30 s 心跳丢了才收)。
  it('咕咕云 → 设备连接:交接走的窗口在咕咕云撤掉之前,经咕咕云关掉', async () => {
    let linkUp: (result: unknown) => void = () => undefined
    const main = fakeMainProcess({ sshMachines: [], open: () => new Promise((resolve) => { linkUp = resolve }) })
    const { subscribeDeviceRpcEvents } = await load(main)
    const resubscribed = vi.fn()
    subscribeDeviceRpcEvents('tunnel-box', () => undefined, {
      onChannelResubscribed: resubscribed,
      onChannelSwitching: () => ({ type: 'taskhost.close', payload: { client: 'old-window' } }),
    })
    await vi.waitFor(() => expect(resubscribed).toHaveBeenCalledTimes(1))

    main.emit('tunnel-machines:changed', { ready: ['tunnel-box'], problems: {} })
    await whenRecorded('设备连接开始拨', () => main.opened.length === 1)
    linkUp({ ok: true })
    await vi.waitFor(() => expect(cloud.unsubscribed).toBeGreaterThan(0))

    const closes = cloud.sentOn.filter((sent) => sent.message.payload.type === 'taskhost.close')
    expect(closes, '关窗经咕咕云说了一次').toHaveLength(1)
    expect((closes[0].message.payload as unknown as { payload: unknown }).payload).toEqual({ client: 'old-window' })
    expect(main.sent.some((sent) => sent.message.payload.type === 'taskhost.close'), '❌ 落到设备连接上').toBe(false)
  })

  it('咕咕云 → 设备连接,可设备连接没接上:❌ 交接,照旧先断后接', async () => {
    const main = fakeMainProcess({ sshMachines: [], open: () => ({ ok: false, reason: 'unreachable', via: 'tunnel' }) })
    const { subscribeDeviceRpcEvents } = await load(main)
    const resubscribed = vi.fn()
    const switching = vi.fn()
    subscribeDeviceRpcEvents('tunnel-box', () => undefined, { onChannelResubscribed: resubscribed, onChannelSwitching: switching })
    await vi.waitFor(() => expect(resubscribed).toHaveBeenCalledTimes(1))

    main.emit('tunnel-machines:changed', { ready: ['tunnel-box'], problems: {} })
    await vi.waitFor(() => expect(cloud.unsubscribed).toBeGreaterThan(0))
    expect(switching).not.toHaveBeenCalled()
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
