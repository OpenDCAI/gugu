/**
 * 设备 RPC 的请求方(@gugu/core/cloud/deviceRpcRequester):渲染层与主进程共用的那一份。
 *
 * 可见域:请求与应答的配对、期限、通道的开关(假通道,不经 Realtime / SSH)。判的是这一层的裁决:
 * 同一条频道上别人的请求与应答不认、应答类型对不上不认;没回音按期限报 DeviceRpcTimeoutError;
 * 通道开不起来 / 中途断了,等着的调用都拿到那个错,下一次调用重开。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createDeviceRpcRequester,
  DeviceRpcChannelError,
  DeviceRpcTimeoutError,
  type DeviceRpcPipe,
} from '../../../../packages/core/src/cloud/deviceRpcRequester'
import { openSshDeviceRpcPipe } from '../../../../apps/desktop/electron/device-rpc-requester'

type Handlers = { onMessage(payload: unknown): void; onClosed(error: unknown): void }

function fakeNetwork() {
  const opened: Array<{ deviceId: string; handlers: Handlers; sent: unknown[]; closed: boolean }> = []
  const openPipe = vi.fn(async (deviceId: string, handlers: Handlers): Promise<DeviceRpcPipe> => {
    const pipe = { deviceId, handlers, sent: [] as unknown[], closed: false }
    opened.push(pipe)
    return {
      send: async (message) => {
        pipe.sent.push(message)
      },
      close: () => {
        pipe.closed = true
      },
    }
  })
  return { opened, openPipe }
}

describe('device RPC requester', () => {
  it('sends the envelope on the device channel and resolves with the matching reply only', async () => {
    const net = fakeNetwork()
    let n = 0
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: net.openPipe, newRequestId: () => `r${++n}` })

    const call = requester.call('dev-b', 'taskpage.agent.session', { hello: 1 }, { timeoutMs: 5_000 })
    await vi.waitFor(() => expect(net.opened[0]?.sent).toHaveLength(1))
    const pipe = net.opened[0]!
    expect(pipe.deviceId).toBe('dev-b')
    expect(pipe.sent[0]).toEqual({
      type: 'broadcast',
      event: 'broadcast',
      payload: { type: 'taskpage.agent.session', request_id: 'r1', user_id: 'owner-1', payload: { hello: 1 } },
    })

    // 同一条频道上的别人:另一个请求、对不上 id 的应答、对不上类型的应答 —— 都不认。
    pipe.handlers.onMessage({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskpage.sessions.list', request_id: 'phone-1', user_id: 'owner-1', payload: {} } })
    pipe.handlers.onMessage({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskpage.agent.session:reply', request_id: 'someone-else', result: 'no' } })
    pipe.handlers.onMessage({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskpage.sessions.list:reply', request_id: 'r1', result: 'no' } })
    pipe.handlers.onMessage({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskpage.agent.session:reply', request_id: 'r1', result: { ok: true } } })

    await expect(call).resolves.toEqual({ result: { ok: true }, error: undefined })
  })

  it('passes the remote error through as a response, not a throw', async () => {
    const net = fakeNetwork()
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: net.openPipe, newRequestId: () => 'r1' })
    const call = requester.call('dev-b', 'taskpage.agent.session', {}, { timeoutMs: 5_000 })
    await vi.waitFor(() => expect(net.opened[0]?.sent).toHaveLength(1))
    net.opened[0]!.handlers.onMessage({ payload: { type: 'taskpage.agent.session:reply', request_id: 'r1', error: { code: 'unknown_method', message: 'old' } } })
    await expect(call).resolves.toEqual({ result: undefined, error: { code: 'unknown_method', message: 'old' } })
  })

  it('reports no reply within the deadline as a timeout', async () => {
    const net = fakeNetwork()
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: net.openPipe })
    const error = await requester.call('dev-b', 'taskpage.agent.session', {}, { timeoutMs: 30 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeviceRpcTimeoutError)
    expect((error as Error).message).toContain('taskpage.agent.session')
  })

  it('fails the call with the channel error when the channel cannot open, and reopens next time', async () => {
    let attempts = 0
    const openPipe = vi.fn(async (): Promise<DeviceRpcPipe> => {
      attempts += 1
      if (attempts === 1) throw new DeviceRpcChannelError('ssh link: signInRequired', 'signInRequired')
      return { send: async () => undefined, close: () => undefined }
    })
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe })
    const error = await requester.call('dev-b', 'x', {}, { timeoutMs: 1_000 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeviceRpcChannelError)
    expect((error as DeviceRpcChannelError).reason).toBe('signInRequired')
    // 失败的那一条作废,下一次调用重开。
    const second = requester.call('dev-b', 'x', {}, { timeoutMs: 50 }).catch((e: unknown) => e)
    await vi.waitFor(() => expect(openPipe).toHaveBeenCalledTimes(2))
    expect(await second).toBeInstanceOf(DeviceRpcTimeoutError)
  })

  it('rejects every waiting call when the channel closes under it', async () => {
    const net = fakeNetwork()
    let n = 0
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: net.openPipe, newRequestId: () => `r${++n}` })
    const first = requester.call('dev-b', 'x', {}, { timeoutMs: 5_000 }).catch((e: unknown) => e)
    const second = requester.call('dev-b', 'x', {}, { timeoutMs: 5_000 }).catch((e: unknown) => e)
    await vi.waitFor(() => expect(net.opened[0]?.sent).toHaveLength(2))
    expect(net.openPipe).toHaveBeenCalledTimes(1)
    net.opened[0]!.handlers.onClosed(new DeviceRpcChannelError('device channel closed: ssh heartbeat lost', 'closed'))
    expect(await first).toBeInstanceOf(DeviceRpcChannelError)
    expect(await second).toBeInstanceOf(DeviceRpcChannelError)
    expect(net.opened[0]!.closed).toBe(true)
  })

  // #625 先接后断换通道:旧管道退下来后还能替旧窗口说一句告别,之后的问开新管道;拆掉时在途的问才失败。
  it('retires the pipe: later calls open a new one, the retired one can still tell, and closing it fails its calls', async () => {
    const net = fakeNetwork()
    let n = 0
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: net.openPipe, newRequestId: () => `r${++n}` })
    const inFlight = requester.call('dev-b', 'x', {}, { timeoutMs: 5_000 }).catch((e: unknown) => e)
    await vi.waitFor(() => expect(net.opened[0]?.sent).toHaveLength(1))

    const retired = requester.retire('dev-b')!
    void requester.call('dev-b', 'y', {}, { timeoutMs: 5_000 }).catch(() => undefined)
    await vi.waitFor(() => expect(net.opened[1]?.sent).toHaveLength(1))
    expect(net.openPipe).toHaveBeenCalledTimes(2)

    await retired.tell('taskhost.close', { client: 'old-window' })
    const told = net.opened[0]!.sent[1] as { payload: { type: string; payload: unknown } }
    expect(told.payload).toMatchObject({ type: 'taskhost.close', payload: { client: 'old-window' } })
    expect(net.opened[1]!.sent, 'the new pipe carries no farewell').toHaveLength(1)
    expect(net.opened[0]!.closed).toBe(false)

    retired.close(new DeviceRpcChannelError('switched transport', 'closed'))
    expect(await inFlight).toBeInstanceOf(DeviceRpcChannelError)
    expect(net.opened[0]!.closed).toBe(true)
    expect(net.opened[1]!.closed).toBe(false)
    expect(requester.retire('dev-none')).toBeNull()
  })

  it('stops waiting when the caller aborts', async () => {
    const net = fakeNetwork()
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: net.openPipe })
    const controller = new AbortController()
    const call = requester.call('dev-b', 'x', {}, { timeoutMs: 5_000, signal: controller.signal }).catch((e: unknown) => e)
    await vi.waitFor(() => expect(net.opened[0]?.sent).toHaveLength(1))
    controller.abort(new Error('turn cancelled'))
    expect(((await call) as Error).message).toBe('turn cancelled')
  })

  it('hands broadcasts that are not replies to onEvent, and only those', async () => {
    const net = fakeNetwork()
    const events: unknown[] = []
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: net.openPipe, onEvent: (deviceId, payload) => events.push([deviceId, payload]) })
    await requester.open('dev-b')
    const push = { type: 'broadcast', event: 'broadcast', payload: { type: 'taskpage.session.event', subscriptionId: 's1' } }
    net.opened[0]!.handlers.onMessage(push)
    net.opened[0]!.handlers.onMessage({ payload: { type: 'x:reply', request_id: 'nobody', result: 1 } })
    expect(events).toEqual([['dev-b', push]])
  })

  it('drops an idle pipe after a timeout unless the caller keeps it alive', async () => {
    const dropped = fakeNetwork()
    const plain = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: dropped.openPipe })
    await plain.call('dev-b', 'x', {}, { timeoutMs: 20 }).catch(() => undefined)
    expect(dropped.opened[0]!.closed).toBe(true)
    await plain.call('dev-b', 'x', {}, { timeoutMs: 20 }).catch(() => undefined)
    expect(dropped.openPipe).toHaveBeenCalledTimes(2)

    const kept = fakeNetwork()
    const sticky = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe: kept.openPipe, keepAliveOnTimeout: () => true })
    await sticky.call('dev-b', 'x', {}, { timeoutMs: 20 }).catch(() => undefined)
    expect(kept.opened[0]!.closed).toBe(false)
    await sticky.call('dev-b', 'x', {}, { timeoutMs: 20 }).catch(() => undefined)
    expect(kept.openPipe).toHaveBeenCalledTimes(1)
  })

  it('counts opening the pipe against the deadline and never sends a request that already timed out', async () => {
    let finishOpen: (() => void) | null = null
    let opening: Promise<DeviceRpcPipe> | null = null
    const sent: unknown[] = []
    const openPipe = vi.fn(() => (opening = new Promise<DeviceRpcPipe>((resolve) => {
      finishOpen = () => resolve({ send: async (message) => { sent.push(message) }, close: () => undefined })
    })))
    const requester = createDeviceRpcRequester({ userId: async () => 'owner-1', openPipe, keepAliveOnTimeout: () => true })
    const error = await requester.call('dev-b', 'x', {}, { timeoutMs: 20 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeviceRpcTimeoutError)
    finishOpen!()
    // 管道落定之后,让排在它后面的那一步(写不写信封)走完,再看有没有写出去。
    await opening
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(sent).toEqual([])
  })
})

describe('main-process SSH pipe on the shared link (one `gugu-server link` per machine)', () => {
  function fakeLinks(open: { ok: true } | { ok: false; reason: string; detail: string } = { ok: true }) {
    const taps = new Map<string, Set<{ onMessage(m: unknown): void; onClosed(r: string): void }>>()
    const sent: unknown[] = []
    const links = {
      open: vi.fn(async () => open),
      send: vi.fn((_deviceId: string, message: unknown) => {
        sent.push(message)
        return true
      }),
      tap: vi.fn((deviceId: string, handlers: { onMessage(m: unknown): void; onClosed(r: string): void }) => {
        const set = taps.get(deviceId) ?? new Set()
        set.add(handlers)
        taps.set(deviceId, set)
        return () => set.delete(handlers)
      }),
    }
    return { links, taps, sent }
  }

  it('listens on the link the window opened, writes through it, and closing the pipe only stops listening', async () => {
    const { links, taps, sent } = fakeLinks()
    const got: unknown[] = []
    const closed: unknown[] = []
    const pipe = await openSshDeviceRpcPipe(links, 'dev-b', { onMessage: (m) => got.push(m), onClosed: (e) => closed.push(e) })
    for (const tap of taps.get('dev-b')!) tap.onMessage({ hello: 1 })
    expect(got).toEqual([{ hello: 1 }])
    await pipe.send({ ping: 1 })
    expect(sent).toEqual([{ ping: 1 }])
    pipe.close()
    expect(taps.get('dev-b')!.size).toBe(0)
    expect('close' in links).toBe(false)
  })

  it('reports the link closing as a channel error, and a link that will not open as its reason', async () => {
    const { links, taps } = fakeLinks()
    const closed: unknown[] = []
    await openSshDeviceRpcPipe(links, 'dev-b', { onMessage: () => undefined, onClosed: (e) => closed.push(e) })
    for (const tap of taps.get('dev-b')!) tap.onClosed('heartbeat lost')
    expect(closed[0]).toBeInstanceOf(DeviceRpcChannelError)

    const refused = fakeLinks({ ok: false, reason: 'signInRequired', detail: 'auth' })
    const error = await openSshDeviceRpcPipe(refused.links, 'dev-c', { onMessage: () => undefined, onClosed: () => undefined }).catch((e: unknown) => e)
    expect((error as DeviceRpcChannelError).reason).toBe('signInRequired')
    expect(refused.taps.get('dev-c')!.size).toBe(0)
  })
})
