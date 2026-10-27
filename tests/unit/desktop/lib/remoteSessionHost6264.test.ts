import { describe, expect, it, vi } from 'vitest'

// 线本身由注入的 deps 替掉;真的 deviceRpc 模块在测试里不求值(它一加载就挂 Supabase / 渲染层全局)。
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn(), subscribeDeviceRpcEvents: vi.fn() }))
import { MIN_SERVER_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { HEARTBEAT_REPLY_TIMEOUT_MS, openRemoteSessionHostPipe, SessionHostTooOldError } from '@/lib/remoteSessionHost'
import { SESSION_HOST_FRAME_EVENT, SESSION_HOST_READY_EVENT } from '@/session/shared/lib/ipc/session-host-device-frames'

type Call = { type: string; payload: Record<string, unknown> }
type Reply = { result?: unknown; error?: { code: string; message: string } }

function fakeDevice(reply: (call: Call) => Reply, options: { ssh?: boolean } = {}) {
  const calls: Call[] = []
  const upgrades: string[] = []
  let listener: ((payload: unknown) => void) | null = null
  let resubscribed: ((rejoin: boolean) => void) | undefined
  let switching: (() => void) | undefined
  const deps = {
    call: (async (_device: string, type: string, payload: unknown) => {
      const call = { type, payload: payload as Record<string, unknown> }
      calls.push(call)
      return reply(call)
    }) as never,
    subscribe: ((
      _device: string,
      cb: (payload: unknown) => void,
      options?: { onChannelResubscribed?: (rejoin: boolean) => void; onChannelSwitching?: () => void },
    ) => {
      listener = cb
      resubscribed = options?.onChannelResubscribed
      switching = options?.onChannelSwitching
      return () => {
        listener = null
      }
    }) as never,
    newClientId: () => 'client00000001',
    isSshMachine: () => options.ssh === true,
    requestUpgrade: async (deviceId: string) => {
      upgrades.push(deviceId)
      return true
    },
  }
  return { deps, calls, upgrades, push: (payload: unknown) => listener?.(payload), resubscribe: (rejoin = true) => resubscribed?.(rejoin), switchChannel: () => switching?.() }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('remote task host pipe over device RPC', () => {
  it('waits for the tunnel event before subscribing or starting the taskhost.open RPC budget', async () => {
    vi.useFakeTimers()
    try {
      const device = fakeDevice(() => ({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } }))
      let ready!: () => void
      const tunnel = new Promise<void>((resolve) => { ready = resolve })
      const opening = openRemoteSessionHostPipe('dev', { ...device.deps, waitForTunnel: () => tunnel })({ onFrame: () => undefined, onClose: () => undefined })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(device.calls).toEqual([])
      ready()
      const pipe = await opening
      expect(device.calls.map((call) => call.type)).toEqual(['taskhost.open'])
      pipe.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens, batches frames into one request, and delivers pushes in seq order', async () => {
    const device = fakeDevice(() => ({ result: { ok: true, protocol: REMOTE_PROTOCOL_VERSION } }))
    const frames: unknown[] = []
    const pipe = await openRemoteSessionHostPipe('dev', device.deps)({
      onFrame: (f) => frames.push(f),
      onClose: () => undefined,
    })
    pipe.send('{"t":"hb"}')
    pipe.send('{"t":"sub","channel":"x"}')
    await flush()
    const frameCalls = device.calls.filter((c) => c.type === 'taskhost.frame')
    expect(frameCalls).toHaveLength(1)
    expect(frameCalls[0]!.payload.frames).toHaveLength(2)
    device.push({ type: SESSION_HOST_FRAME_EVENT, client: 'client00000001', seq: 1, frames: [{ f: 'second' }] })
    device.push({ type: SESSION_HOST_FRAME_EVENT, client: 'someone-else', seq: 0, frames: [{ f: 'not mine' }] })
    device.push({
      type: SESSION_HOST_FRAME_EVENT,
      client: 'client00000001',
      seq: 0,
      frames: [
        { f: 'fir', p: 0, n: 2 },
        { f: 'st', p: 1, n: 2 },
      ],
    })
    expect(frames).toEqual(['first', 'second'])
  })

  it('takes pushes still wrapped in the broadcast shell (SSH link and cloud deliver them that way)', async () => {
    const device = fakeDevice(() => ({ result: { ok: true, protocol: REMOTE_PROTOCOL_VERSION } }))
    const frames: unknown[] = []
    await openRemoteSessionHostPipe('dev', device.deps)({ onFrame: (f) => frames.push(f), onClose: () => undefined })
    device.push({
      type: 'broadcast',
      event: 'broadcast',
      payload: { type: SESSION_HOST_FRAME_EVENT, client: 'client00000001', seq: 0, frames: [{ f: 'hello' }] },
    })
    expect(frames).toEqual(['hello'])
  })

  it('reports an old machine that does not know the task host verbs', async () => {
    const device = fakeDevice(() => ({ error: { code: 'unknown_method', message: 'unknown device RPC type' } }))
    const error = await openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: () => undefined }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SessionHostTooOldError)
    // 各处认「版本太旧」的同一个码(界面说版本太旧,❌ 退回旧界面)。
    expect(error).toMatchObject({ code: 'server_outdated' })
    // 远程隧道的机器:等它空闲时自己升,这台桌面 ❌ 发起升级。
    expect(device.upgrades).toEqual([])
  })

  it('远程 SSH 的机器不认任务页宿主:当场请主进程替它升级(照 VS Code Remote-SSH 装一份对得上的)', async () => {
    const device = fakeDevice(() => ({ error: { code: 'unknown_method', message: 'unknown device RPC type' } }), { ssh: true })
    const error = await openRemoteSessionHostPipe('d22', device.deps)({ onFrame: () => undefined, onClose: () => undefined }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SessionHostTooOldError)
    expect(device.upgrades).toEqual(['d22'])
  })

  it('升级只因为版本:开线的其它失败(拒绝、出错、超时、传输断了)都照实抛出,❌ 替它升级', async () => {
    for (const code of ['internal_error', 'not_found', 'ssh_unreachable', 'ssh_link_refused', 'device_offline', 'forbidden']) {
      const device = fakeDevice(() => ({ error: { code, message: 'nope' } }), { ssh: true })
      const error = await openRemoteSessionHostPipe('d22', device.deps)({ onFrame: () => undefined, onClose: () => undefined }).catch(
        (e: unknown) => e,
      )
      expect(error).not.toBeInstanceOf(SessionHostTooOldError)
      expect(error).toMatchObject({ code })
      expect(device.upgrades).toEqual([])
    }
    const timedOut = fakeDevice(
      () => {
        throw Object.assign(new Error('timed out'), { name: 'DeviceRpcTimeoutError' })
      },
      { ssh: true },
    )
    const error = await openRemoteSessionHostPipe('d22', timedOut.deps)({ onFrame: () => undefined, onClose: () => undefined }).catch(
      (e: unknown) => e,
    )
    expect(error).not.toBeInstanceOf(SessionHostTooOldError)
    expect(timedOut.upgrades).toEqual([])
  })

  it('closes when the machine no longer knows the window', async () => {
    let known = true
    const device = fakeDevice((call) =>
      call.type === 'taskhost.frame' && !known ? { error: { code: 'not_open', message: '' } } : { result: { protocol: REMOTE_PROTOCOL_VERSION } },
    )
    const reasons: string[] = []
    const pipe = await openRemoteSessionHostPipe('dev', device.deps)({
      onFrame: () => undefined,
      onClose: (r) => reasons.push(r),
    })
    known = false
    pipe.send('{"t":"hb"}')
    await flush()
    await flush()
    expect(reasons).toEqual(['frame rejected: not_open (client client00000001)'])
  })

  it('closes when the channel comes back after a drop (pushes in the gap are gone)', async () => {
    const device = fakeDevice(() => ({ result: { protocol: REMOTE_PROTOCOL_VERSION } }))
    const reasons: string[] = []
    await openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: (r) => reasons.push(r) })
    device.resubscribe()
    expect(reasons).toEqual(['channel resubscribed'])
  })

  // 2026-10-27 owner「每次打开都闪一下」:开机时频道从咕咕云换到设备连接是计划内的,窗口关掉要标明是交接,
  // 客户端据此当场开新窗口、界面照「通着」。❌ 标成交接 = 照旧读成断线(侧栏掉点、文件树「无响应」)。
  it('频道换通道(新的那条已接好):开着的窗口以交接关掉', async () => {
    const device = fakeDevice(() => ({ result: { protocol: REMOTE_PROTOCOL_VERSION } }))
    const closes: Array<[string, { handoff?: boolean } | undefined]> = []
    await openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: (r, o) => closes.push([r, o]) })
    device.switchChannel()
    expect(closes).toEqual([['channel switching transport', { handoff: true }]])
    // 新管道接好时的那一声(rejoin=false)不再关一次。
    device.resubscribe(false)
    expect(closes).toHaveLength(1)
  })

  it('频道换通道时开线那一问还在旧通道上:当场放弃,客户端当场再开(与重接上同一个码)', async () => {
    let answer: (reply: Reply) => void = () => undefined
    const device = fakeDevice((call) =>
      call.type === 'taskhost.open' ? (new Promise<Reply>((resolve) => { answer = resolve }) as unknown as Reply) : { result: { closed: true } },
    )
    const opening = openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: () => undefined }).catch((e: unknown) => e)
    await flush()
    device.switchChannel()
    // ❌ 放弃时它会一直挂到开线超时:这里只给一拍。
    expect(await Promise.race([opening, flush().then(() => 'still opening')])).toMatchObject({ code: 'channel_resubscribed' })
    answer({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } })
  })

  it('#6264 开窗口时报这台桌面是哪一版(那台咕咕 server 据此让这个账号跑匹配的版本);拿不到就不报', async () => {
    const device = fakeDevice(() => ({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } }))
    const desktop = { id: 'dev-self', version: '0.2.160', protocol: 2 }
    await openRemoteSessionHostPipe('dev', { ...device.deps, desktop: async () => desktop })({ onFrame: () => undefined, onClose: () => undefined })
    expect(device.calls[0]).toEqual({ type: 'taskhost.open', payload: { client: 'client00000001', protocol: REMOTE_PROTOCOL_VERSION, desktop } })
    const bare = fakeDevice(() => ({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } }))
    await openRemoteSessionHostPipe('dev', { ...bare.deps, desktop: async () => null })({ onFrame: () => undefined, onClose: () => undefined })
    expect(bare.calls[0]).toEqual({ type: 'taskhost.open', payload: { client: 'client00000001', protocol: REMOTE_PROTOCOL_VERSION } })
  })

  it('一套说法(协议 6):那台机器开窗口的应答里没报协议,或报的低于 MIN_SERVER_PROTOCOL ⇒ 太旧,窗口当场关掉', async () => {
    for (const opened of [{ opened: true }, { opened: true, protocol: MIN_SERVER_PROTOCOL - 1 }]) {
      const device = fakeDevice(() => ({ result: opened }))
      const error = await openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: () => undefined }).catch(
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(SessionHostTooOldError)
      expect(device.calls.map((c) => c.type)).toEqual(['taskhost.open', 'taskhost.close'])
    }
    const current = fakeDevice(() => ({ result: { opened: true, protocol: MIN_SERVER_PROTOCOL } }))
    await expect(openRemoteSessionHostPipe('dev', current.deps)({ onFrame: () => undefined, onClose: () => undefined })).resolves.toBeDefined()
  })

  // 冷启动实撞(手机点进一台机器晚 5 s):频道头一回订上正好落在开线那一问在路上的时候,被当成重接放弃了。
  it('开线时频道是头一回订上(rejoin=false):不放弃,窗口照常开好', async () => {
    let answer: (reply: Reply) => void = () => undefined
    const device = fakeDevice((call) =>
      call.type === 'taskhost.open' ? (new Promise<Reply>((resolve) => { answer = resolve }) as unknown as Reply) : { result: { closed: true } },
    )
    const opening = openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: () => undefined })
    await flush()
    device.resubscribe(false)
    answer({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } })
    await expect(opening).resolves.toBeDefined()
    expect(device.calls.map((c) => c.type)).toEqual(['taskhost.open'])
  })

  it('开线那一问还在路上时频道重接上了:当场放弃(❌ 干等 15 s 超时);那一问迟到成功就把多开的窗口关掉', async () => {
    let answer: (reply: Reply) => void = () => undefined
    const device = fakeDevice((call) =>
      call.type === 'taskhost.open' ? (new Promise<Reply>((resolve) => { answer = resolve }) as unknown as Reply) : { result: { closed: true } },
    )
    const opening = openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: () => undefined }).catch((e: unknown) => e)
    await flush()
    device.resubscribe()
    expect(await opening).toMatchObject({ code: 'channel_resubscribed' })
    answer({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } })
    await flush()
    expect(device.calls.map((c) => c.type)).toEqual(['taskhost.open', 'taskhost.close'])
  })

  it('那台机器的宿主刚起来(开线那一问是对着没起来的它发的):当场放弃这一问(❌ 干等 15 s 超时);那一问迟到成功就把多开的窗口关掉', async () => {
    let answer: (reply: Reply) => void = () => undefined
    const device = fakeDevice((call) =>
      call.type === 'taskhost.open' ? (new Promise<Reply>((resolve) => { answer = resolve }) as unknown as Reply) : { result: { closed: true } },
    )
    const opening = openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: () => undefined }).catch((e: unknown) => e)
    await flush()
    // 广播外壳里的那一声(咕咕云与 SSH 都这样送)
    device.push({ type: 'broadcast', event: 'broadcast', payload: { type: SESSION_HOST_READY_EVENT } })
    expect(await opening).toMatchObject({ code: 'host_restarted' })
    answer({ result: { opened: true, protocol: REMOTE_PROTOCOL_VERSION } })
    await flush()
    expect(device.calls.map((c) => c.type)).toEqual(['taskhost.open', 'taskhost.close'])
  })

  it('watchPeerRestart:不开任何窗口也听着那台机器的「宿主起来了」(客户端退避等着时没有管道),别的推送不算;取消后不再报', async () => {
    const device = fakeDevice(() => ({ result: { ok: true, protocol: REMOTE_PROTOCOL_VERSION } }))
    const restarts: string[] = []
    const unwatch = openRemoteSessionHostPipe('dev', device.deps).watchPeerRestart!(() => restarts.push('restart'))
    device.push({ type: SESSION_HOST_FRAME_EVENT, client: 'someone', seq: 0, frames: [{ f: 'x' }] })
    device.push({ type: 'something-else' })
    expect(restarts).toEqual([])
    device.push({ type: 'broadcast', event: 'broadcast', payload: { type: SESSION_HOST_READY_EVENT } })
    expect(restarts).toEqual(['restart'])
    expect(device.calls).toEqual([])
    unwatch()
    device.push({ type: SESSION_HOST_READY_EVENT })
    expect(restarts).toEqual(['restart'])
  })

  // 复核 137:SSH 设备连接上没有 ready 这一声(它只说在云频道上),听也白听;那边重起由设备连接自己接回。
  it('watchPeerRestart:远程 SSH 的机器不挂听者', () => {
    const device = fakeDevice(() => ({ result: { ok: true, protocol: REMOTE_PROTOCOL_VERSION } }), { ssh: true })
    const subscribe = vi.spyOn(device.deps, 'subscribe')
    const unwatch = openRemoteSessionHostPipe('ssh-dev', device.deps).watchPeerRestart!(() => undefined)
    expect(subscribe).not.toHaveBeenCalled()
    unwatch()
  })
})

// #156 那台机器收下一批就当场回:桌面连它时,只装着心跳的那一批回得慢 = 那台机器没了。
describe('heartbeat-only batches are a liveness probe on the desktop (#156)', () => {
  const PROBE = { heartbeatReplyTimeoutMs: HEARTBEAT_REPLY_TIMEOUT_MS }
  function timedDevice(answer: (type: string, payload: { seq?: number }) => Promise<Reply>) {
    const frameTimeouts: Array<number | undefined> = []
    let listener: ((payload: unknown) => void) | null = null
    const deps = {
      ...fakeDevice(() => ({ result: { ok: true, protocol: REMOTE_PROTOCOL_VERSION } })).deps,
      call: (async (_device: string, type: string, payload: { seq?: number }, options?: { timeoutMs?: number }) => {
        if (type === 'taskhost.open') return { result: { ok: true, protocol: REMOTE_PROTOCOL_VERSION } }
        if (type === 'taskhost.frame') frameTimeouts.push(options?.timeoutMs)
        return answer(type, payload)
      }) as never,
      subscribe: ((_device: string, cb: (payload: unknown) => void) => {
        listener = cb
        return () => { listener = null }
      }) as never,
    }
    return { deps, frameTimeouts, push: (payload: unknown) => listener?.(payload) }
  }
  const later = () => {
    let settle: (outcome: Reply | Error) => void = () => undefined
    const promise = new Promise<Reply>((resolve, reject) => {
      settle = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome))
    })
    return { promise, settle }
  }

  it('waits only a few seconds for a heartbeat-only batch; a batch that carries work keeps the long wait', async () => {
    const device = timedDevice(async () => ({ result: { ok: true } }))
    const pipe = await openRemoteSessionHostPipe('dev', device.deps, PROBE)({ onFrame: () => undefined, onClose: () => undefined })
    pipe.send('{"t":"hb"}', 'heartbeat')
    await flush()
    pipe.send('{"t":"hb"}', 'heartbeat')
    pipe.send('{"t":"sub","channel":"x"}')
    await flush()
    pipe.send('{"t":"sub","channel":"y"}')
    await flush()
    expect(device.frameTimeouts).toEqual([HEARTBEAT_REPLY_TIMEOUT_MS, 20_000, 20_000])
    expect(HEARTBEAT_REPLY_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })

  it('the phone does not probe: its heartbeats wait as long as work (a cellular handover is not a dead machine)', async () => {
    const device = timedDevice(async () => ({ result: { ok: true } }))
    const pipe = await openRemoteSessionHostPipe('dev', device.deps)({ onFrame: () => undefined, onClose: () => undefined })
    pipe.send('{"t":"hb"}', 'heartbeat')
    await flush()
    expect(device.frameTimeouts).toEqual([20_000])
  })

  it('a heartbeat queued behind a batch still waiting for its answer is not a probe (a slow upload is not a dead machine)', async () => {
    const upload = later()
    const device = timedDevice((type, payload) => (payload.seq === 0 ? upload.promise : Promise.resolve({ result: { ok: true } })))
    const pipe = await openRemoteSessionHostPipe('dev', device.deps, PROBE)({ onFrame: () => undefined, onClose: () => undefined })
    pipe.send('{"t":"invoke","big":true}')
    await flush()
    pipe.send('{"t":"hb"}', 'heartbeat')
    await flush()
    upload.settle({ result: { ok: true } })
    await flush()
    pipe.send('{"t":"hb"}', 'heartbeat')
    await flush()
    expect(device.frameTimeouts).toEqual([20_000, 20_000, HEARTBEAT_REPLY_TIMEOUT_MS])
  })

  it('a heartbeat that gets no answer closes the link, so the client reconnects and the machine reads as reconnecting', async () => {
    const device = timedDevice(async (type) => {
      if (type === 'taskhost.frame') throw new Error(`no reply to ${type} within ${HEARTBEAT_REPLY_TIMEOUT_MS} ms (asked twice)`)
      return { result: { ok: true } }
    })
    const closed: string[] = []
    const pipe = await openRemoteSessionHostPipe('dev', device.deps, PROBE)({ onFrame: () => undefined, onClose: (reason) => closed.push(reason) })
    pipe.send('{"t":"hb"}', 'heartbeat')
    await flush()
    await flush()
    expect(closed).toEqual([`frame not delivered: Error: no reply to taskhost.frame within ${HEARTBEAT_REPLY_TIMEOUT_MS} ms (asked twice) (client client00000001)`])
  })

  it('no answer to the probe, but the machine was heard from meanwhile: the link stays (it is busy, not gone)', async () => {
    const probe = later()
    const device = timedDevice(() => probe.promise)
    const closed: string[] = []
    const frames: unknown[] = []
    const pipe = await openRemoteSessionHostPipe('dev', device.deps, PROBE)({ onFrame: (f) => frames.push(f), onClose: (reason) => closed.push(reason) })
    pipe.send('{"t":"hb"}', 'heartbeat')
    await flush()
    device.push({ type: SESSION_HOST_FRAME_EVENT, client: 'client00000001', seq: 0, frames: [{ f: 'a big read result' }] })
    probe.settle(new Error('no reply to taskhost.frame within 4000 ms (asked twice)'))
    await flush()
    expect(frames).toEqual(['a big read result'])
    expect(closed).toEqual([])
  })
})
