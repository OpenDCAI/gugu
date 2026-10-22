// #5856 话题(topic)的 agent 工具面。产品预期见 product spec;数据层见
// gugu-supabase 的 supabase/migrations/20260918211[5-7]00_*_5856.sql。
//
// 这一组测试守的是四条**只要错了产品行为就错、而且不会自己响**的格子:
//   ① topic_open 必须把 p_as_user_id 传成**当前 agent**(漏传 → create_topic COALESCE 成主人,
//      话题被记成主人开的、来源线无痕;话题照样建出来,所以没有任何一层会报错);
//   ② msg: 前缀的 source_message_id 要在边界解码成裸 id 再进 RPC;
//   ③ topic_invite 走的是**发消息**那条链路(BEFORE INSERT 触发器把被点名的人拉进来),
//      ❌ 不是直写 chat_members —— 直写既过不了 RLS,也绕开了「点名即入列」这条产品规则;
//   ④ 拉的人只能来自**来源线**,而客户端那道成员闸必须与数据层 chat.is_addressable_in 同形,
//      否则闸比规则严 = 话题里永远拉不进人,而数据库一条错都没报。
import { describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.GUGU_AGENT_ID = 'agent-1'
  process.env.GUGU_ACCESS_TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'owner-1' })).toString('base64url')}.x`
})
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs；运行时 import 可用。
import { callTool as callToolImpl, callToolWithState, createSessionState, TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const AGENT_ID = 'agent-1'
const OWNER_ID = 'owner-1'
const SOURCE_CHAT = 'src-chat'
const TOPIC_CHAT = 'topic-chat'
const SOURCE_MESSAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PEER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OUTSIDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const TEST_CONTEXT = {
  supabaseUrl: '',
  anonKey: '',
  agentId: AGENT_ID,
  threadRootId: null,
  guguHome: '/tmp/gugu-topic-test',
  getAccessToken: async () => process.env.GUGU_ACCESS_TOKEN || '',
}
function callTool(name: string, args: Record<string, unknown>, deps: Record<string, unknown> = {}) {
  return callToolImpl(TEST_CONTEXT, name, args, deps)
}

type Row = Record<string, unknown>
/**
 * 一条来源线(SOURCE_CHAT:agent + owner + PEER)长出一条话题(TOPIC_CHAT:只有 agent)。
 * PEER 因此是「在来源线里、还不在话题里」的那个人 —— topic_invite 要能拉他,OUTSIDER 要被拒。
 */
function topicHarness(overrides: { members?: Record<string, string[]>; rpc?: (name: string, body: Row) => unknown } = {}) {
  const members: Record<string, string[]> = overrides.members ?? {
    [SOURCE_CHAT]: [AGENT_ID, OWNER_ID, PEER],
    [TOPIC_CHAT]: [AGENT_ID],
  }
  const calls = { gets: [] as string[], rpcs: [] as Array<[string, Row]>, inserts: [] as Array<[string, Row]> }
  const deps = {
    restGet: vi.fn(async (path: string) => {
      calls.gets.push(path)
      const chatMembers = path.match(/^chat_members\?chat_id=eq\.([^&]+)/)
      if (chatMembers) {
        return (members[chatMembers[1]] ?? []).map((user_id) => ({ user_id, role: 'member', listen_mode: 'active' }))
      }
      const chat = path.match(/^chats\?id=eq\.([^&]+)/)
      if (chat) {
        const id = chat[1]
        return [id === TOPIC_CHAT
          ? { id, kind: 'topic', source_chat_id: SOURCE_CHAT, group_prompt: null }
          : { id, kind: 'group', source_chat_id: null, group_prompt: null }]
      }
      if (path.startsWith('users?id=in.')) {
        return [{ id: PEER, display_name: 'Bob', type: 'human', gugu_number: 4242 }]
      }
      return []
    }),
    restRpc: vi.fn(async (name: string, body: Row) => {
      calls.rpcs.push([name, body])
      // @@@5856 chat 的基本事实与成员名单都改成了**按 actor** 的 DEFINER RPC —— MCP 用的是主人的
      // JWT,直连 REST 时 agent 在「主人不在的那条线」上开的话题一行都读不到(见 chat_facts 的注释)。
      if (name === 'chat_facts') {
        const id = String(body.p_chat_id)
        return [id === TOPIC_CHAT
          ? { id, kind: 'topic', source_chat_id: SOURCE_CHAT, group_prompt: null }
          : { id, kind: 'group', source_chat_id: null, group_prompt: null }]
      }
      if (name === 'list_member_ids') {
        return (members[String(body.p_chat_id)] ?? []).map((user_id) => ({ user_id, role: 'member', listen_mode: 'active' }))
      }
      return overrides.rpc ? overrides.rpc(name, body) : []
    }),
    restInsert: vi.fn(async (table: string, row: Row) => { calls.inserts.push([table, row]) }),
  }
  return { deps, calls }
}

const CREATED_TOPIC = [{
  chat_id: TOPIC_CHAT,
  public_id: 771,
  name: '把这一格收敛掉',
  source_chat_id: SOURCE_CHAT,
  source_message_id: SOURCE_MESSAGE,
  creator_user_id: AGENT_ID,
}]

describe('#5856 topic_ 域:agent 直接操作话题', () => {
  test('四件工具都挂在 topic 域上,且 ❌ 没有删除(删是人的动作)', () => {
    const topicDefs = (TOOL_DEFS as Array<{ name: string; writer?: boolean }>)
      .filter((def) => def.name.startsWith('topic_'))
    expect(topicDefs.map((def) => def.name).sort()).toEqual(['topic_invite', 'topic_list', 'topic_members', 'topic_open'])
    expect(topicDefs.filter((def) => def.writer).map((def) => def.name).sort()).toEqual(['topic_invite', 'topic_open'])
    expect((TOOL_DEFS as Array<{ name: string }>).some((def) => /^topic_(delete|remove|close|archive)/.test(def.name)))
      .toBe(false)
  })

  // @@@5856 找茬第九轮:chat_facts 对「此刻还读不到这条线的人」返回 0 行,而 chatKindOf 恰恰会在
  // agent 还没被拉进某话题时被调到。把那个 null 记进 Map 就是**终身**的 —— 这个会话余生里这条线的
  // kind 都是 unknown:topic_invite 永远抛「不是一条话题」、@ 一致性闸整条跳过、可点名集合算窄。
  // 「我这一读没拿到」不是「它是 null」。
  test('一次读不到 ❌ 不许被记成终身结论 —— 同一会话里再读一次要拿到真答案', async () => {
    let visible = false
    const { deps, calls } = topicHarness({})
    const realRpc = deps.restRpc
    deps.restRpc = vi.fn(async (name: string, body: Record<string, unknown>) => {
      if (name === 'chat_facts' && !visible) { calls.rpcs.push([name, body]); return [] }
      return realRpc(name, body)
    }) as typeof deps.restRpc
    const state = createSessionState()

    // 第一次:这条话题对它还不可见 ⇒ 读回 0 行,动作按「判不出来」失败。
    await expect(callToolWithState(TEST_CONTEXT, 'topic_members', { chat_id: TOPIC_CHAT }, deps, state))
      .rejects.toThrow()
    // 第二次:它已经在里面了 ⇒ 必须拿到真答案,而不是复用上一次那个 null。
    visible = true
    const after = await callToolWithState(TEST_CONTEXT, 'topic_members', { chat_id: TOPIC_CHAT }, deps, state)
    expect(JSON.stringify(after)).toContain(AGENT_ID)
  })

  test('topic_open 把 p_as_user_id 传成当前 agent —— ❌ 不是主人,否则话题被记成主人开的、来源线无痕', async () => {
    const { deps, calls } = topicHarness({ rpc: () => CREATED_TOPIC })
    await callTool('topic_open', {
      chat_id: SOURCE_CHAT,
      source_message_id: `msg:${SOURCE_MESSAGE}`,
      name: '把这一格收敛掉',
    }, deps)
    // 建之前读一次来源线的 kind(#84:来源是主人与好友的私聊就不建);建完之后还会读一次成员名单
    // (把真实进来的人回给调用方,并单列没进来的)。
    expect(calls.rpcs.map(([name]) => name)).toEqual(['chat_facts', 'create_topic', 'list_member_ids'])
    const [rpcName, body] = calls.rpcs[1]
    expect(rpcName).toBe('create_topic')
    expect(body.p_as_user_id).toBe(AGENT_ID)
    // 判据要能判假:传成主人 id 这条断言必须红。
    expect(body.p_as_user_id).not.toBe(OWNER_ID)
    expect(body.p_source_chat_id).toBe(SOURCE_CHAT)
    expect(body.p_name).toBe('把这一格收敛掉')
  })

  test('topic_open 收 msg: 前缀的 source_message_id 并在边界解码成裸 id;裸 id 当场报错', async () => {
    const { deps, calls } = topicHarness({ rpc: () => CREATED_TOPIC })
    await callTool('topic_open', { chat_id: SOURCE_CHAT, source_message_id: `msg:${SOURCE_MESSAGE}` }, deps)
    const [, created] = calls.rpcs.find(([name]) => name === 'create_topic')!
    expect(created.p_source_message_id).toBe(SOURCE_MESSAGE)
    expect(created.p_source_message_id).not.toContain('msg:')
    // 名字不给 → null,由服务端截自来源消息(spec:建立是一步,不是一张表)。
    expect(created.p_name).toBeNull()

    const bare = topicHarness({ rpc: () => CREATED_TOPIC })
    await expect(callTool('topic_open', { chat_id: SOURCE_CHAT, source_message_id: SOURCE_MESSAGE }, bare.deps))
      .rejects.toThrow(/source_message_id: expected a msg: id/)
    expect(bare.calls.rpcs).toHaveLength(0)
  })

  test('topic_open 没有来源消息就拒:话题不能凭空建', async () => {
    const { deps, calls } = topicHarness({ rpc: () => CREATED_TOPIC })
    await expect(callTool('topic_open', { chat_id: SOURCE_CHAT }, deps)).rejects.toThrow(/source_message_id is required/)
    expect(calls.rpcs).toHaveLength(0)
  })

  test('topic_open 的 to_user_ids 走 resolveRecipientAddresses:咕咕号解析成裸 uuid 再进 RPC', async () => {
    const { deps, calls } = topicHarness({
      rpc: (name) => (name === 'search_users'
        ? [{ id: PEER, display_name: 'Bob', type: 'human', gugu_number: 4242, agent_public: null }]
        : CREATED_TOPIC),
    })
    await callTool('topic_open', {
      chat_id: SOURCE_CHAT,
      source_message_id: `msg:${SOURCE_MESSAGE}`,
      to_user_ids: ['gugu:4242', `user:${OWNER_ID}`],
    }, deps)
    expect(calls.rpcs.map(([name]) => name)).toEqual(['search_users', 'chat_facts', 'create_topic', 'list_member_ids'])
    expect(calls.rpcs[2][1].p_member_user_ids).toEqual([PEER, OWNER_ID])
  })

  test('topic_open 回的是 JSON,且 id 在出口按类型编码(新 chat_id 是 agent 接下来要用的东西)', async () => {
    const { deps } = topicHarness({ rpc: () => CREATED_TOPIC })
    const out = JSON.parse(String(await callTool('topic_open', {
      chat_id: SOURCE_CHAT,
      source_message_id: `msg:${SOURCE_MESSAGE}`,
    }, deps)))
    expect(out.chat_id).toBe(TOPIC_CHAT)
    expect(out.source_message_id).toBe(`msg:${SOURCE_MESSAGE}`)
    expect(out.creator_user_id).toBe(`user:${AGENT_ID}`)
  })

  test('topic_list 走 list_topics_of_chat 并回 JSON 行', async () => {
    const rows = [{
      chat_id: TOPIC_CHAT,
      name: '把这一格收敛掉',
      source_message_id: SOURCE_MESSAGE,
      creator_user_id: AGENT_ID,
      last_message_at: '2026-09-18T00:00:00.000Z',
      message_count: 3,
      participant_count: 2,
      is_participant: true,
    }]
    const { deps, calls } = topicHarness({ rpc: () => rows })
    const out = JSON.parse(String(await callTool('topic_list', { chat_id: SOURCE_CHAT }, deps))).items
    // p_as_user_id 必须带上:list_topics_of_chat 判的是 actor,漏传就 COALESCE 成 auth.uid()(= 主人),
    // 于是 is_participant 回答的是「主人在不在」,而工具描述写的是「whether **you** are in it」——
    // agent 据此以为自己已经在里面,不再 @ 自己进去,永远收不到这条线的消息。
    expect(calls.rpcs).toEqual([['list_topics_of_chat', { p_source_chat_id: SOURCE_CHAT, p_as_user_id: AGENT_ID }]])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ chat_id: TOPIC_CHAT, is_participant: true, participant_count: 2 })
    expect(out[0].creator_user_id).toBe(`user:${AGENT_ID}`)
  })

  test('topic_members 与 message_members 逐字段同形 —— 同一个 handler,❌ 不是抄一份实现', async () => {
    const viaTopic = topicHarness()
    const viaMessage = topicHarness()
    const topicRows = JSON.parse(String(await callTool('topic_members', { chat_id: TOPIC_CHAT }, viaTopic.deps))).items
    const messageRows = JSON.parse(String(await callTool('message_members', { chat_id: TOPIC_CHAT }, viaMessage.deps))).items
    expect(topicRows).toEqual(messageRows)
    expect(topicRows[0]).toMatchObject({ user_id: `user:${AGENT_ID}`, role: 'member', listen_mode: 'active', is_self: true })
    // 形状同形。RPC 序列也该一样,只是 topic_members 多一次 kind 校验(它只在话题上成立,
    // 传错 id 要当场响,见下一条);成员名单本身走同一个按 actor 的 RPC。
    expect(viaTopic.calls.rpcs.map(([name]) => name))
      .toEqual(['chat_facts', ...viaMessage.calls.rpcs.map(([name]) => name)])
  })

  test('topic_members 传来源线的 id 要当场响 —— ❌ 不静默回整个群的名单', async () => {
    // topic_list 收的是**来源线**的 id、topic_members 收的是**话题自己**的 id,两者都是 uuid。
    // 传串了原先零报错地回一整个群的成员,agent 据此以为一屋子人都在话题里。
    // topic_invite 对同一个错误早就是 fail-loud,同一条产品规则不许一个响一个哑。
    const { deps } = topicHarness()
    await expect(callTool('topic_members', { chat_id: SOURCE_CHAT }, deps)).rejects.toThrow(/不是一条话题/)
  })

  test('topic_invite 发一条点名消息把人拉进来 —— ❌ 不直写 chat_members', async () => {
    const { deps, calls } = topicHarness()
    const receipt = String(await callTool('topic_invite', {
      chat_id: TOPIC_CHAT,
      to_user_ids: [`user:${PEER}`],
      text: '这条线要你看一眼数据层的判据',
    }, deps))
    expect(calls.inserts).toHaveLength(1)
    const [table, row] = calls.inserts[0]
    expect(table).toBe('messages')
    expect(row.chat_id).toBe(TOPIC_CHAT)
    expect(row.sender_user_id).toBe(AGENT_ID)
    expect(row.to_user_ids).toEqual([PEER])
    expect(row.content).toBe('这条线要你看一眼数据层的判据')
    // 会话绑定的 thread 属于本会话那条线;拉人进的是另一条 chat,照搬会落进一个不存在的 thread。
    expect(row.thread_root_id).toBeNull()
    // 判据要能判假:任何一次 chat_members 的写入都算走错了路。
    expect(calls.inserts.filter(([t]) => t === 'chat_members')).toEqual([])
    expect(receipt).toMatch(/invited into the topic \(id=msg:/)
  })

  test('topic_invite 的收件人走 resolveRecipientAddresses:咕咕号在落库前解析成裸 uuid', async () => {
    const { deps, calls } = topicHarness({
      rpc: (name) => (name === 'search_users'
        ? [{ id: PEER, display_name: 'Bob', type: 'human', gugu_number: 4242, agent_public: null }]
        : []),
    })
    await callTool('topic_invite', { chat_id: TOPIC_CHAT, to_user_ids: ['gugu:4242'], text: '来看一眼' }, deps)
    expect(calls.rpcs.map(([name]) => name)).toContain('search_users')
    expect(calls.inserts[0][1].to_user_ids).toEqual([PEER])
  })

  test('topic_invite 不传 text 就报错,且在任何 REST 之前', async () => {
    const { deps, calls } = topicHarness()
    await expect(callTool('topic_invite', { chat_id: TOPIC_CHAT, to_user_ids: [`user:${PEER}`] }, deps))
      .rejects.toThrow(/topic_invite: text 必填/)
    await expect(callTool('topic_invite', { chat_id: TOPIC_CHAT, to_user_ids: [`user:${PEER}`], text: '   ' }, deps))
      .rejects.toThrow(/topic_invite: text 必填/)
    expect(deps.restGet).not.toHaveBeenCalled()
    expect(calls.inserts).toEqual([])
  })

  test('topic_invite 不点名就报错:没点名的消息谁也拉不进来', async () => {
    const { deps, calls } = topicHarness()
    await expect(callTool('topic_invite', { chat_id: TOPIC_CHAT, to_user_ids: [], text: '来看一眼' }, deps))
      .rejects.toThrow(/至少要有一个人/)
    expect(calls.inserts).toEqual([])
  })

  test('topic_invite 只在话题里成立:群 / 私聊当场拒,❌ 不发一条拉不进人的消息', async () => {
    const { deps, calls } = topicHarness()
    await expect(callTool('topic_invite', { chat_id: SOURCE_CHAT, to_user_ids: [`user:${PEER}`], text: '来看一眼' }, deps))
      .rejects.toThrow(/不是一条话题\(kind=group\)/)
    expect(calls.inserts).toEqual([])
  })

  test('能拉不能加:来源线里没有的人被拒,而来源线里的人通得过(客户端闸与 is_addressable_in 同形)', async () => {
    const outside = topicHarness()
    await expect(callTool('topic_invite', {
      chat_id: TOPIC_CHAT,
      to_user_ids: [`user:${OUTSIDER}`],
      text: '来看一眼',
    }, outside.deps)).rejects.toThrow(new RegExp(`收件人不在本 chat.*${OUTSIDER}`))
    expect(outside.calls.inserts).toEqual([])

    // 对照:PEER 只在来源线里、还不是话题成员 —— 闸若只看话题成员,这一条会红。
    const inside = topicHarness()
    await callTool('topic_invite', { chat_id: TOPIC_CHAT, to_user_ids: [`user:${PEER}`], text: '来看一眼' }, inside.deps)
    expect(inside.calls.inserts[0][1].to_user_ids).toEqual([PEER])
  })

  test('话题不改群的判据:群里点名仍只认群成员(来源线放行只发生在 kind=topic 上)', async () => {
    const { deps, calls } = topicHarness()
    await expect(callTool('message_send', {
      chat_id: SOURCE_CHAT,
      to_user_ids: [`user:${OUTSIDER}`],
      text: '喂',
    }, deps)).rejects.toThrow(new RegExp(`收件人不在本 chat.*${OUTSIDER}`))
    expect(calls.inserts).toEqual([])
  })
})
