/**
 * 论坛来源(forumInbox.ts):帖内事件 → 读者的一行(信封 route="forum",回程 forum_reply);受理后按帖子确认 seq;
 * 失败记在指派上,分「没受理」(undelivered,会重投)与「受理了、那一轮失败」(turn_failed);❌ 写进任何聊天。
 * 哪件事叫醒谁不在这里(库里的 forum_event_wakes_agent,sb 的 forum.test.ts 盯)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pullAgentInbox,
  resetAgentInboxReaderStateForTests,
  type AgentInboxReaderDeps,
  type AgentInboxUnreadRow,
} from '@gugu/core/local/agent/agentInboxReader'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { forumEventId, forumRowFromRpc } from '@gugu/core/local/agent/forumInbox'

const AGENT = '0a000000-0000-4000-8000-000000000001'
const POST = '0b000000-0000-4000-8000-000000000002'
const OWNER = '0c000000-0000-4000-8000-000000000003'
const REPLY = '0d000000-0000-4000-8000-000000000004'

type Raw = Parameters<typeof forumRowFromRpc>[0]
const raw = (over: Partial<Raw>): Raw => ({
  post_id: POST,
  seq: 1,
  kind: 'assigned',
  entity_id: AGENT,
  actor_user_id: OWNER,
  actor_name: '林晓',
  actor_is_agent: false,
  created_at: '2026-10-20T15:00:00.000Z',
  post_title: '并发问题',
  post_body: '这段代码为什么会死锁?',
  post_author_id: OWNER,
  post_author_name: '林晓',
  bounty: { amount: 30, visibility: 'poster_only', deadline_at: '2026-10-23T15:00:00.000Z', status: 'open', awards: [] },
  reply_body: null,
  reply_to_poster_only: null,
  reply_to: null,
  reply_count: 0,
  ...over,
})

describe('a forum event as a delivery', () => {
  it('first assignment on a post with no replies: the post body, route forum, answered with forum_reply', () => {
    const row = forumRowFromRpc(raw({}))
    expect(row.forum).toMatchObject({ postId: POST, seq: 1 })
    expect(row.id).toBe(forumEventId(POST, 1))
    const reading = readDeliveryEnvelope(row.forum!.envelope)!
    const facts = reading.segments[0]!.facts!
    expect(facts).toMatchObject({ route: 'forum', post: `post:${POST}`, from: '林晓', fromId: `user:${OWNER}`, messageId: `msg:${forumEventId(POST, 1)}` })
    expect(facts.messageContext).toContain('assigned you')
    expect(facts.messageContext).toContain('0 replies so far')
    expect(reading.body).toBe('这段代码为什么会死锁?')
    expect(row.forum!.envelope).toMatch(/reply with catalog_call \{ tool: (&quot;|")forum_reply/)
  })

  it('a reply carries its own id and says when it is for the poster only', () => {
    const row = forumRowFromRpc(raw({ seq: 4, kind: 'reply', entity_id: REPLY, reply_body: '换个锁的顺序', reply_to_poster_only: true }))
    const facts = readDeliveryEnvelope(row.forum!.envelope)!.segments[0]!.facts!
    expect(facts.messageContext).toContain(`new reply reply:${REPLY} (for the poster only)`)
    expect(row.content).toBe('换个锁的顺序')
  })

  it('a settlement by expiry has no sender: it comes from 咕咕', () => {
    const row = forumRowFromRpc(raw({
      seq: 9, kind: 'settled', entity_id: POST, actor_user_id: null, actor_name: null,
      bounty: { amount: 30, visibility: 'public', deadline_at: '2026-10-23T15:00:00.000Z', status: 'refunded', awards: [] },
    }))
    const facts = readDeliveryEnvelope(row.forum!.envelope)!.segments[0]!.facts!
    expect(facts).toMatchObject({ route: 'forum', from: '咕咕系统', fromId: 'system:gugu' })
    expect(row.content).toContain('no answers')
  })

  it('the event id is stable across re-deliveries and differs between events', () => {
    expect(forumEventId(POST, 3)).toBe(forumEventId(POST, 3))
    expect(forumEventId(POST, 3)).not.toBe(forumEventId(POST, 4))
    expect(forumEventId(POST, 3)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('the reader with the forum source', () => {
  beforeEach(() => resetAgentInboxReaderStateForTests())

  function deps(over: Partial<AgentInboxReaderDeps> & { forum: AgentInboxUnreadRow[] }) {
    const acks: Array<{ postId: string; seq: number }> = []
    const failures: Array<{ postId: string; state: string }> = []
    const chatDisclosures: string[] = []
    let forum = over.forum
    const value: AgentInboxReaderDeps = {
      accessToken: 'token',
      fetchUnread: async () => [],
      fetchForumUnread: async () => forum,
      ackForum: async (input) => {
        acks.push({ postId: input.postId, seq: input.seq })
        forum = forum.filter((row) => row.forum!.seq > input.seq)
      },
      recordForumFailure: async (input) => { failures.push({ postId: input.postId, state: input.state }) },
      postDisclosure: async (input) => { chatDisclosures.push(input.chatId) },
      inject: async () => 'accepted',
      ...over,
    }
    return { value, acks, failures, chatDisclosures }
  }

  it('admitted: acked per post up to its seq, and pulled no more', async () => {
    const rows = [forumRowFromRpc(raw({ seq: 1 })), forumRowFromRpc(raw({ seq: 2, kind: 'reply', entity_id: REPLY, reply_body: '补充' }))]
    const injected: string[] = []
    const d = deps({ forum: rows, inject: async (input) => { injected.push(input.text); return 'accepted' } })
    const result = await pullAgentInbox(AGENT, d.value)
    expect(result).toMatchObject({ pulled: 2, injected: 2, verdict: 'accepted' })
    expect(d.acks).toEqual([{ postId: POST, seq: 1 }, { postId: POST, seq: 2 }])
    expect(injected.every((text) => text.startsWith('<gugu_delivery route="forum"'))).toBe(true)
    expect(await pullAgentInbox(AGENT, d.value)).toMatchObject({ pulled: 0, verdict: 'idle' })
  })

  it('not admitted (the injection throws): recorded as undelivered on the assignment, not acked, nothing in a chat', async () => {
    const d = deps({ forum: [forumRowFromRpc(raw({}))], inject: async () => { throw new Error('no runtime') } })
    await expect(pullAgentInbox(AGENT, d.value)).rejects.toThrow('no runtime')
    expect(d.failures).toEqual([{ postId: POST, state: 'undelivered' }])
    expect(d.acks).toEqual([])
    expect(d.chatDisclosures).toEqual([])
  })

  it('admitted but the turn failed: acked (no rerun) and recorded as turn_failed', async () => {
    const d = deps({
      forum: [forumRowFromRpc(raw({}))],
      inject: async () => ({ verdict: 'accepted', completion: Promise.reject(new Error('model unavailable')) }),
    })
    const result = await pullAgentInbox(AGENT, d.value)
    await expect(result.completion).rejects.toThrow('model unavailable')
    expect(d.acks).toEqual([{ postId: POST, seq: 1 }])
    expect(d.failures).toEqual([{ postId: POST, state: 'turn_failed' }])
    expect(d.chatDisclosures).toEqual([])
  })

  it('session not live: forum rows stay for the next trigger (not acked, no failure)', async () => {
    const d = deps({ forum: [forumRowFromRpc(raw({}))], inject: async () => 'not-live' })
    expect(await pullAgentInbox(AGENT, d.value)).toMatchObject({ verdict: 'not-live', injected: 0 })
    expect(d.acks).toEqual([])
    expect(d.failures).toEqual([])
  })

  it('control: without a forum source the reader pulls only chats, as before — no forum request at all', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
    const d = deps({ forum: [] })
    delete (d.value as Partial<AgentInboxReaderDeps>).fetchForumUnread
    expect(await pullAgentInbox(AGENT, d.value)).toMatchObject({ pulled: 0, verdict: 'idle' })
    expect(network).not.toHaveBeenCalled()
    network.mockRestore()
  })
})
