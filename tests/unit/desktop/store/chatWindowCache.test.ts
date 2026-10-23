import { describe, expect, it, vi } from 'vitest'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'
import { message } from '../../../support/testHarness'

const row = (seq: number) => message({ id: `m-${seq}`, chat_id: 'chat', seq, is_mine: false })
describe('cached scoped history ownership', () => {
  it('slides the observed stream at 120 and releases its controller when closed', () => {
    const cache = new ChatWindowCache(), history = cache.history('chat')
    const stop = cache.subscribe('chat', () => undefined)
    for (let seq = 1; seq <= 2000; seq++) cache.set('chat', [...(cache.get('chat') ?? []), row(seq)])
    expect(cache.get('chat')?.map((item) => item.seq)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1881))
    expect(cache.get('chat')).toBe(history.getSnapshot().messages)
    stop()
    expect(cache.get('chat')).toHaveLength(40)
    expect(cache.history('chat')).not.toBe(history)
  })
  it('publishes history state even when the row reference stays the same', () => {
    const cache = new ChatWindowCache(), history = cache.history('chat'), observe = vi.fn()
    const stop = cache.subscribe('chat', observe)
    cache.set('chat', Array.from({ length: 120 }, (_, index) => row(index + 1)))
    history.setFollowingTail(false)
    cache.set('chat', [...(cache.get('chat') ?? []), row(121)])
    expect(history.getSnapshot()).toMatchObject({ hasNewer: true, newMessageCount: 1 })
    expect(cache.get('chat')).toHaveLength(120)
    expect(cache.get('chat')?.at(0)?.seq).toBe(1)
    expect(cache.get('chat')?.at(-1)?.seq).toBe(120)
    expect(observe).toHaveBeenCalled()
    stop()
  })
  it('protects each history reader and withdraws its reading when that viewport leaves', () => {
    const cache = new ChatWindowCache(), history = cache.history('chat')
    const tail = {}, older = {}
    const stopTail = cache.subscribe('chat', () => undefined, undefined, tail)
    const stopOlder = cache.subscribe('chat', () => undefined, undefined, older)
    cache.set('chat', Array.from({ length: 120 }, (_, index) => row(index + 1)))
    cache.setFollowingTail('chat', older, false)
    cache.setFollowingTail('chat', tail, true)
    expect(history.isFollowingTail()).toBe(false)
    expect(history.followForSend()).toBe(false)
    expect(history.isFollowingTail()).toBe(false)
    stopOlder()
    expect(history.isFollowingTail()).toBe(true)
    cache.set('chat', [...cache.get('chat')!, row(121)])
    expect(cache.get('chat')?.map((message) => message.seq)).toEqual(Array.from({ length: 120 }, (_, index) => index + 2))
    stopTail()
  })

  it('keeps pending sends and rejects a page completed after its last observer leaves', async () => {
    const cache = new ChatWindowCache(), history = cache.history('chat')
    const stop = cache.subscribe('chat', () => undefined)
    cache.set('chat', Array.from({ length: 120 }, (_, index) => row(index + 201)))
    const pending = message({ id: 'pending', chat_id: 'chat', seq: -1, is_mine: true, local_send_state: 'sending' })
    cache.set('chat', [...(cache.get('chat') ?? []), pending])
    expect(cache.get('chat')).toHaveLength(120)
    expect(cache.get('chat')?.at(-1)).toBe(pending)
    let resolve!: (rows: ReturnType<typeof row>[]) => void
    const read = history.load('older', () => new Promise((done) => { resolve = done }))
    stop(); resolve([row(1)])
    expect(await read).toBe(false)
    expect(cache.get('chat')?.some((item) => item.seq === 1)).toBe(false)
  })
})
