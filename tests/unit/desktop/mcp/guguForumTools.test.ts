/**
 * 论坛的两个 agent 工具:都以 agent 自己的身份调库(p_as = 它),❌ 以主人的视角;都在目录里,route="forum" 的信封写明经
 * catalog_call 调。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the MCP tool implementation is an untyped ESM module.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { GUGU_LISTED_TOOLS } from '../../../../apps/desktop/electron/mcp/gugu-catalog-tools'

const AGENT = '0a000000-0000-4000-8000-000000000001'
const POST = '0b000000-0000-4000-8000-000000000002'
const REPLY = '0d000000-0000-4000-8000-000000000004'
const CONTEXT = {
  supabaseUrl: 'http://db.test',
  anonKey: 'anon',
  agentId: AGENT,
  threadRootId: null,
  guguHome: '/tmp/gugu-forum-tools-test',
  getAccessToken: async () => 'owner-token',
}

function fakeDb(answer: unknown) {
  const calls: Array<{ url: string; profile: string | null; body: Record<string, unknown> }> = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, profile: new Headers(init.headers).get('Content-Profile'), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  return { calls, fetch }
}

describe('forum tools', () => {
  it('both are in the catalog, not listed: a forum delivery says how to call them (every session would pay for them, #7335)', () => {
    expect(GUGU_LISTED_TOOLS.has('forum_reply')).toBe(false)
    expect(GUGU_LISTED_TOOLS.has('forum_read')).toBe(false)
  })

  it('forum_reply posts as the agent itself, in the post the delivery named', async () => {
    const db = fakeDb(REPLY)
    const out = await callTool(CONTEXT, 'forum_reply', { post_id: `post:${POST}`, text: '换个锁的顺序', reply_to: `reply:${REPLY}` }, { fetch: db.fetch })
    expect(db.calls).toEqual([{
      url: 'http://db.test/rest/v1/rpc/forum_reply',
      profile: 'public',
      body: { p_post_id: POST, p_body: '换个锁的顺序', p_reply_to: REPLY, p_as: AGENT },
    }])
    expect(out).toBe(`Posted reply:${REPLY} in post:${POST}.`)
  })

  it('a bare id is refused before anything is sent', async () => {
    const db = fakeDb(REPLY)
    await expect(callTool(CONTEXT, 'forum_reply', { post_id: POST, text: 'x' }, { fetch: db.fetch })).rejects.toThrow(/expected a post: id/)
    expect(db.calls).toEqual([])
  })

  it('forum_read reads as the agent and hands back typed ids', async () => {
    const db = fakeDb({
      seq: 3,
      post: { id: POST, title: '并发问题', body: '为什么死锁?', created_at: 't0', author_user_id: 'u1', author_name: '林晓' },
      bounty: { amount: 30, visibility: 'poster_only', status: 'open', deadline_at: 't9', awards: [] },
      replies: [{ id: REPLY, body: '我的回答', created_at: 't1', to_poster_only: true, reply_to: null, author_user_id: AGENT, author_name: '助手', author_is_agent: true, owner_name: 'Bob' }],
      reactions: [{ target_kind: 'reply', target_id: REPLY, emoji: '👍', count: 2, mine: false }],
      assignments: [],
    })
    const out = JSON.parse(await callTool(CONTEXT, 'forum_read', { post_id: `post:${POST}` }, { fetch: db.fetch }))
    expect(db.calls[0]!.body).toEqual({ p_post_id: POST, p_as: AGENT })
    expect(out.post.id).toBe(`post:${POST}`)
    expect(out.bounty).toMatchObject({ amount: 30, answers: 'for the poster only until it settles', status: 'open' })
    expect(out.replies).toEqual([{
      id: `reply:${REPLY}`, author: { id: `user:${AGENT}`, name: '助手', agent: true, owner: 'Bob' }, for_poster_only: true,
      created_at: 't1', body: '我的回答', reactions: ['👍×2'],
    }])
  })
})
