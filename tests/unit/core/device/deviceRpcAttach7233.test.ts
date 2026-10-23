// #7233 设备 RPC 在咕咕云上「一个发问端一条线」,发问端这一侧(@gugu/core/cloud/deviceRpcAttach)。
// 替身只换掉「订上一条 topic」那一步(join):每条 topic 记下发出去的、能往里推帧、能说「断过又订上」。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_PROTOCOL_VERSION } from '../../../../packages/core/src/cloud/serverMachineHealth'
import { openAttachedDeviceRpcPipe } from '../../../../packages/core/src/cloud/deviceRpcAttach'
import { DeviceRpcChannelError, DeviceRpcRefused } from '../../../../packages/core/src/cloud/deviceRpcRequester'
import type { DeviceTopicHandlers } from '../../../../packages/core/src/cloud/deviceRpcAttach'

const DEV = 'dev-1'
const ASKER = 'askerAAAA1111'
const SHARED = `gugu:${DEV}:rpc`
const MINE = `gugu:${DEV}:rpc:${ASKER}`

type Topic = { name: string; sent: { payload: { type: string; request_id: string; payload: unknown } }[]; handlers: DeviceTopicHandlers; closed: boolean }

function fakeCloud(options: { answerAttach?: 'here' | 'old-host' | 'never' } = {}) {
  const answer = options.answerAttach ?? 'here'
  const topics: Topic[] = []
  const open = (name: string) => topics.filter((t) => t.name === name && !t.closed)
  const push = (name: string, payload: unknown) => {
    for (const topic of open(name)) topic.handlers.onMessage({ type: 'broadcast', event: 'broadcast', payload })
  }
  const join = vi.fn(async (name: string, handlers: DeviceTopicHandlers) => {
    const topic: Topic = { name, sent: [], handlers, closed: false }
    topics.push(topic)
    return {
      send: async (message: unknown) => {
        const sent = message as Topic['sent'][number]
        topic.sent.push(sent)
        if (sent.payload.type !== 'taskhost.attach') return
        const reply = (error?: { code: string; message: string }) => ({
          type: 'taskhost.attach:reply',
          request_id: sent.payload.request_id,
          ...(error ? { error } : { result: { attached: true, protocol: REMOTE_PROTOCOL_VERSION } }),
        })
        // 新机器在发问端那条上回;旧机器不认这个动词,在共用 topic 上回 unknown_method。
        if (answer === 'here') queueMicrotask(() => push(MINE, reply()))
        if (answer === 'old-host') queueMicrotask(() => push(SHARED, reply({ code: 'unknown_method', message: 'unknown device RPC type: taskhost.attach' })))
      },
      close: () => {
        topic.closed = true
      },
    }
  })
  const sentOn = (name: string) => topics.filter((t) => t.name === name).flatMap((t) => t.sent.map((m) => m.payload))
  return { topics, join, push, open, sentOn }
}

const request = (n: number) => ({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskhost.call', request_id: `r${n}`, user_id: 'u1', payload: { n } } })

async function openPipe(cloud: ReturnType<typeof fakeCloud>, extra: Partial<Parameters<typeof openAttachedDeviceRpcPipe>[0]> = {}) {
  const onMessage = vi.fn()
  const onClosed = vi.fn()
  const onRejoined = vi.fn()
  let id = 0
  const pipe = await openAttachedDeviceRpcPipe({
    deviceId: DEV,
    asker: ASKER,
    userId: async () => 'u1',
    join: cloud.join,
    onMessage,
    onClosed,
    onRejoined,
    newRequestId: () => `attach-${++id}`,
    ...extra,
  })
  return { pipe, onMessage, onClosed, onRejoined }
}

afterEach(() => {
  vi.useRealTimers()
})

/** 离开一条 topic 是在下一拍(close 挂在它的 promise 后面):等这一拍过去,❌ 按墙钟轮询。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('发问端报到,之后只在自己那条上问', () => {
  it('开管道只订共用 topic;第一问先订自己那条、在共用 topic 上报到,应答到了再把这一问发在自己那条上', async () => {
    const cloud = fakeCloud()
    const { pipe } = await openPipe(cloud)
    expect(cloud.topics.map((t) => t.name)).toEqual([SHARED])

    await pipe.send(request(1))
    expect(cloud.topics.map((t) => t.name)).toEqual([SHARED, MINE])
    expect(cloud.sentOn(SHARED)).toEqual([{ type: 'taskhost.attach', request_id: 'attach-1', user_id: 'u1', payload: { asker: ASKER, protocol: REMOTE_PROTOCOL_VERSION } }])
    expect(cloud.sentOn(MINE).map((p) => p.request_id)).toEqual(['r1'])
  })

  it('同时的几问合成一次报到;报到着的时候再问 ❌ 再报到', async () => {
    const cloud = fakeCloud()
    const { pipe } = await openPipe(cloud)
    await Promise.all([pipe.send(request(1)), pipe.send(request(2))])
    await pipe.send(request(3))
    expect(cloud.sentOn(SHARED).map((p) => p.type)).toEqual(['taskhost.attach'])
    expect(cloud.sentOn(MINE).map((p) => p.request_id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('宿主说 detached(空闲关 / 让位):离开自己那条,下一问重新订、重新报到', async () => {
    const cloud = fakeCloud()
    const { pipe, onMessage } = await openPipe(cloud)
    await pipe.send(request(1))
    cloud.push(MINE, { type: 'taskhost.detached', reason: 'idle' })
    await flush()
    expect(cloud.open(MINE)).toHaveLength(0)
    expect(onMessage).not.toHaveBeenCalled()

    await pipe.send(request(2))
    expect(cloud.sentOn(SHARED).map((p) => p.request_id)).toEqual(['attach-1', 'attach-2'])
    expect(cloud.topics.filter((t) => t.name === MINE)).toHaveLength(2)
    expect(cloud.open(MINE)[0]!.sent.map((m) => m.payload.request_id)).toEqual(['r2'])
  })

  it('宿主重启(共用 topic 上的 ready):下一问重新报到;ready 照样交出去(窗口据此重开)', async () => {
    const cloud = fakeCloud()
    const { pipe, onMessage } = await openPipe(cloud)
    await pipe.send(request(1))
    cloud.push(SHARED, { type: 'taskhost.ready' })
    expect(onMessage).toHaveBeenCalledWith({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskhost.ready' } })
    await pipe.send(request(2))
    expect(cloud.sentOn(SHARED).map((p) => p.type)).toEqual(['taskhost.attach', 'taskhost.attach'])
  })

  it('请求方说「一问没回」(recover):下一问重新报到', async () => {
    const cloud = fakeCloud()
    const { pipe } = await openPipe(cloud)
    await pipe.send(request(1))
    pipe.recover!()
    await pipe.send(request(1))
    expect(cloud.sentOn(SHARED).map((p) => p.type)).toEqual(['taskhost.attach', 'taskhost.attach'])
    expect(cloud.sentOn(MINE).map((p) => p.request_id)).toEqual(['r1', 'r1'])
  })

  it('alive 不往外交;别的推送(窗口回帧、应答)照常交出去', async () => {
    const cloud = fakeCloud()
    const { pipe, onMessage } = await openPipe(cloud)
    await pipe.send(request(1))
    cloud.push(SHARED, { type: 'taskhost.alive' })
    cloud.push(MINE, { type: 'taskhost.alive' })
    cloud.push(MINE, { type: 'taskhost.call:reply', request_id: 'r1', result: { value: 1 } })
    expect(onMessage.mock.calls.map(([m]) => (m as { payload: { type: string } }).payload.type)).toEqual(['taskhost.call:reply'])
  })
})

describe('旧机器 / 报到不成', () => {
  it('旧机器(协议 9 以前)在共用 topic 上回 unknown_method:这一问以 DeviceRpcRefused 失败(调用方据此说「请更新那台机器」)', async () => {
    const cloud = fakeCloud({ answerAttach: 'old-host' })
    const { pipe } = await openPipe(cloud)
    const sent = pipe.send(request(1))
    await expect(sent).rejects.toBeInstanceOf(DeviceRpcRefused)
    await expect(sent).rejects.toMatchObject({ error: { code: 'unknown_method' } })
    expect(cloud.sentOn(MINE)).toEqual([])
  })

  it('报到没人答:到期失败,自己那条离开;下一问再报到一次', async () => {
    vi.useFakeTimers()
    const cloud = fakeCloud({ answerAttach: 'never' })
    const { pipe } = await openPipe(cloud, { attachTimeoutMs: 1_000 })
    const first = pipe.send(request(1))
    const failed = expect(first).rejects.toMatchObject({ reason: 'unreachable' })
    await vi.advanceTimersByTimeAsync(1_000)
    await failed
    await vi.advanceTimersByTimeAsync(0)
    expect(cloud.open(MINE)).toHaveLength(0)
    void pipe.send(request(2)).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(cloud.sentOn(SHARED).map((p) => p.type)).toEqual(['taskhost.attach', 'taskhost.attach'])
  })
})

// realtime-js(2.103)的 channel(topic):同名那条还没退完就把它交回来 —— 订在一条正在退的频道上,永远等不到 SUBSCRIBED。
// 替身照这个样子:退要等 finishLeaves();退完之前再订同名的,订不上(join 永远不落定),记一笔。设备 id 各用各的:
// 「在退」是一个进程一份的(同一个 realtime 连接),别的用例的同名 topic 不能挂在这里。
function leavingCloud(dev: string) {
  const shared = `gugu:${dev}:rpc`
  const mine = `gugu:${dev}:rpc:${ASKER}`
  const topics: { name: string; sent: { payload: { type: string; request_id: string } }[]; handlers: DeviceTopicHandlers; state: 'joined' | 'leaving' | 'left' }[] = []
  const leaves: (() => void)[] = []
  let joinedWhileLeaving = 0
  const push = (name: string, payload: unknown) => {
    for (const topic of topics.filter((t) => t.name === name && t.state === 'joined')) topic.handlers.onMessage({ type: 'broadcast', event: 'broadcast', payload })
  }
  const join = vi.fn((name: string, handlers: DeviceTopicHandlers) => {
    if (topics.some((t) => t.name === name && t.state === 'leaving')) {
      joinedWhileLeaving += 1
      return new Promise<never>(() => undefined)
    }
    const topic: (typeof topics)[number] = { name, sent: [], handlers, state: 'joined' }
    topics.push(topic)
    return Promise.resolve({
      send: async (message: unknown) => {
        const sent = message as (typeof topic.sent)[number]
        topic.sent.push(sent)
        if (sent.payload.type === 'taskhost.attach') {
          queueMicrotask(() => push(mine, { type: 'taskhost.attach:reply', request_id: sent.payload.request_id, result: { attached: true, protocol: REMOTE_PROTOCOL_VERSION } }))
        }
      },
      close: () => {
        topic.state = 'leaving'
        return new Promise<void>((resolve) => leaves.push(() => {
          topic.state = 'left'
          resolve()
        }))
      },
    })
  })
  const finishLeaves = () => leaves.splice(0).forEach((finish) => finish())
  const sentOn = (name: string) => topics.filter((t) => t.name === name).flatMap((t) => t.sent.map((m) => m.payload))
  return { shared, mine, join, push, finishLeaves, sentOn, joinedWhileLeaving: () => joinedWhileLeaving }
}

describe('同名 topic 退完再订;报到的期限含订上那一步', () => {
  it('宿主重启(ready):自己那条当场退;紧接着的下一问等它退完再订、再报到 —— ❌ 订在正在退的那条上', async () => {
    const cloud = leavingCloud('dev-ready')
    const { pipe } = await openPipe(cloud as never, { deviceId: 'dev-ready' })
    await pipe.send(request(1))
    cloud.push(cloud.shared, { type: 'taskhost.ready' })
    const second = pipe.send(request(2))
    await flush()
    expect(cloud.join.mock.calls.filter(([name]) => name === cloud.mine)).toHaveLength(1)
    cloud.finishLeaves()
    await flush()
    expect(cloud.joinedWhileLeaving()).toBe(0)
    expect(cloud.sentOn(cloud.shared).map((p) => p.type)).toEqual(['taskhost.attach', 'taskhost.attach'])
    expect(cloud.sentOn(cloud.mine).map((p) => p.request_id)).toEqual(['r1', 'r2'])
    await second
  })

  it('整条作废(rejoined)后新管道马上订同名的两条:同样等旧的退完', async () => {
    const cloud = leavingCloud('dev-rejoin')
    const first = await openPipe(cloud as never, { deviceId: 'dev-rejoin' })
    await first.pipe.send(request(1))
    first.pipe.close()
    const reopened = openPipe(cloud as never, { deviceId: 'dev-rejoin' })
    await flush()
    expect(cloud.join.mock.calls.filter(([name]) => name === cloud.shared)).toHaveLength(1)
    cloud.finishLeaves()
    const { pipe } = await reopened
    const asked = pipe.send(request(2))
    await flush()
    expect(cloud.joinedWhileLeaving()).toBe(0)
    expect(cloud.sentOn(cloud.mine).map((p) => p.request_id)).toEqual(['r1', 'r2'])
    await asked
  })

  it('订自己那条一直不落定:报到到期失败(unreachable),❌ 无期限地等;下一问重新订', async () => {
    vi.useFakeTimers()
    const cloud = fakeCloud()
    let hang = true
    const join = vi.fn((name: string, handlers: DeviceTopicHandlers) => {
      if (name === MINE && hang) {
        hang = false
        return new Promise<never>(() => undefined)
      }
      return cloud.join(name, handlers)
    })
    const { pipe } = await openPipe(cloud, { join, attachTimeoutMs: 1_000 })
    let outcome: unknown = 'pending'
    void pipe.send(request(1)).then(() => { outcome = 'sent' }, (error: unknown) => { outcome = error })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(outcome).toMatchObject({ reason: 'unreachable', message: expect.stringContaining(`could not join ${MINE}`) })
    await pipe.send(request(2))
    expect(join.mock.calls.filter(([name]) => name === MINE)).toHaveLength(2)
    expect(cloud.sentOn(MINE).map((p) => p.request_id)).toEqual(['r2'])
  })
})

describe('断过又订上 / 看门狗:整条作废(rejoined),请求方换新管道', () => {
  it('共用那条断过又订上:管道以 rejoined 关掉,两条都离开,onRejoined 叫一次', async () => {
    const cloud = fakeCloud()
    const { pipe, onClosed, onRejoined } = await openPipe(cloud)
    await pipe.send(request(1))
    cloud.open(SHARED)[0]!.handlers.onRejoined()
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(onClosed.mock.calls[0]![0]).toBeInstanceOf(DeviceRpcChannelError)
    expect(onClosed.mock.calls[0]![0]).toMatchObject({ reason: 'rejoined' })
    expect(onRejoined).toHaveBeenCalledTimes(1)
    await flush()
    expect(cloud.open(SHARED).length + cloud.open(MINE).length).toBe(0)
  })

  it('自己那条断过又订上:同样整条作废', async () => {
    const cloud = fakeCloud()
    const { pipe, onClosed } = await openPipe(cloud)
    await pipe.send(request(1))
    cloud.open(MINE)[0]!.handlers.onRejoined()
    expect(onClosed.mock.calls[0]![0]).toMatchObject({ reason: 'rejoined' })
  })

  it('被拒(设备不在账号名下):原样当管道关掉的原因,❌ 说成 rejoined', async () => {
    const cloud = fakeCloud()
    const { onClosed, onRejoined } = await openPipe(cloud)
    const forbidden = new Error('Unauthorized: You do not have permissions to read from this Channel topic')
    cloud.open(SHARED)[0]!.handlers.onClosed(forbidden)
    expect(onClosed).toHaveBeenCalledWith(forbidden)
    expect(onRejoined).not.toHaveBeenCalled()
  })

  it('看门狗(主进程):共用那条 2 分钟一帧都没有 ⇒ rejoined;alive 按时到就不判', async () => {
    vi.useFakeTimers()
    const cloud = fakeCloud()
    let t = 0
    const { pipe, onClosed } = await openPipe(cloud, { watchdog: { staleMs: 120_000, checkEveryMs: 30_000, now: () => t } })
    await pipe.send(request(1))
    for (let minute = 1; minute <= 5; minute++) {
      t = minute * 60_000
      cloud.push(SHARED, { type: 'taskhost.alive' })
      cloud.push(MINE, { type: 'taskhost.alive' })
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(onClosed).not.toHaveBeenCalled()
    t += 120_000
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onClosed.mock.calls[0]![0]).toMatchObject({ reason: 'rejoined' })
  })

  it('看门狗:只有自己那条悄悄死了(共用那条照常有 alive)也判 —— 一条规则管两条', async () => {
    vi.useFakeTimers()
    const cloud = fakeCloud()
    let t = 0
    const { pipe, onClosed } = await openPipe(cloud, { watchdog: { staleMs: 120_000, checkEveryMs: 30_000, now: () => t } })
    await pipe.send(request(1))
    for (let minute = 1; minute <= 3; minute++) {
      t = minute * 60_000
      cloud.push(SHARED, { type: 'taskhost.alive' })
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(onClosed.mock.calls[0]![0]).toMatchObject({ reason: 'rejoined', message: expect.stringContaining(MINE) })
  })

  it('看门狗:没报到着时自己那条不开,也就不等它的 alive(宿主只在它在的那条上发)', async () => {
    vi.useFakeTimers()
    const cloud = fakeCloud()
    let t = 0
    const { pipe, onClosed } = await openPipe(cloud, { watchdog: { staleMs: 120_000, checkEveryMs: 30_000, now: () => t } })
    await pipe.send(request(1))
    cloud.push(MINE, { type: 'taskhost.detached', reason: 'idle' })
    for (let minute = 1; minute <= 5; minute++) {
      t = minute * 60_000
      cloud.push(SHARED, { type: 'taskhost.alive' })
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(onClosed).not.toHaveBeenCalled()
  })
})
