// #7233 一问没回 / 线断过又订上:请求方原样重发一次(同一个 request_id),宿主按 request_id 去重 ——
// 已经办过的回上次的答复,❌ 再办一遍(上传的一片、发出去的一句不会重复)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDeviceRpcRequester,
  DeviceRpcChannelError,
  DeviceRpcRefused,
  type DeviceRpcPipe,
  type DeviceRpcPipeHandlers,
} from '../../../../packages/core/src/cloud/deviceRpcRequester'
import { createDeviceRpcRequestHandler } from '../../../../packages/core/src/cloud/deviceRpcResponder'

type Sent = { payload: { type: string; request_id: string; payload: unknown } }

function fakePipes(options: { recover?: boolean } = {}) {
  const pipes: { sent: Sent[]; handlers: DeviceRpcPipeHandlers; recovered: number; closed: boolean }[] = []
  const openPipe = vi.fn(async (_deviceId: string, handlers: DeviceRpcPipeHandlers): Promise<DeviceRpcPipe> => {
    const pipe = { sent: [] as Sent[], handlers, recovered: 0, closed: false }
    pipes.push(pipe)
    return {
      send: async (message) => {
        pipe.sent.push(message as Sent)
      },
      close: () => {
        pipe.closed = true
      },
      ...(options.recover === false ? {} : { recover: () => { pipe.recovered += 1 } }),
    }
  })
  const reply = (index: number, sent: Sent, result: unknown) =>
    pipes[index]!.handlers.onMessage({ type: 'broadcast', event: 'broadcast', payload: { type: `${sent.payload.type}:reply`, request_id: sent.payload.request_id, result } })
  return { pipes, openPipe, reply }
}

const requesterOf = (cloud: ReturnType<typeof fakePipes>) => {
  let id = 0
  return createDeviceRpcRequester({ userId: async () => 'u1', openPipe: cloud.openPipe, newRequestId: () => `req-${++id}` })
}

afterEach(() => vi.useRealTimers())

/** 让开管道、写信封那几步(都在 promise 链上)走完:几个任务边界,❌ 墙钟。 */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('请求方:一问超时,重新报到、原样重发一次', () => {
  it('第一次没回:叫管道 recover,同一个 request_id 再发一次;回了就算数', async () => {
    vi.useFakeTimers()
    const cloud = fakePipes()
    const requester = requesterOf(cloud)
    const call = requester.call('dev', 'taskhost.call', { n: 1 }, { timeoutMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(cloud.pipes[0]!.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cloud.pipes[0]!.recovered).toBe(1)
    expect(cloud.pipes[0]!.sent.map((m) => m.payload.request_id)).toEqual(['req-1', 'req-1'])
    cloud.reply(0, cloud.pipes[0]!.sent[1]!, { value: 'ok' })
    await expect(call).resolves.toEqual({ result: { value: 'ok' }, error: undefined })
  })

  it('重发的那一问也没回:照实超时(说问了两次),❌ 再发第三次', async () => {
    vi.useFakeTimers()
    const cloud = fakePipes()
    const requester = requesterOf(cloud)
    const call = requester.call('dev', 'taskhost.call', {}, { timeoutMs: 1_000 })
    const failed = expect(call).rejects.toThrow(/asked twice/)
    await vi.advanceTimersByTimeAsync(2_000)
    await failed
    expect(cloud.pipes[0]!.sent).toHaveLength(2)
  })

  it('没有 recover 的管道(远程 SSH):第一次超时就照实失败,只发一次', async () => {
    vi.useFakeTimers()
    const cloud = fakePipes({ recover: false })
    const requester = requesterOf(cloud)
    const call = requester.call('dev', 'taskhost.call', {}, { timeoutMs: 1_000 })
    const failed = expect(call).rejects.toThrow(/within 1000 ms$/)
    await vi.advanceTimersByTimeAsync(1_000)
    await failed
    expect(cloud.pipes[0]!.sent).toHaveLength(1)
  })

  it('那台机器明说不接(DeviceRpcRefused,报到被拒):当成这一问的应答交回,❌ 当成线断了', async () => {
    const requester = createDeviceRpcRequester({
      userId: async () => 'u1',
      openPipe: async () => ({
        send: async () => { throw new DeviceRpcRefused({ code: 'unknown_method', message: 'old host' }) },
        close: () => undefined,
      }),
    })
    await expect(requester.call('dev', 'taskhost.open', {}, { timeoutMs: 1_000 })).resolves.toEqual({ error: { code: 'unknown_method', message: 'old host' } })
  })
})

describe('请求方:线断过又订上(rejoined),在途的问换新管道重发一次', () => {
  it('同一个 request_id 发在新管道上;新管道上回了就算数', async () => {
    const cloud = fakePipes()
    const requester = requesterOf(cloud)
    const call = requester.call('dev', 'taskhost.call', { n: 1 }, { timeoutMs: 5_000 })
    await settle()
    expect(cloud.pipes[0]?.sent).toHaveLength(1)
    cloud.pipes[0]!.handlers.onClosed(new DeviceRpcChannelError('rejoined', 'rejoined'))
    await settle()
    expect(cloud.pipes[1]?.sent).toHaveLength(1)
    expect(cloud.pipes[1]!.sent[0]!.payload.request_id).toBe('req-1')
    cloud.reply(1, cloud.pipes[1]!.sent[0]!, { value: 2 })
    await expect(call).resolves.toEqual({ result: { value: 2 }, error: undefined })
  })

  it('别的原因关掉(被拒 / 关了):照旧当场失败', async () => {
    const cloud = fakePipes()
    const requester = requesterOf(cloud)
    const call = requester.call('dev', 'taskhost.call', {}, { timeoutMs: 5_000 })
    await settle()
    expect(cloud.pipes[0]?.sent).toHaveLength(1)
    const forbidden = new Error('forbidden')
    cloud.pipes[0]!.handlers.onClosed(forbidden)
    await expect(call).rejects.toBe(forbidden)
    expect(cloud.pipes).toHaveLength(1)
  })

  it('换上新管道又断过一次:不再重发(只一次),照实失败', async () => {
    const cloud = fakePipes()
    const requester = requesterOf(cloud)
    const call = requester.call('dev', 'taskhost.call', {}, { timeoutMs: 5_000 })
    await settle()
    expect(cloud.pipes[0]?.sent).toHaveLength(1)
    cloud.pipes[0]!.handlers.onClosed(new DeviceRpcChannelError('rejoined', 'rejoined'))
    await settle()
    expect(cloud.pipes[1]?.sent).toHaveLength(1)
    cloud.pipes[1]!.handlers.onClosed(new DeviceRpcChannelError('rejoined again', 'rejoined'))
    await expect(call).rejects.toMatchObject({ reason: 'rejoined' })
    expect(cloud.pipes).toHaveLength(2)
  })
})

describe('宿主按 request_id 去重', () => {
  const envelope = (requestId: string, type = 'session.send') => ({ type, request_id: requestId, user_id: 'u1', payload: { text: 'hi' } })

  it('同一问来两次:只办一次,两次都回同一个答复', async () => {
    const handler = vi.fn(async () => ({ result: { sent: true } }))
    const handle = createDeviceRpcRequestHandler({ handlers: { 'session.send': handler } })
    const replies: unknown[] = []
    await handle(envelope('r1'), (reply) => { replies.push(reply) })
    await handle(envelope('r1'), (reply) => { replies.push(reply) })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(replies).toEqual([
      { type: 'session.send:reply', request_id: 'r1', result: { sent: true }, error: undefined },
      { type: 'session.send:reply', request_id: 'r1', result: { sent: true }, error: undefined },
    ])
  })

  it('第一次还在办时又来一次:等它办完,只办一次', async () => {
    // 每次调用的 resolve 都留着、最后全放掉:没去重时第二次调用不会盖掉第一次的 resolve 让它永远挂着 —— 当场红,❌ 等超时。
    const finishers: ((value: { result: unknown }) => void)[] = []
    const handler = vi.fn(() => new Promise<{ result: unknown }>((resolve) => { finishers.push(resolve) }))
    const handle = createDeviceRpcRequestHandler({ handlers: { 'session.send': handler } })
    const replies: unknown[] = []
    const first = handle(envelope('r1'), (reply) => { replies.push(reply) })
    const second = handle(envelope('r1'), (reply) => { replies.push(reply) })
    await settle()
    const callsWhileBusy = handler.mock.calls.length
    for (const finish of finishers) finish({ result: 1 })
    await Promise.all([first, second])
    expect(callsWhileBusy).toBe(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(replies).toHaveLength(2)
  })

  it('不同的 request_id 各办各的', async () => {
    const handler = vi.fn(async () => ({ result: 1 }))
    const handle = createDeviceRpcRequestHandler({ handlers: { 'session.send': handler } })
    await handle(envelope('r1'), () => undefined)
    await handle(envelope('r2'), () => undefined)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('大答复(一张图)不留:重发时再取一次 —— 它是读', async () => {
    const big = 'x'.repeat(200_000)
    const handler = vi.fn(async () => ({ result: { value: big } }))
    const handle = createDeviceRpcRequestHandler({ handlers: { 'taskhost.call': handler } })
    await handle(envelope('r1', 'taskhost.call'), () => undefined)
    await handle(envelope('r1', 'taskhost.call'), () => undefined)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('处理器拿得到这一问来自哪个发问端(经它开的窗口在发问端离开时关掉)', async () => {
    const handler = vi.fn(async (_payload: unknown, ctx: { asker?: { id: string } }) => ({ result: ctx.asker?.id }))
    const handle = createDeviceRpcRequestHandler({ handlers: { 'taskhost.open': handler as never } })
    const asker = { id: 'askerAAAA1111', onDetached: () => () => undefined }
    const replies: unknown[] = []
    await handle(envelope('r1', 'taskhost.open'), (reply) => { replies.push(reply) }, undefined, asker)
    expect(replies[0]).toMatchObject({ result: 'askerAAAA1111' })
  })
})
