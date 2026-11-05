import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { deliveryWaits, pendingDeliveryMessageIds, visibleDeliveryMessages } from '@gugu/core/shared/ui/systemNotice'

const A = 'agent-a'
const B = 'agent-b'
const mine = (id: string, seq: number, extra: Partial<MessageItem> = {}) => ({
  id, chat_id: 'chat', seq, sender_user_id: 'me', is_mine: true, content: id, content_type: 'text',
  created_at: '2026-10-27T11:00:00Z', retracted_at: null, thread_root_id: null, client_message_id: null, ...extra,
}) as MessageItem
const pending = (id: string, seq: number, agent: string, reason = 'undelivered', extra: Partial<MessageItem> = {}) => ({
  ...mine(id, seq), sender_user_id: agent, is_mine: false, content_type: 'system', client_message_id: `turn-failure:${id}:${reason}`, ...extra,
}) as MessageItem
const undelivered = (...args: Parameters<typeof deliveryWaits>) => [...deliveryWaits(...args)].filter(([, held]) => held.wait === 'undelivered').map(([id]) => id)
const wakes = (entries: Record<string, string[]>) => new Map(Object.entries(entries).map(([id, agents]) => [id, new Set(agents)]))

describe('a message no running instance can take says so on its own bubble', () => {
  it('says nothing on the bubble while the host merely retains it for a busy agent (notAdmitted)', () => {
    const messages = [mine('m1', 1), pending('row', 2, A, 'notAdmitted'), mine('m2', 3)]
    expect(pendingDeliveryMessageIds(messages, {})).toEqual([])
    expect(deliveryWaits(messages, {}, wakes({ m1: [A], m2: [A] })).size).toBe(0)
    expect(visibleDeliveryMessages(messages).map(message => message.id)).toEqual(['m1', 'm2'])
  })

  it('holds the waiting messages, and ones sent after the notice while the agent is still stuck', () => {
    const messages = [mine('m1', 1), mine('m2', 2), pending('row', 3, A), mine('m3', 4)]
    const all = wakes({ m1: [A], m2: [A], m3: [A] })
    expect(pendingDeliveryMessageIds(messages, {})).toEqual(['m1', 'm2', 'm3'])
    expect([...undelivered(messages, {}, all)].sort()).toEqual(['m1', 'm2', 'm3'])
  })

  it('takes a message out as soon as the agent reads it (precise read row or watermark)', () => {
    const messages = [mine('m1', 1, { readers: [A] }), mine('m2', 2), pending('row', 3, A), mine('m3', 4)]
    const all = wakes({ m1: [A], m2: [A], m3: [A] })
    expect([...undelivered(messages, {}, all)].sort()).toEqual(['m2', 'm3'])
    // Everything the row held is taken: the agent is back, m3 goes the ordinary way.
    expect([...undelivered(messages, { [A]: 2 }, all)]).toEqual([])
  })

  it('ends with the row: once everything the row held is read, later messages are not queued by it', () => {
    const messages = [mine('m1', 1), pending('row', 2, A), mine('m2', 3)]
    expect([...undelivered(messages, { [A]: 1 }, wakes({ m1: [A], m2: [A] }))]).toEqual([])
  })

  it('counts only messages that wake that agent (the host’s own record), so a never-delivered one cannot spin forever', () => {
    const messages = [mine('m1', 1), mine('to-b', 2), pending('row', 3, A)]
    expect([...undelivered(messages, {}, wakes({ m1: [A], 'to-b': [B] }))]).toEqual(['m1'])
    expect([...undelivered(messages, {}, new Map())]).toEqual([])
  })

  it('says undelivered when no instance holds the agent, and ignores real failures', () => {
    const all = wakes({ m1: [A] })
    expect(undelivered([mine('m1', 1), pending('row', 2, A, 'undelivered')], {}, all)).toEqual(['m1'])
    expect([...undelivered([mine('m1', 1), pending('row', 2, A, 'weeklyQuota')], {}, all)]).toEqual([])
  })

  it('goes by the message that woke the agent, not the last thing said before the row', () => {
    const messages = [mine('woke', 1), mine('aside', 2), pending('row', 3, A, 'undelivered')]
    expect(undelivered(messages, {}, wakes({ woke: [A] }))).toEqual(['woke'])
    expect(undelivered([mine('woke', 1, { readers: [A] }), mine('aside', 2), pending('row', 3, A, 'undelivered')], {}, wakes({ woke: [A] }))).toEqual([])
    expect(undelivered(messages, { [A]: 1 }, wakes({ woke: [A] }))).toEqual([])
  })

  it('keeps a row on the main line when its message becomes a thread root afterwards', () => {
    const messages = [mine('m1', 1, { is_thread_root: true }), pending('row', 2, A, 'undelivered')]
    expect(undelivered(messages, {}, wakes({ m1: [A] }))).toEqual(['m1'])
    expect(deliveryWaits(messages, {}, wakes({ m1: [A] })).get('m1')?.undeliveredTo).toEqual([A])
  })

  it('follows the agent\'s newest row, and says undelivered when one of two agents is missing', () => {
    expect(undelivered([mine('m1', 1), pending('old', 2, A), pending('new', 3, A, 'notAdmitted')], {}, wakes({ m1: [A] }))).toEqual([])
    const both = [mine('m1', 1), pending('a', 2, A, 'notAdmitted'), pending('b', 3, B, 'undelivered')]
    expect(undelivered(both, {}, wakes({ m1: [A, B] }))).toEqual(['m1'])
    expect(deliveryWaits(both, {}, wakes({ m1: [A, B] })).get('m1')?.undeliveredTo).toEqual([B])
  })

  it('never says it on someone else\'s message', () => {
    expect(undelivered([mine('theirs', 1, { is_mine: false, sender_user_id: 'them' }), pending('row', 2, A, 'undelivered')], {}, wakes({ theirs: [A] }))).toEqual([])
  })

  it('a terminal rejection clears the older retained status and remains visible to the sender', () => {
    const failure = pending('failed', 4, A, 'deliveryRejected')
    const messages = [mine('m1', 1), pending('held', 2, A), mine('m2', 3), failure]
    expect(deliveryWaits(messages, {}, wakes({ m1: [A], m2: [A] })).size).toBe(0)
    expect(pendingDeliveryMessageIds(messages, {})).toEqual([])
    expect(visibleDeliveryMessages(messages).map(message => message.id)).toEqual(['m1', 'm2', 'failed'])
  })

  it('a rejection ends only that agent and thread\'s retained status', () => {
    const messages = [mine('main', 1), mine('thread', 2, { thread_root_id: 't' }),
      pending('a-held', 3, A), pending('b-held', 4, B), pending('thread-held', 5, A, 'undelivered', { thread_root_id: 't' }),
      pending('a-failed', 6, A, 'deliveryRejected')]
    const waits = deliveryWaits(messages, {}, wakes({ main: [A, B], thread: [A] }))
    expect([...waits.keys()].sort()).toEqual(['main', 'thread'])
    // Resolving B leaves only the other thread waiting; A's rejected main-line delivery cannot keep spinning.
    expect([...deliveryWaits(messages, { [B]: 1 }, wakes({ main: [A, B], thread: [A] })).keys()]).toEqual(['thread'])
  })

  it('keeps threads apart', () => {
    const messages = [mine('main', 1), mine('in-thread', 2, { thread_root_id: 't' }), pending('row', 3, A, 'undelivered', { thread_root_id: 't' })]
    expect([...undelivered(messages, {}, wakes({ main: [A], 'in-thread': [A] }))]).toEqual(['in-thread'])
  })

  it('looks nothing up when no agent has a pending row', () => {
    expect(pendingDeliveryMessageIds([mine('m1', 1), pending('row', 2, A, 'generic')], {})).toEqual([])
  })
})
