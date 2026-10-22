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
  saved?: unknown
  managementError?: Error
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
    if (name === 'chat_facts') return [{ kind: 'group' }]
    if (name === 'update_group_as' || name === 'group_info_as') {
      if (options.managementError) throw options.managementError
      return options.saved ?? { id: body.p_chat_id, name: '保存的群', can_manage: true, can_dissolve: false }
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
      if (path.startsWith('chats?') && path.endsWith('select=kind')) return [{ kind: 'group' }]
      throw new Error(`group tools must not read tables directly: ${path}`)
    },
    restPatchReturning: async (path: string, body: Record<string, unknown>) => {
      patches.push({ path, body })
      throw new Error('direct group PATCH must not be used')
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

describe('group_add_agent through the shared actor door', () => {
  test('adds itself with the caller’s actor, without a second owner-role preflight', async () => {
    const h = harness()
    expect(JSON.parse(await h.call('group_add_agent', { chat_id: GROUP })))
      .toEqual({ status: 'joined', chat_id: GROUP, agent_user_id: `user:${SELF}` })
    expect(h.rpcs).toEqual([{ name: 'add_group_agent', body: { p_chat_id: GROUP, p_agent_user_id: SELF, p_message: null, p_as_user_id: SELF } }])
  })
  test('already_member is authoritative from the database', async () => {
    const h = harness({ addResult: { status: 'already_member', chat_id: GROUP } })
    expect(JSON.parse(await h.call('group_add_agent', { chat_id: GROUP })).status).toBe('already_member')
    expect(h.rpcs.map((call) => call.name)).toEqual(['add_group_agent'])
  })
  test('returns pending_approval without claiming membership', async () => {
    const h = harness({ addResult: { status: 'pending_approval', chat_id: GROUP, request_id: 'req-1' } })
    expect(JSON.parse(await h.call('group_add_agent', { chat_id: GROUP })))
      .toMatchObject({ status: 'pending_approval', request_id: 'req-1' })
  })
  test('resolves a sibling session as the target while the actor stays the caller', async () => {
    const h = harness({ peers: [{ sessionId: 'conv-sibling', identity: { users: { id: SIBLING } } }] })
    await h.call('group_add_agent', { chat_id: GROUP, agent: 'session:conv-sibling' })
    expect(h.rpcs).toEqual([{ name: 'add_group_agent', body: { p_chat_id: GROUP, p_agent_user_id: SIBLING, p_message: null, p_as_user_id: SELF } }])
  })
  test('resolves gugu and aid addresses through the existing identity boundary', async () => {
    for (const address of ['gugu:4242', `aid:${SIBLING}`]) {
      const h = harness({ guguNumbers: { 4242: SIBLING } })
      await h.call('group_add_agent', { chat_id: GROUP, agent: address })
      expect(h.rpcs.find((call) => call.name === 'add_group_agent')?.body).toMatchObject({ p_agent_user_id: SIBLING, p_as_user_id: SELF })
    }
  })
  test('propagates ownership/admission rejection from the one database check', async () => {
    for (const detail of ['agent_not_owned', 'actor_not_member', 'member_limit_reached']) {
      const h = harness({ addError: new RpcHttpError(400, { detail }) })
      await expect(h.call('group_add_agent', { chat_id: GROUP })).rejects.toThrow(detail)
    }
    await expect(harness({ addResult: { status: 'accepted', chat_id: GROUP } }).call('group_add_agent', { chat_id: GROUP })).rejects.toThrow(/unexpected membership result/)
  })
})

describe('group_update has one sparse RPC write', () => {
  test('maps rules to group_prompt and preserves the actual agent actor', async () => {
    const h = harness({ saved: { id: GROUP, name: '保存的群', can_manage: true, can_dissolve: false } })
    const result = JSON.parse(await h.call('group_update', { chat_id: GROUP, changes: { rules: '规则', description: '' } }))
    expect(result.name).toBe('保存的群')
    expect(h.rpcs.filter((call) => call.name !== 'chat_facts')).toEqual([{ name: 'update_group_as', body: { p_chat_id: GROUP, p_changes: { group_prompt: '规则', description: '' }, p_as_user_id: SELF } }])
    expect(h.patches).toEqual([])
  })
  test('rejects owner authority and missing authoritative receipts', async () => {
    await expect(harness({ managementError: new Error('group_manager_required') }).call('group_update', { chat_id: GROUP, changes: { name: 'X' } })).rejects.toThrow('group_manager_required')
    await expect(harness({ saved: [] }).call('group_update', { chat_id: GROUP, changes: { name: 'X' } })).rejects.toThrow(/no authoritative result/)
  })
  test('advertises no actor override and no legacy update schema', () => {
    const def = TOOL_DEFS.find((entry: { name: string }) => entry.name === 'group_update')
    for (const args of [{ chat_id: GROUP, name: 'X' }, { chat_id: GROUP, changes: {} }, { chat_id: GROUP, changes: { name: ' ' } }, { chat_id: GROUP, changes: { status: 'archived' } }, { chat_id: GROUP, changes: { name: 'X' }, as_user_id: SELF }]) {
      expect(def.schema.strict().safeParse(args).success).toBe(false)
    }
  })
})
