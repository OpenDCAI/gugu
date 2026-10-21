// #6492 group_list / group_add_agent:agent 列出主人所在的群、自己入群、把主人名下的其他 agent 拉进群。
// 库那一半(chat.list_owner_groups_as / chat.add_group_agent)在 tests/contract/supabase/ownerGroupTools6492.test.ts
// 对着迁移完的真库判;这里钉 MCP 这一侧:调哪条 RPC、以谁的身份、地址怎么解析、「已是成员」在哪判、错误怎么说。
import { describe, expect, test } from 'vitest'
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs;运行时 import 可用。
import { callTool as callToolImpl, RpcHttpError, TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const SELF = '11111111-1111-4111-8111-111111111111'
const SIBLING = '22222222-2222-4222-8222-222222222222'
const GROUP = '33333333-3333-4333-8333-333333333333'
const OTHER_GROUP = '44444444-4444-4444-8444-444444444444'

type Row = { chat_id: string; public_id: number; name: string; member_count: number; joined: boolean; agent_join_needs_approval: boolean }
type RpcCall = { name: string; body: Record<string, unknown> }

/** 按「以谁的身份问」回一份 list_owner_groups_as;add_group_agent 的结果可换。 */
function harness(options: {
  groupsAs?: Record<string, Row[]>
  notOwned?: string[]
  addResult?: unknown
  addError?: Error
  peers?: Array<{ sessionId: string; identity: { users: { id: string } } }>
  guguNumbers?: Record<number, string>
  ownerPinned?: string[]
  patchRows?: unknown
} = {}) {
  const rpcs: RpcCall[] = []
  const patches: Array<{ path: string; body: Record<string, unknown> }> = []
  const restRpc = async (name: string, body: Record<string, unknown>) => {
    rpcs.push({ name, body })
    if (name === 'list_owner_groups_as') {
      const actor = String(body.p_as_user_id)
      if (options.notOwned?.includes(actor)) {
        throw new RpcHttpError(400, { detail: `Not allowed to act as ${actor}` })
      }
      return options.groupsAs?.[actor] ?? []
    }
    if (name === 'add_group_agent') {
      if (options.addError) throw options.addError
      return options.addResult ?? { status: 'joined', chat_id: body.p_chat_id }
    }
    if (name === 'search_users') {
      const number = Number(body.p_query)
      const id = options.guguNumbers?.[number]
      return id ? [{ id, gugu_number: number, display_name: 'Sibling', type: 'agent' }] : []
    }
    throw new Error(`unexpected rpc ${name}`)
  }
  const context = {
    supabaseUrl: '',
    anonKey: '',
    agentId: SELF,
    threadRootId: null,
    guguHome: '/tmp/gugu-group-test',
    getAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: 'owner-1' })).toString('base64url')}.x`,
    runHostAction: async (action: { action: string }) => {
      if (action.action !== 'peers') throw new Error(`unexpected host action ${action.action}`)
      return options.peers ?? []
    },
  }
  const deps = {
    restRpc,
    // 群能不能看见、在不在里面都只按 RPC 判;直读的只有主人自己那几行里置顶的(置顶是主人自己的状态)。
    restGet: async (path: string) => {
      if (path === 'chat_members?user_id=eq.owner-1&is_pinned=is.true&select=chat_id') {
        return (options.ownerPinned ?? []).map((chat_id) => ({ chat_id }))
      }
      throw new Error(`group tools must not read tables directly: ${path}`)
    },
    restPatchReturning: async (path: string, body: Record<string, unknown>) => {
      patches.push({ path, body })
      return options.patchRows ?? []
    },
  }
  const call = (name: string, args: Record<string, unknown>) => callToolImpl(context, name, args, deps)
  return { call, rpcs, patches }
}

const row = (overrides: Partial<Row> = {}): Row => ({
  chat_id: GROUP, public_id: 207957, name: 'Design', member_count: 3, joined: false, agent_join_needs_approval: false, ...overrides,
})

describe('#6492 group_list', () => {
  test('以当前 agent 的身份调 list_owner_groups_as,行原样返回,只多一格主人的置顶', async () => {
    const rows = [row(), row({ chat_id: OTHER_GROUP, public_id: 207613, name: 'Ops', joined: true })]
    const h = harness({ groupsAs: { [SELF]: rows }, ownerPinned: [OTHER_GROUP] })
    const out = JSON.parse(await h.call('group_list', {}))
    expect(out).toEqual({
      total: 2,
      rows: '1-2',
      next: null,
      items: [{ ...rows[0], pinned: false }, { ...rows[1], pinned: true }],
    })
    expect(h.rpcs).toEqual([{ name: 'list_owner_groups_as', body: { p_as_user_id: SELF } }])
    expect(JSON.parse(await h.call('group_list', { joined: false })).items.map((g: Row) => g.name)).toEqual(['Design'])
    expect(JSON.parse(await h.call('group_list', { pinned: true })).items.map((g: Row) => g.name)).toEqual(['Ops'])
    expect(JSON.parse(await h.call('group_list', { name: 'des' })).items.map((g: Row) => g.name)).toEqual(['Design'])
  })
})

describe('#6492 group_add_agent', () => {
  test('省略 agent = 自己:先以自己身份核群,再走 add_group_agent(与界面同一条路)', async () => {
    const h = harness({ groupsAs: { [SELF]: [row()] } })
    const result = JSON.parse(await h.call('group_add_agent', { chat_id: GROUP }))
    expect(result).toEqual({ status: 'joined', chat_id: GROUP, agent_user_id: `user:${SELF}` })
    expect(h.rpcs).toEqual([
      { name: 'list_owner_groups_as', body: { p_as_user_id: SELF } },
      { name: 'add_group_agent', body: { p_chat_id: GROUP, p_agent_user_id: SELF, p_message: null } },
    ])
  })

  test('已是成员 ⇒ already_member,不再调 add_group_agent(正对照:joined=false 时会调,见上一条)', async () => {
    const h = harness({ groupsAs: { [SELF]: [row({ joined: true })] } })
    expect(JSON.parse(await h.call('group_add_agent', { chat_id: GROUP })))
      .toEqual({ status: 'already_member', chat_id: GROUP, agent_user_id: `user:${SELF}` })
    expect(h.rpcs.map((call) => call.name)).toEqual(['list_owner_groups_as'])
  })

  test('需审批的群 ⇒ pending_approval 原样带回 request_id', async () => {
    const h = harness({
      groupsAs: { [SELF]: [row({ agent_join_needs_approval: true })] },
      addResult: { status: 'pending_approval', chat_id: GROUP, request_id: 'req-1' },
    })
    expect(JSON.parse(await h.call('group_add_agent', { chat_id: GROUP })))
      .toEqual({ status: 'pending_approval', chat_id: GROUP, request_id: 'req-1', agent_user_id: `user:${SELF}` })
  })

  test('session:<id> 经本机名录解析成那条会话的身份,核群与入群都用它', async () => {
    const h = harness({
      groupsAs: { [SIBLING]: [row()] },
      peers: [{ sessionId: 'conv-sibling', identity: { users: { id: SIBLING } } }],
    })
    const result = JSON.parse(await h.call('group_add_agent', { chat_id: GROUP, agent: 'session:conv-sibling' }))
    expect(result).toMatchObject({ status: 'joined', agent_user_id: `user:${SIBLING}` })
    expect(h.rpcs).toEqual([
      { name: 'list_owner_groups_as', body: { p_as_user_id: SIBLING } },
      { name: 'add_group_agent', body: { p_chat_id: GROUP, p_agent_user_id: SIBLING, p_message: null } },
    ])
  })

  test('gugu:<号> 与 aid:<id> 两种写法落到同一个身份', async () => {
    const byNumber = harness({ groupsAs: { [SIBLING]: [row()] }, guguNumbers: { 4242: SIBLING } })
    await byNumber.call('group_add_agent', { chat_id: GROUP, agent: 'gugu:4242' })
    expect(byNumber.rpcs.find((call) => call.name === 'add_group_agent')?.body.p_agent_user_id).toBe(SIBLING)
    const byAid = harness({ groupsAs: { [SIBLING]: [row()] } })
    await byAid.call('group_add_agent', { chat_id: GROUP, agent: `aid:${SIBLING}` })
    expect(byAid.rpcs.find((call) => call.name === 'add_group_agent')?.body.p_agent_user_id).toBe(SIBLING)
  })

  test('不是主人名下的 agent(人、别人的 agent)⇒ 报错并指向 message_invite,不调 add_group_agent', async () => {
    const h = harness({ notOwned: [SIBLING] })
    await expect(h.call('group_add_agent', { chat_id: GROUP, agent: `user:${SIBLING}` }))
      .rejects.toThrow(/not one of your owner's agents[\s\S]*message_invite/)
    expect(h.rpcs.map((call) => call.name)).toEqual(['list_owner_groups_as'])
  })

  test('主人不在的群 ⇒ 报错并指向 group_list,不调 add_group_agent', async () => {
    const h = harness({ groupsAs: { [SELF]: [row({ chat_id: OTHER_GROUP })] } })
    await expect(h.call('group_add_agent', { chat_id: GROUP })).rejects.toThrow(/not an active group your owner is in[\s\S]*group_list/)
    expect(h.rpcs.map((call) => call.name)).toEqual(['list_owner_groups_as'])
  })

  test('库回了认不出的状态 ⇒ fail loud,❌ 不报成已入群', async () => {
    const h = harness({ groupsAs: { [SELF]: [row()] }, addResult: { status: 'accepted', chat_id: GROUP } })
    await expect(h.call('group_add_agent', { chat_id: GROUP })).rejects.toThrow(/unexpected result/)
  })

  test('库的其余拒绝(人数上限、归档……)原样透给 agent', async () => {
    const h = harness({ groupsAs: { [SELF]: [row()] }, addError: new RpcHttpError(400, { detail: 'member_limit_reached' }) })
    await expect(h.call('group_add_agent', { chat_id: GROUP })).rejects.toThrow(/member_limit_reached/)
  })

  test('三件工具归 group 域,两件写类(不认识的键直接拒)', () => {
    const defs = (TOOL_DEFS as Array<{ name: string; writer?: boolean }>).filter((def) => def.name.startsWith('group_'))
    expect(defs.map((def) => def.name)).toEqual(['group_list', 'group_add_agent', 'group_create', 'group_update'])
    expect(defs.filter((def) => def.writer).map((def) => def.name)).toEqual(['group_add_agent', 'group_create', 'group_update'])
  })
})

// #6698 group_update:与人在群设置里改群资料同一个写口(PATCH chats),判权交给库(chats_update_owner)。
// 库那一半(主人是群主 / 管理员才改得动)在 ownerGroupTools6492 契约用例里对着真库判。
describe('#6698 group_update', () => {
  const saved = { id: GROUP, name: '问题汇总群', description: null }

  test('只 PATCH 这一个群(kind=group),值先 trim;回的是库里存下的那一行', async () => {
    const h = harness({ patchRows: [saved] })
    expect(JSON.parse(await h.call('group_update', { chat_id: GROUP, name: '  问题汇总群 ', description: '   ' })))
      .toEqual({ chat_id: GROUP, name: '问题汇总群', description: null })
    expect(h.patches).toEqual([{
      path: `chats?id=eq.${GROUP}&kind=eq.group&select=id,name,description`,
      body: { name: '问题汇总群', description: null },
    }])
    expect(h.rpcs).toEqual([])
  })

  test('只给 description 就只写 description', async () => {
    const h = harness({ patchRows: [{ ...saved, description: '收问题' }] })
    await h.call('group_update', { chat_id: GROUP, description: '收问题' })
    expect(h.patches.map((p) => p.body)).toEqual([{ description: '收问题' }])
  })

  test('改到 0 行(主人不是群主 / 管理员,或不是群)⇒ 报错说清是主人没权限,❌ 当作改好了', async () => {
    const h = harness({ patchRows: [] })
    await expect(h.call('group_update', { chat_id: GROUP, name: 'X' }))
      .rejects.toThrow(/your owner is not the owner or an admin of group/)
  })

  test('空名字、什么都没给 ⇒ 报错,不发请求', async () => {
    const h = harness({ patchRows: [saved] })
    await expect(h.call('group_update', { chat_id: GROUP, name: '   ' })).rejects.toThrow(/name cannot be empty/)
    await expect(h.call('group_update', { chat_id: GROUP })).rejects.toThrow(/pass name, description, or both/)
    expect(h.patches).toEqual([])
  })
})
