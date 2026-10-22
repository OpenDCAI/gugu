// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  existing: null as null | { role: string },
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
}))

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { schema: vi.fn(() => ({})) },
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })), onAuthStateChange: vi.fn() } },
  identityDb: { rpc: vi.fn() },
  chatDb: { rpc: mocks.rpc, from: mocks.from },
  getCurrentAuthUserId: vi.fn(async () => 'owner-1'),
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  DISPLAY_IDENTITY_SELECT: 'canonical',
  readAgentProfileTypes: vi.fn(async () => []),
  readDisplayIdentities: vi.fn(async () => [{ id: 'agent-1', type: 'agent', owner_user_id: 'owner-1', device_id: 'dev-1', display_name: 'A' }]),
  readOwnedDisplayIdentities: vi.fn(async () => []),
  readRequiredDisplayIdentities: vi.fn(async () => []),
}))
vi.mock('@gugu/core/cloud/supabase', () => ({ dbPayload: (value: unknown) => value }))

import { chatService } from '../../../../apps/desktop/src/lib/chat'

function chain(table: string) {
  const builder: Record<string, unknown> = {}
  const self = () => builder
  builder.select = self
  builder.eq = self
  builder.maybeSingle = async () => ({ data: mocks.existing, error: null })
  builder.insert = (payload: unknown) => { mocks.writes.push({ table, op: 'insert', payload }); return { error: null } }
  builder.update = (payload: unknown) => { mocks.writes.push({ table, op: 'update', payload }); return { eq: () => ({ eq: async () => ({ error: null }) }) } }
  builder.upsert = async (payload: unknown) => { mocks.writes.push({ table, op: 'upsert', payload }); return { error: null } }
  return builder
}

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.from.mockReset().mockImplementation((table: string) => chain(table))
  mocks.existing = null
  mocks.writes = []
})

describe('joinGroupAgent 走 add_group_agent,需审批 ⇒ 已提交审批', () => {
  it('pending_approval:不直插 chat_members、不写 agent 状态,返回 pending_approval', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { chat_id: 'g1', status: 'pending_approval', request_id: 'r1' }, error: null })
    await expect(chatService.joinGroupAgent('g1', 'agent-1', 'member')).resolves.toBe('pending_approval')
    expect(mocks.rpc).toHaveBeenCalledWith('add_group_agent', { p_chat_id: 'g1', p_agent_user_id: 'agent-1', p_message: null, p_as_user_id: 'owner-1' })
    expect(mocks.writes).toEqual([])
  })

  it('joined: agent 状态由同一个 RPC 写,客户端不再单独 upsert', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { chat_id: 'g1', status: 'joined' }, error: null })
    await expect(chatService.joinGroupAgent('g1', 'agent-1', 'member')).resolves.toBe('joined')
    expect(mocks.writes.map((w) => `${w.table}:${w.op}`)).toEqual([])
    expect(mocks.writes.some((w) => w.table === 'chat_members' && w.op === 'insert')).toBe(false)
  })

  it('库里的拒绝标识翻成产品文案,原文留在 cause 里', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'member_limit_reached', code: 'P0001' } })
    const error = await chatService.joinGroupAgent('g1', 'agent-1', 'member').catch((caught: Error) => caught)
    expect((error as Error).message).not.toContain('member_limit_reached')
    expect((error as Error & { cause?: { message: string } }).cause?.message).toBe('member_limit_reached')
  })
})

describe('decideGroupJoin 把批准时的重判结果翻成文案', () => {
  it('发起人已退群 ⇒ 不露数据库原文', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'join_request_requester_left', code: 'P0001' } })
    const error = await chatService.decideGroupJoin('r1', true).catch((caught: Error) => caught)
    expect((error as Error).message).not.toContain('join_request_requester_left')
  })
})

describe('listMyAgentJoinRequests', () => {
  it('每个 agent 取最近一条状态', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ agent_user_id: 'a1', status: 'rejected' }, { agent_user_id: 'a1', status: 'pending' }], error: null })
    expect([...(await chatService.listMyAgentJoinRequests('g1'))]).toEqual([['a1', 'rejected']])
  })
})
