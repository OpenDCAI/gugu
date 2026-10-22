import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — MCP implementation is an untyped ESM module.
import { callTool, callToolWithState, createSessionState, RpcHttpError } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

// #84 主人与好友的私聊:message_conversations 列出来,message_history / message_search 按主人本人读,
// message_send / message_send_file 指去代发工具。agent 不是这些私聊的成员,读的是主人的可见域。
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FRIEND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EX_FRIEND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const STRANGER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'agent-1'
const token = `x.${Buffer.from(JSON.stringify({ sub: OWNER })).toString('base64url')}.x`
const context = { agentId: AGENT, threadRootId: null, getAccessToken: async () => token }

const chatRow = (chat_id: string, kind: string, last_message_at: string | null, name: string | null = null) => ({
  chat_id, public_id: 100, kind, status: 'active', name, role: 'member', listen_mode: 'active', last_message_at, last_message_preview: `preview of ${chat_id}`,
})
// agent 自己在的会话;主人的会话(和好友、和已删好友、和本 agent 的私聊,外加一个群)。
const agentChats = [chatRow('group-1', 'group', '2026-10-22T09:00:00Z', 'Team'), chatRow('agent-dm', 'dm', '2026-10-22T07:00:00Z')]
const ownerChats = [
  chatRow('friend-dm', 'dm', '2026-10-22T08:00:00Z'),
  chatRow('ex-friend-dm', 'dm', '2026-10-22T10:00:00Z'),
  chatRow('agent-dm', 'dm', '2026-10-22T07:00:00Z'),
  chatRow('group-1', 'group', '2026-10-22T09:00:00Z', 'Team'),
]
const members: Record<string, string[]> = {
  'friend-dm': [OWNER, FRIEND],
  'ex-friend-dm': [OWNER, EX_FRIEND],
  'agent-dm': [OWNER, AGENT],
  // 别人直接和本 agent 开的私聊,主人不在里面(主人令牌直读这条线的成员行是空的)。
  'stranger-agent-dm': [STRANGER, AGENT],
}
const kinds: Record<string, string> = { 'friend-dm': 'dm', 'ex-friend-dm': 'dm', 'agent-dm': 'dm', 'stranger-agent-dm': 'dm', 'group-1': 'group' }
// 每条线里各一条附件消息(新式:指向会话「附件」里的某一版)。
const attachmentMessages: Record<string, { chat_id: string }> = {
  '00000000-0000-4000-8000-0000000000f1': { chat_id: 'friend-dm' },
  '00000000-0000-4000-8000-0000000000a1': { chat_id: 'agent-dm' },
  '00000000-0000-4000-8000-0000000000e1': { chat_id: 'ex-friend-dm' },
}
const membersOf = (chatId: string) => (chatId === 'group-1' ? [OWNER, AGENT] : members[chatId] ?? [])

function fakeDb({ staleOnce }: { staleOnce?: string } = {}) {
  const rpcs: Array<[string, Record<string, unknown>]> = []
  const reads: string[] = []
  const inserts: unknown[] = []
  let stale = staleOnce
  const restRpc = async (name: string, body: Record<string, unknown>) => {
    rpcs.push([name, body])
    // 令牌刚过期:这一条 RPC 第一次回 401,换新令牌重放后照常。
    if (name === stale) { stale = undefined; throw new RpcHttpError(401, { accessToken: 'STALE' }) }
    if (name === 'list_my_chats_as') return body.p_as_user_id === OWNER ? ownerChats : agentChats
    // 照库里的可见域:agent 在,或调用者(主人)在,就给整份名单 —— 所以主人与好友的私聊 agent 也读得到名单。
    if (name === 'list_member_ids') {
      const ids = String(body.p_chat_id) === 'group-1' ? [OWNER, AGENT] : members[String(body.p_chat_id)] ?? []
      return ids.includes(AGENT) || ids.includes(OWNER) ? ids.map((user_id) => ({ user_id, role: 'member', listen_mode: 'active' })) : []
    }
    if (name === 'create_topic') return [{ chat_id: 'topic-x' }]
    // 照库里的 can_read_message:按传进来的那个人判,他是那条线的成员才看得见。
    if (name === 'can_read_message') {
      const message = attachmentMessages[String(body.p_message_id)]
      return Boolean(message && membersOf(message.chat_id).includes(String(body.p_user_id)))
    }
    if (name === 'chat_facts') return [{ id: body.p_chat_id, kind: kinds[String(body.p_chat_id)], source_chat_id: null, group_prompt: null }]
    if (name === 'message_history_as' || name === 'message_search_as') return [{ id: 'm1', seq: 3, sender_user_id: FRIEND, content: '下午见' }]
    throw new Error(`unexpected rpc: ${name}`)
  }
  const restGet = async (path: string) => {
    reads.push(path)
    if (path.startsWith('friendships?')) return [{ user_a_id: FRIEND, user_b_id: OWNER }]
    if (path.startsWith('chat_members?chat_id=in.(')) {
      const ids = decodeURIComponent(path.slice('chat_members?chat_id=in.('.length, path.indexOf(')'))).split(',')
      return ids.flatMap((chat_id) => (members[chat_id] ?? []).map((user_id) => ({ chat_id, user_id })))
    }
    if (path.startsWith('chat_members?user_id=eq.')) return [{ chat_id: 'friend-dm' }] // 主人置顶了和这位好友的私聊
    if (path.startsWith(`users?id=in.(`)) return [{ id: FRIEND, display_name: 'shuxue', type: 'human' }]
    if (path.startsWith(`users?id=eq.${FRIEND}&`)) return [{ type: 'human' }]
    if (path.startsWith('contact_overrides?')) return [{ contact_user_id: FRIEND, alias: '费俊杰' }]
    if (path.startsWith('messages?id=eq.')) {
      const id = path.slice('messages?id=eq.'.length).split('&')[0]
      const message = attachmentMessages[id]
      return message ? [{ id, chat_id: message.chat_id, content: '[附件] 报告.pdf (application/pdf)\n[Size] 5\n[Kind] file', content_type: 'attachment', file_item_id: `item-${id}`, file_version: 1, file_blob_id: null }] : []
    }
    throw new Error(`unexpected read: ${path}`)
  }
  const restInsert = async (_table: string, row: unknown) => { inserts.push(row) }
  const signedAs: unknown[] = []
  // attachments/urls:记下以谁的身份要的签名链接。
  const attachmentUrls = async (refs: Array<Record<string, unknown>>, asUserId?: string) => {
    signedAs.push(asUserId)
    return { urls: refs.map((ref) => ({ ...ref, message_id: null, url: 'https://cdn.test/report?auth_key=k', thumb_url: null, sha256: null, width: null, height: null, expires_at: '2999-01-01T00:00:00Z' })) }
  }
  const fetchBytes = async () => Buffer.from('bytes')
  return { deps: { restRpc, restGet, restInsert, attachmentUrls, fetchBytes }, rpcs, reads, inserts, signedAs }
}

describe('owner DMs with friends (#84)', () => {
  it('message_conversations lists the owner\'s friend DMs beside the agent\'s own chats, latest message first', async () => {
    const db = fakeDb()
    const out = JSON.parse(await callTool(context, 'message_conversations', {}, db.deps))
    expect(out.items.map((row: { id: string }) => row.id)).toEqual(['group-1', 'friend-dm', 'agent-dm'])
    expect(out.items[1]).toEqual({
      id: 'friend-dm', public_id: 100, kind: 'dm', status: 'active', name: '费俊杰', owner_dm: true,
      friend_user_id: `user:${FRIEND}`, friend_display_name: 'shuxue', pinned: true,
      last_message_at: '2026-10-22T08:00:00Z', last_message_preview: 'preview of friend-dm',
    })
    // 已删好友的私聊不列;本 agent 自己那条私聊只按 agent 自己列一次,不标 owner_dm。
    expect(out.items[2].owner_dm).toBeUndefined()
    expect(db.rpcs.filter(([name]) => name === 'list_my_chats_as').map(([, body]) => body.p_as_user_id).sort()).toEqual([AGENT, OWNER].sort())
  })

  it('finds a friend DM by the owner\'s remark or by the friend\'s own name', async () => {
    for (const name of ['俊杰', 'shuxue']) {
      const out = JSON.parse(await callTool(context, 'message_conversations', { name, kind: 'dm' }, fakeDb().deps))
      expect(out.items.map((row: { id: string }) => row.id)).toEqual(['friend-dm'])
    }
  })

  it('message_history and message_search read a friend DM as the owner and everything else as the agent', async () => {
    const db = fakeDb()
    await callTool(context, 'message_history', { chat_id: 'friend-dm' }, db.deps)
    await callTool(context, 'message_search', { chat_id: 'friend-dm', query: '见' }, db.deps)
    await callTool(context, 'message_history', { chat_id: 'group-1' }, db.deps)
    await callTool(context, 'message_history', { chat_id: 'agent-dm' }, db.deps)
    await callTool(context, 'message_history', { chat_id: 'ex-friend-dm' }, db.deps)
    const readers = db.rpcs.filter(([name]) => name === 'message_history_as' || name === 'message_search_as')
      .map(([name, body]) => [name, body.p_chat_id, body.p_as_user_id])
    expect(readers).toEqual([
      ['message_history_as', 'friend-dm', OWNER],
      ['message_search_as', 'friend-dm', OWNER],
      ['message_history_as', 'group-1', AGENT],
      ['message_history_as', 'agent-dm', AGENT],
      // 不再是好友:不按主人读,按 agent 自己读(它不在里面,库里读不到)。
      ['message_history_as', 'ex-friend-dm', AGENT],
    ])
    // 不是私聊的会话不为此多读一行。
    expect(db.reads.filter((path) => path.includes('group-1'))).toEqual([])
  })

  it('a DM the agent is in, even one the owner is not in, is checked once per session and never against the owner\'s friends', async () => {
    const db = fakeDb()
    const state = createSessionState()
    for (const chatId of ['stranger-agent-dm', 'stranger-agent-dm', 'agent-dm', 'agent-dm']) {
      await callToolWithState(context, 'message_history', { chat_id: chatId }, db.deps, state)
    }
    expect(db.rpcs.filter(([name]) => name === 'message_history_as').map(([, body]) => body.p_as_user_id)).toEqual([AGENT, AGENT, AGENT, AGENT])
    expect(db.rpcs.filter(([name]) => name === 'list_member_ids').map(([, body]) => body.p_chat_id)).toEqual(['stranger-agent-dm', 'agent-dm'])
    expect(db.reads.filter((path) => path.startsWith('chat_members?chat_id') || path.startsWith('friendships'))).toEqual([])
  })

  it('message_send to a friend DM points to message_send_as_owner and writes nothing', async () => {
    const db = fakeDb()
    await expect(callTool(context, 'message_send', { chat_id: 'friend-dm', text: '好的' }, db.deps))
      .rejects.toThrow(`use message_send_as_owner with friend_user_id user:${FRIEND}`)
    expect(db.inserts).toEqual([])
  })

  it('message_send in a DM the agent is in sends as before, with no extra reads for the owner-DM check', async () => {
    const db = fakeDb()
    expect(await callTool(context, 'message_send', { chat_id: 'agent-dm', text: '收到' }, db.deps)).toMatch(/^sent \(id=/)
    expect(db.inserts).toHaveLength(1)
    expect(db.reads.filter((path) => path.startsWith('chat_members?chat_id') || path.startsWith('friendships'))).toEqual([])
  })

  it('a DM send whose first read hits an expired token still refreshes and retries', async () => {
    for (const staleOnce of ['chat_facts', 'list_member_ids']) {
      const db = fakeDb({ staleOnce })
      expect(await callTool(context, 'message_send', { chat_id: 'agent-dm', text: '收到' }, db.deps)).toMatch(/^sent \(id=/)
      expect(db.inserts).toHaveLength(1)
    }
  })

  it('topic_open cannot grow a topic out of a friend DM (it would pull the friend in and post into that DM)', async () => {
    const db = fakeDb()
    await expect(callTool(context, 'topic_open', { chat_id: 'friend-dm', source_message_id: 'msg:00000000-0000-4000-8000-000000000001' }, db.deps))
      .rejects.toThrow(`use message_send_as_owner with friend_user_id user:${FRIEND}`)
    expect(db.rpcs.map(([name]) => name)).not.toContain('create_topic')
  })

  describe('message_download_file', () => {
    const homes: string[] = []
    afterAll(async () => { await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))) })
    const download = async (messageId: string, db = fakeDb()) => {
      const home = await mkdtemp(join(tmpdir(), 'gugu-84-download-'))
      homes.push(home)
      const out = await callTool({ ...context, guguHome: home }, 'message_download_file', { source_message_id: `msg:${messageId}` }, db.deps)
      return { out: String(out), db }
    }

    it('a file in a friend DM is read and signed as the owner, and saved', async () => {
      const { out, db } = await download('00000000-0000-4000-8000-0000000000f1')
      expect(db.signedAs).toEqual([OWNER])
      expect(db.rpcs.filter(([name]) => name === 'can_read_message').map(([, body]) => body.p_user_id)).toEqual([AGENT, OWNER])
      const path = out.match(/to (\S+)$/)?.[1] ?? ''
      expect(await readFile(path, 'utf8')).toBe('bytes')
    })

    it('a file in a chat the agent is in stays the agent\'s, with no owner-DM check', async () => {
      const { db } = await download('00000000-0000-4000-8000-0000000000a1')
      expect(db.signedAs).toEqual([AGENT])
      expect(db.reads.filter((path) => path.startsWith('chat_members?chat_id') || path.startsWith('friendships'))).toEqual([])
    })

    it('a file in an ex-friend\'s DM is refused (not read as the owner)', async () => {
      await expect(download('00000000-0000-4000-8000-0000000000e1')).rejects.toThrow('you can read')
    })
  })

  it('message_send_file to a friend DM points to message_send_file_as_owner before reading the file', async () => {
    const db = fakeDb()
    await expect(callTool(context, 'message_send_file', { chat_id: 'friend-dm', file_path: '/nonexistent/report.pdf' }, db.deps))
      .rejects.toThrow(`use message_send_file_as_owner with friend_user_id user:${FRIEND}`)
  })
})
