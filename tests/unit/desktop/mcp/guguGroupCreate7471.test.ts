import { describe, expect, test } from 'vitest'
// @ts-expect-error — injectable MCP server is an untyped ESM module.
import { callTool, TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { createGroupChat } from '../../../../packages/core/src/cloud/groupChat'

const OWNER = '11111111-1111-4111-8111-111111111111'
const SELF = '22222222-2222-4222-8222-222222222222'
const SIBLING = '33333333-3333-4333-8333-333333333333'
const HUMAN = '44444444-4444-4444-8444-444444444444'
const EXTERNAL = '55555555-5555-4555-8555-555555555555'
const OTHER_OWNER = '66666666-6666-4666-8666-666666666666'
const user = (id: string, type = 'agent', owner_user_id: string | null = OWNER) => ({ id, type, owner_user_id })

function harness(options: { users?: ReturnType<typeof user>[]; failInvite?: string; createError?: string; token?: string } = {}) {
  const rpcs: Array<{ name: string; body: Record<string, unknown> }> = []
  const users = options.users ?? [user(SELF), user(SIBLING), user(HUMAN, 'human', null), user(EXTERNAL, 'agent', OTHER_OWNER)]
  const context = {
    supabaseUrl: '', anonKey: '', agentId: SELF, threadRootId: null, guguHome: '/tmp/gugu-group-create-test',
    getAccessToken: async () => options.token ?? `x.${Buffer.from(JSON.stringify({ sub: OWNER })).toString('base64url')}.x`,
    runHostAction: async () => [{ sessionId: 'sibling', identity: { users: { id: SIBLING } } }],
  }
  const deps = {
    restGet: async (path: string, schema: string) => {
      expect(schema).toBe('identity')
      expect(path).toMatch(/^users\?id=in\.\(/)
      return users.filter((row) => path.includes(row.id))
    },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      rpcs.push({ name, body })
      if (name === 'search_users') return [{ id: SIBLING, gugu_number: 7471 }]
      if (name === 'create_gugu_group') {
        if (options.createError) throw new Error(options.createError)
        return { id: body.p_chat_id }
      }
      if (name === 'request_group_invitation_as') {
        if (body.p_invitee_user_id === options.failInvite) throw new Error('Group does not allow this member to invite')
        return { status: 'pending', chat_id: body.p_chat_id, invitee_user_id: body.p_invitee_user_id, invitation_id: `inv-${body.p_invitee_user_id}` }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  }
  const call = async (args: Record<string, unknown>) => JSON.parse(await callTool(context, 'group_create', args, deps))
  return { call, rpcs }
}

describe('group_create (#7471)', () => {
  test('omitting members creates the owner + caller group through ordinary group creation', async () => {
    const h = harness()
    const out = await h.call({ name: '  海龟汤  ' })
    expect(out).toEqual({ chat_id: expect.any(String), name: '海龟汤', member_user_ids: [`user:${OWNER}`, `user:${SELF}`], invitations: [], invitation_errors: [] })
    expect(h.rpcs).toEqual([{ name: 'create_gugu_group', body: {
      p_chat_id: out.chat_id, p_name: '海龟汤', p_owner_user_id: OWNER,
      p_initial_members: [{ user_id: SELF, role: 'admin' }], p_default_agent_type: null, p_group_prompt: null,
    } }])
  })

  test('deduplicates canonical addresses; only owned agents enter initial_members, humans/external agents receive invitations', async () => {
    const h = harness()
    const out = await h.call({ name: '汤局', members: [
      `user:${OWNER}`, `user:${SELF}`, `aid:${SIBLING}`, 'session:sibling', 'gugu:7471', `user:${HUMAN}`, `user:${HUMAN}`, `user:${EXTERNAL}`,
    ] })
    expect(out.member_user_ids).toEqual([OWNER, SELF, SIBLING].map((id) => `user:${id}`))
    expect(out.invitations).toEqual([HUMAN, EXTERNAL].map((id) => ({ status: 'pending', chat_id: out.chat_id, invitee_user_id: `user:${id}`, invitation_id: `inv-${id}` })))
    const created = h.rpcs.find((call) => call.name === 'create_gugu_group')!
    expect(created.body.p_initial_members).toEqual([{ user_id: SELF, role: 'admin' }, { user_id: SIBLING, role: 'member' }])
    expect(h.rpcs.filter((call) => call.name === 'request_group_invitation_as')).toEqual([HUMAN, EXTERNAL].map((id) => ({
      name: 'request_group_invitation_as', body: { p_chat_id: out.chat_id, p_as_user_id: SELF, p_invitee_user_id: id, p_message: '邀请你加入群聊「汤局」。' },
    })))
  })

  test('failed invitation keeps the created chat_id and original error while later invitations continue', async () => {
    const h = harness({ failInvite: HUMAN })
    const out = await h.call({ name: '汤局', members: [`user:${HUMAN}`, `user:${EXTERNAL}`] })
    expect(out.chat_id).toBe(h.rpcs.find((call) => call.name === 'create_gugu_group')!.body.p_chat_id)
    expect(out.member_user_ids).toEqual([`user:${OWNER}`, `user:${SELF}`])
    expect(out.invitation_errors).toEqual([{ invitee_user_id: `user:${HUMAN}`, error: 'Group does not allow this member to invite' }])
    expect(out.invitations).toHaveLength(1)
    expect(out.invitations[0]).toMatchObject({ status: 'pending', invitee_user_id: `user:${EXTERNAL}` })
  })

  test.each(['someone', SIBLING, 'session:missing', 'user:'])('bad/unresolved member %s fails before creating', async (member) => {
    const h = harness()
    await expect(h.call({ name: '汤局', members: [member] })).rejects.toThrow()
    expect(h.rpcs.some((call) => call.name === 'create_gugu_group')).toBe(false)
  })

  test('missing selected identities fail before writing', async () => {
    for (const users of [[user(SELF)]]) {
      const h = harness({ users })
      await expect(h.call({ name: '汤局', members: [`user:${SIBLING}`] })).rejects.toThrow(/selected person or agent was not found/)
      expect(h.rpcs).toEqual([])
    }
  })

  test('blank name, missing owner JWT and group creation errors are explicit, with no invitations sent', async () => {
    await expect(harness().call({ name: '   ' })).rejects.toThrow(/name cannot be empty/)
    const unauthenticated = harness({ token: '' })
    await expect(unauthenticated.call({ name: '汤局' })).rejects.toThrow(/authenticated owner token/)
    expect(unauthenticated.rpcs).toEqual([])
    const denied = harness({ createError: 'member_limit_reached' })
    await expect(denied.call({ name: '汤局', members: [`user:${HUMAN}`] })).rejects.toThrow('member_limit_reached')
    expect(denied.rpcs.map((call) => call.name)).toEqual(['create_gugu_group'])
  })

  test('registered writer schema rejects unknown fields, wrong types and empty names', () => {
    const def = TOOL_DEFS.find((entry: { name: string }) => entry.name === 'group_create')
    expect(def.writer).toBe(true)
    for (const args of [{ name: '' }, { name: '   ' }, { name: '汤局', members: 'someone' }, { name: '汤局', creator: OWNER }]) {
      expect(def.schema.strict().safeParse(args).success).toBe(false)
    }
  })
})

test('shared ordinary group creation trims name/prompt, removes duplicates/owner, and propagates RPC errors', async () => {
  const calls: Record<string, unknown>[] = []
  const client = { rpc: async (_name: string, body: Record<string, unknown>) => {
    calls.push(body)
    return { data: [{ id: 'saved-chat' }], error: null }
  } }
  expect(await createGroupChat(client, '  汤局 ', OWNER, [SELF, OWNER, SELF, SIBLING], '  章程 ')).toBe('saved-chat')
  expect(calls).toEqual([{
    p_chat_id: expect.any(String), p_name: '汤局', p_owner_user_id: OWNER,
    p_initial_members: [SELF, SIBLING].map((id) => ({ user_id: id, role: 'member' })),
    p_default_agent_type: null, p_group_prompt: '章程',
  }])
  await expect(createGroupChat(client, ' ', OWNER, [SELF])).rejects.toThrow('Group name is required')
  expect(await createGroupChat(client, '汤局', OWNER, [OWNER])).toBe('saved-chat')
  await expect(createGroupChat({ rpc: async () => ({ data: null, error: { message: 'cannot create group' } }) }, '汤局', OWNER, [SELF])).rejects.toThrow('cannot create group')
})
