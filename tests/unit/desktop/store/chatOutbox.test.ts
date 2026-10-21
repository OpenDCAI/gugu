/**
 * #1762 洞③ 发送 outbox 状态机契约锁。
 * 关键不变量:
 * - pending→sending→sent(删行)|failed(可见),退避 2s/8s 共 3 次尝试后 fail-loud;
 * - 幂等由原子 writer 收敛；outbox 不解释 409/唯一键错误，writer 未返回成功就一律真失败；
 * - restore:'sending' 行(死在投递中)视同 pending 重投;
 * - 按会话分道单在途:同会话后续消息不得越过在途重试行(乱序防线);不同会话互不阻塞(C5);
 * - discard:显式丢弃删行,退避中的行停止重试。
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatOutbox } from '../../../../apps/desktop/src/store/chatOutbox'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'
function makeRecord(id: string, over: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    clientMessageId: id,
    chatId: 'chat-1',
    senderUserId: 'user-1',
    payload: {
      content: `msg-${id}`, contentType: 'text', toUserIds: null,
      replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false,
    },
    state: 'pending',
    attempts: 0,
    lastError: null,
    enqueuedAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...over,
  }
}
type Harness = ReturnType<typeof harness>
function harness(deliverImpl: (rec: OutboxRecord) => Promise<void>) {
  const saved = new Map<string, OutboxRecord>()
  const events: string[] = []
  const outbox = createChatOutbox({
    load: async () => [...saved.values()],
    save: async (r) => { saved.set(r.clientMessageId, { ...r }) },
    remove: async (id) => { saved.delete(id) },
    deliver: deliverImpl,
    onState: (r) => events.push(`state:${r.clientMessageId}:${r.state}`),
    onSent: (r) => { events.push(`sent:${r.clientMessageId}`) },
    onDiscarded: (r) => { events.push(`discarded:${r.clientMessageId}`) },
    setTimeout: (fn) => { void Promise.resolve().then(fn); return 0 },
  })
  return { saved, events, outbox }
}
async function settle(h: Harness, rounds = 60) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0))
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
describe('chatOutbox 状态机', () => {
  it('成功路径:pending→sending→sent,行即删', async () => {
    const h = harness(async () => {})
    await h.outbox.enqueue(makeRecord('a'))
    await settle(h)
    expect(h.events).toEqual(['state:a:pending', 'state:a:sending', 'sent:a'])
    expect(h.saved.size).toBe(0)
  })
  it('#2188 enqueue 落盘失败 leaves no row and the same stable id can be handed back', async () => {
    const saved = new Map<string, OutboxRecord>()
    const delivered: string[] = []
    let failNextSave = true
    const outbox = createChatOutbox({
      load: async () => [...saved.values()],
      save: async (r) => {
        if (failNextSave) { failNextSave = false; throw new Error('quota exceeded') }
        saved.set(r.clientMessageId, { ...r })
      },
      remove: async (id) => { saved.delete(id) },
      deliver: async (r) => { delivered.push(r.clientMessageId) },
      onState: () => {},
      onSent: () => {},
      onDiscarded: () => {},
      setTimeout: (fn) => { void Promise.resolve().then(fn); return 0 },
    })
    const ordinaryMessage = makeRecord('stable-message')
    await expect(outbox.enqueue(ordinaryMessage)).rejects.toThrow('quota exceeded')
    expect(saved.size, 'the composer still owns bytes and id before durable enqueue').toBe(0)
    await outbox.enqueue(ordinaryMessage)
    for (let i = 0; i < 60; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(delivered, 'retry reuses the message id after ownership returns from composer').toEqual([
      'stable-message',
    ])
    expect(saved.size).toBe(0)
  })
  it('commit then response loss keeps one backend row and retry reuses the original id', async () => {
    const saved = new Map<string, OutboxRecord>()
    const messageRows = new Map<string, { id: string; content: string }>()
    const deliveries: string[] = []
    let responseVisible = false
    const outbox = createChatOutbox({
      load: async () => [...saved.values()],
      save: async (record) => { saved.set(record.clientMessageId, { ...record }) },
      remove: async (id) => { saved.delete(id) },
      deliver: async (record) => {
        deliveries.push(record.clientMessageId)
        if (!messageRows.has(record.clientMessageId)) {
          messageRows.set(record.clientMessageId, {
            id: record.clientMessageId,
            content: record.payload.content,
          })
        }
        if (!responseVisible) throw new Error('response lost after commit')
        return messageRows.get(record.clientMessageId)
      },
      onState: () => {},
      onSent: () => {},
      onDiscarded: () => {},
      setTimeout: (fn) => { void Promise.resolve().then(fn); return 0 },
    })
    await outbox.enqueue(makeRecord('ordinary-message-id'))
    await settle({ saved, events: [], outbox })
    expect(saved.get('ordinary-message-id')?.state).toBe('failed')
    expect(messageRows.size).toBe(1)
    expect([...new Set(deliveries)]).toEqual(['ordinary-message-id'])
    responseVisible = true
    await outbox.retry('ordinary-message-id')
    await settle({ saved, events: [], outbox })
    expect(saved.size).toBe(0)
    expect(messageRows.size, 'idempotent writer converges every retry to one message row').toBe(1)
    expect([...new Set(deliveries)]).toEqual(['ordinary-message-id'])
  })
  it('持续失败:3 次尝试(2s/8s 退避)后 failed,行保留可见', async () => {
    let calls = 0
    const h = harness(async () => { calls += 1; throw new Error('boom') })
    await h.outbox.enqueue(makeRecord('a'))
    await settle(h)
    expect(calls).toBe(3)
    expect(h.saved.get('a')?.state).toBe('failed')
    expect(h.saved.get('a')?.attempts).toBe(3)
    expect(h.saved.get('a')?.lastError).toBe('boom')
    expect(h.events.at(-1)).toBe('state:a:failed')
  })
  it('raw 409/唯一键错误不能由 outbox 吞成送达', async () => {
    const h = harness(async () => {
      throw new Error('duplicate key value violates unique constraint "messages_client_dedup"')
    })
    await h.outbox.enqueue(makeRecord('a'))
    await settle(h)
    expect(h.events.at(-1)).toBe('state:a:failed')
    expect(h.events).not.toContain('sent:a')
    expect(h.saved.get('a')?.lastError).toContain('messages_client_dedup')
  })
  it('红线:非该约束的错误绝不吞成成功 → failed', async () => {
    const h = harness(async () => { throw new Error('permission denied for table messages') })
    await h.outbox.enqueue(makeRecord('a'))
    await settle(h)
    expect(h.events.at(-1)).toBe('state:a:failed')
    expect(h.events).not.toContain('sent:a')
  })
  it('瞬断恢复:第 2 次尝试成功 → sent', async () => {
    let calls = 0
    const h = harness(async () => { calls += 1; if (calls === 1) throw new Error('transient') })
    await h.outbox.enqueue(makeRecord('a'))
    await settle(h)
    expect(calls).toBe(2)
    expect(h.events.at(-1)).toBe('sent:a')
  })
  it('FIFO 单在途:后一条不得越过前一条的重试期(同会话不乱序)', async () => {
    const order: string[] = []
    let aCalls = 0
    const h = harness(async (rec) => {
      order.push(rec.clientMessageId)
      if (rec.clientMessageId === 'a' && (aCalls += 1) === 1) throw new Error('transient')
    })
    await h.outbox.enqueue(makeRecord('a', { enqueuedAt: '2026-07-07T00:00:00.000Z' }))
    await h.outbox.enqueue(makeRecord('b', { enqueuedAt: '2026-07-07T00:00:01.000Z' }))
    await settle(h)
    expect(order).toEqual(['a', 'a', 'b'])
  })
  it('C5 按会话分道:一个会话卡在投递里,另一个会话的消息照常送达', async () => {
    const stuck = deferred()
    const order: string[] = []
    const saved = new Map<string, OutboxRecord>()
    const events: string[] = []
    // 定时器永不触发:卡住的投递停在「在途」,不被 15s 超时改写成重试(隔离与超时是两件事)
    const outbox = createChatOutbox({
      load: async () => [],
      save: async (r) => { saved.set(r.clientMessageId, { ...r }) },
      remove: async (id) => { saved.delete(id) },
      deliver: async (rec) => {
        order.push(rec.clientMessageId)
        if (rec.chatId === 'chat-stuck') await stuck.promise
      },
      onState: () => {},
      onSent: (r) => { events.push(`sent:${r.clientMessageId}`) },
      onDiscarded: () => {},
      setTimeout: () => 0,
    })
    const h = { saved, events, outbox } as unknown as Harness
    await h.outbox.enqueue(makeRecord('s1', { chatId: 'chat-stuck' }))
    await h.outbox.enqueue(makeRecord('s2', { chatId: 'chat-stuck', enqueuedAt: '2026-07-07T00:00:01.000Z' }))
    await h.outbox.enqueue(makeRecord('o1', { chatId: 'chat-other' }))
    await settle(h)
    // 另一会话不被卡住的会话挡住;卡住的会话内部仍然单在途(s2 不越过 s1)
    expect(h.events).toContain('sent:o1')
    expect(order).toEqual(['s1', 'o1'])
    expect(h.saved.get('s2')?.state).toBe('pending')
    stuck.resolve()
    await settle(h)
    expect(order).toEqual(['s1', 'o1', 's2'])
    expect(h.events.filter((e) => e.startsWith('sent:'))).toEqual(['sent:o1', 'sent:s1', 'sent:s2'])
  })
  it('C5 同会话退避期间不放行后续消息,别的会话照常(车道隔离的阴控)', async () => {
    const order: string[] = []
    let aCalls = 0
    const h = harness(async (rec) => {
      order.push(rec.clientMessageId)
      if (rec.clientMessageId === 'a' && (aCalls += 1) === 1) throw new Error('transient')
    })
    await h.outbox.enqueue(makeRecord('a'))
    await h.outbox.enqueue(makeRecord('b', { enqueuedAt: '2026-07-07T00:00:01.000Z' }))
    await h.outbox.enqueue(makeRecord('x', { chatId: 'chat-2' }))
    await settle(h)
    expect(order.filter((id) => id !== 'x')).toEqual(['a', 'a', 'b'])
    expect(order.indexOf('x')).toBeLessThan(order.lastIndexOf('a'))
  })
  it('C1/C2 prepare:每次尝试先过前置;改写的记录落盘后再投;前置在途时丢弃不复活', async () => {
    const saved = new Map<string, OutboxRecord>()
    const delivered: OutboxRecord[] = []
    const gate = deferred()
    const outbox = createChatOutbox({
      load: async () => [],
      save: async (r) => { saved.set(r.clientMessageId, { ...r }) },
      remove: async (id) => { saved.delete(id) },
      prepare: async (r) => {
        if (r.clientMessageId === 'held') { await gate.promise; return r }
        return { ...r, payload: { ...r.payload, toUserIds: ['peer'] } }
      },
      deliver: async (r) => { delivered.push(r) },
      onState: () => {},
      onSent: () => {},
      onDiscarded: () => {},
      setTimeout: () => 0,
    })
    await outbox.enqueue(makeRecord('a'))
    await outbox.enqueue(makeRecord('held', { chatId: 'chat-2' }))
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(delivered.map((r) => [r.clientMessageId, r.payload.toUserIds])).toEqual([['a', ['peer']]])
    await outbox.discard('held')
    gate.resolve()
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(delivered).toHaveLength(1)
    expect(saved.has('held')).toBe(false)
  })
  it('手动 retry:failed→pending 重投,attempts 归零重新获得自动重试预算', async () => {
    let fail = true
    const h = harness(async () => { if (fail) throw new Error('down') })
    await h.outbox.enqueue(makeRecord('a'))
    await settle(h)
    expect(h.saved.get('a')?.state).toBe('failed')
    fail = false
    await h.outbox.retry('a')
    await settle(h)
    expect(h.events.at(-1)).toBe('sent:a')
    expect(h.saved.size).toBe(0)
  })
  it('retryAllFailed(online kick):全部 failed 自动重投', async () => {
    let fail = true
    const h = harness(async () => { if (fail) throw new Error('down') })
    await h.outbox.enqueue(makeRecord('a'))
    await h.outbox.enqueue(makeRecord('b'))
    await settle(h)
    expect(h.saved.get('a')?.state).toBe('failed')
    expect(h.saved.get('b')?.state).toBe('failed')
    fail = false
    await h.outbox.retryAllFailed()
    await settle(h)
    expect(h.saved.size).toBe(0)
  })
  it('discard:删行 + 回调;已 failed 行丢弃后不再重投', async () => {
    const h = harness(async () => { throw new Error('down') })
    await h.outbox.enqueue(makeRecord('a'))
    await settle(h)
    await h.outbox.discard('a')
    expect(h.events.at(-1)).toBe('discarded:a')
    expect(h.saved.size).toBe(0)
    await h.outbox.retryAllFailed()
    await settle(h)
    expect(h.events.filter((e) => e === 'sent:a')).toEqual([])
  })
  it("restore:'sending' 行(死在投递中)视同 pending 重投并送达", async () => {
    const h = harness(async () => {})
    h.saved.set('a', makeRecord('a', { state: 'sending' }))
    h.saved.set('b', makeRecord('b', { state: 'failed', enqueuedAt: '2026-07-07T00:00:01.000Z' }))
    const restored = await h.outbox.restore()
    expect(restored.map((r) => `${r.clientMessageId}:${r.state}`)).toEqual(['a:pending', 'b:failed'])
    await settle(h)
    expect(h.events).toContain('sent:a')
    expect(h.saved.get('b')?.state).toBe('failed')
  })
  it('投递超时 → 按失败处理(挂起黑洞治理)', async () => {
    let calls = 0
    const h = harness(() => { calls += 1; return new Promise<never>(() => {}) }) // 永不 resolve = 挂起
    await h.outbox.enqueue(makeRecord('a'))
    await settle(h, 200)
    expect(calls).toBe(3)
    expect(h.saved.get('a')?.state).toBe('failed')
    expect(h.saved.get('a')?.lastError).toContain('超时')
  })
  it('dispose during account switch stops backoff delivery and UI callbacks while preserving the durable row', async () => {
    const saved = new Map<string, OutboxRecord>()
    const scheduled: Array<() => void> = []
    const states: string[] = []
    let deliveries = 0
    const outbox = createChatOutbox({
      load: async () => [...saved.values()],
      save: async (record) => { saved.set(record.clientMessageId, { ...record }) },
      remove: async (id) => { saved.delete(id) },
      deliver: async () => { deliveries += 1; throw new Error('offline') },
      onState: (record) => states.push(record.state),
      onSent: () => { states.push('sent') },
      onDiscarded: () => { states.push('discarded') },
      setTimeout: (fn) => { scheduled.push(fn); return fn },
      timeoutMs: 60_000,
      backoffMs: [2_000],
    })
    await outbox.enqueue(makeRecord('account-a-pending'))
    await settle({ saved, events: [], outbox }, 10)
    expect(deliveries).toBe(1)
    const statesBeforeDispose = [...states]
    ;(outbox as typeof outbox & { dispose?: () => void }).dispose?.()
    scheduled.splice(0).forEach((resume) => resume())
    await settle({ saved, events: [], outbox }, 20)
    expect(deliveries).toBe(1)
    expect(states).toEqual(statesBeforeDispose)
    expect(saved.has('account-a-pending')).toBe(true)
  })
})
describe('评审修复回归锁(#1762 review)', () => {
  it('dispose before durable ack starts preserves the row and never enters ack', async () => {
    const saved = new Map<string, OutboxRecord>()
    const deliveryStarted = deferred()
    const releaseDelivery = deferred()
    let ackCalls = 0
    const sent: string[] = []
    const outbox = createChatOutbox({
      load: async () => [],
      save: async (record) => { saved.set(record.clientMessageId, { ...record }) },
      remove: async (id) => { saved.delete(id) },
      ack: async () => { ackCalls += 1 },
      deliver: async () => { deliveryStarted.resolve(); await releaseDelivery.promise },
      onState: () => {},
      onSent: (record) => { sent.push(record.clientMessageId) },
      onDiscarded: () => {},
    })
    await outbox.enqueue(makeRecord('before-ack'))
    await deliveryStarted.promise
    outbox.dispose()
    releaseDelivery.resolve()
    await settle({ saved, events: [], outbox }, 10)
    expect(ackCalls).toBe(0)
    expect(saved.has('before-ack')).toBe(true)
    expect(sent).toEqual([])
  })
  it('durable ack pending does not block later FIFO deliveries', async () => {
    const saved = new Map<string, OutboxRecord>()
    const delivered: string[] = []
    const ackResolvers = new Map<string, () => void>()
    const outbox = createChatOutbox({
      load: async () => [],
      save: async (record) => { saved.set(record.clientMessageId, { ...record }) },
      remove: async (id) => { saved.delete(id) },
      ack: (record) => new Promise<void>((resolve) => {
        ackResolvers.set(record.clientMessageId, () => {
          saved.delete(record.clientMessageId)
          resolve()
        })
      }),
      deliver: async (record) => { delivered.push(record.clientMessageId) },
      onState: () => {},
      onSent: () => {},
      onDiscarded: () => {},
      setTimeout: (fn) => { void Promise.resolve().then(fn); return 0 },
    })
    await outbox.enqueue(makeRecord('a'))
    await outbox.enqueue(makeRecord('b', { enqueuedAt: '2026-07-07T00:00:01.000Z' }))
    await settle({ saved, events: [], outbox })
    expect(delivered).toEqual(['a', 'b'])
    expect([...saved.keys()]).toEqual(['a', 'b'])
    ackResolvers.get('a')?.()
    ackResolvers.get('b')?.()
    await settle({ saved, events: [], outbox })
    expect(saved.size).toBe(0)
  })
  it('[3] onSent 挂起不得卡死队列:后续消息照常投递', async () => {
    let sentCount = 0
    const saved = new Map<string, OutboxRecord>()
    const outbox = createChatOutbox({
      load: async () => [],
      save: async (r) => { saved.set(r.clientMessageId, { ...r }) },
      remove: async (id) => { saved.delete(id) },
      deliver: async () => {},
      onState: () => {},
      onSent: () => { sentCount += 1; return new Promise<never>(() => {}) }, // 永挂的副作用
      onDiscarded: () => {},
      setTimeout: (fn) => { void Promise.resolve().then(fn); return 0 },
    })
    await outbox.enqueue(makeRecord('a'))
    await outbox.enqueue(makeRecord('b', { enqueuedAt: '2026-07-07T00:00:01.000Z' }))
    for (let i = 0; i < 60; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(sentCount).toBe(2) // b 未被 a 的挂起副作用挡住
    expect(saved.size).toBe(0)
  })
  it('[5] 投递在途时丢弃 → 不得被 catch 分支复活(行/库均不残留)', async () => {
    const inflight: { reject?: (err: Error) => void } = {} // box 绕过 TS 闭包赋值窄化
    const saved = new Map<string, OutboxRecord>()
    const events: string[] = []
    const outbox = createChatOutbox({
      load: async () => [],
      save: async (r) => { saved.set(r.clientMessageId, { ...r }) },
      remove: async (id) => { saved.delete(id) },
      deliver: () => new Promise<void>((_res, rej) => { inflight.reject = rej }),
      onState: (r) => events.push(`state:${r.clientMessageId}:${r.state}`),
      onSent: (r) => { events.push(`sent:${r.clientMessageId}`) },
      onDiscarded: (r) => { events.push(`discarded:${r.clientMessageId}`) },
      setTimeout: (fn, ms) => { if (ms < 15_000) void Promise.resolve().then(fn); return 0 },
    })
    await outbox.enqueue(makeRecord('a'))
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)) // 进入在途
    await outbox.discard('a')
    inflight.reject?.(new Error('boom')) // 在途尝试此刻才失败(race 仍挂着,由 drain catch 消化)
    for (let i = 0; i < 60; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(saved.has('a'), '丢弃后 catch 分支不得把行写回持久层').toBe(false)
    expect(events.filter((e) => e.startsWith('state:a:failed'))).toEqual([])
    expect(events.at(-1)).toBe('discarded:a')
  })
  it('[6] delivered():送达 resolve;终态 failed reject;对已 failed 行立即 reject', async () => {
    const ok = harness(async () => {})
    await ok.outbox.enqueue(makeRecord('a'))
    const p = ok.outbox.delivered('a')
    await settle(ok)
    await expect(p).resolves.toBeUndefined()
    const bad = harness(async () => { throw new Error('down') })
    await bad.outbox.enqueue(makeRecord('x'))
    const pxErr = bad.outbox.delivered('x').then(() => null, (e: Error) => e)
    await settle(bad)
    expect((await pxErr)?.message).toBe('down')
    await expect(bad.outbox.delivered('x'), '已是 failed 终态 → 立即 reject 不挂等待者').rejects.toThrow('down')
  })
})
void vi
