// @@@6524 分享 Agent = 每位好友一次 request_agent_friend_contact(与 MCP contact_friend 同一条链)。
// 判据:调的是哪个 RPC、带什么参数;pending / rejected / already_member 原样回;RPC 报错或回了意外形状的那位
// 落成 failed(❌ 当成已发邀请),且不拖累其他人;❌ 再调 get_or_create_agent_channel —— 它建 agent 当群主的群,
// #2051 起必撞「exactly 1 human owner」。
import { afterEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const logError = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc } }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({
  rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError }),
}))
const { shareAgentWithFriends } = await import('../../../../apps/desktop/src/lib/agentShare')

type Row = Record<string, unknown> | Record<string, unknown>[] | null
function replyPerFriend(rows: Record<string, { data: Row; error: unknown }>) {
  rpc.mockImplementation(async (_fn: string, args: { p_friend_user_id: string }) => rows[args.p_friend_user_id])
}

afterEach(() => {
  rpc.mockReset()
  logError.mockReset()
})

describe('#6524 shareAgentWithFriends', () => {
  it('每位好友一次 request_agent_friend_contact,带 agent、好友与附言;重复选中只发一次', async () => {
    rpc.mockResolvedValue({ data: { status: 'pending', chat_id: 'chat-1', invitation_id: 'inv-1' }, error: null })

    await shareAgentWithFriends('agent-1', ['friend-1', 'friend-2', 'friend-1'], '主人 把 Claude 2 分享给你。')

    expect(rpc.mock.calls).toEqual([
      ['request_agent_friend_contact', { p_agent_user_id: 'agent-1', p_friend_user_id: 'friend-1', p_message: '主人 把 Claude 2 分享给你。' }],
      ['request_agent_friend_contact', { p_agent_user_id: 'agent-1', p_friend_user_id: 'friend-2', p_message: '主人 把 Claude 2 分享给你。' }],
    ])
    expect(rpc.mock.calls.map(([fn]) => fn)).not.toContain('get_or_create_agent_channel')
  })

  it('pending / rejected / already_member 按选中顺序原样回;已在小群里的带上群 id 与群名', async () => {
    replyPerFriend({
      a: { data: { status: 'pending', chat_id: 'chat-a', invitation_id: 'inv-a', name: 'Claude 2、A', created: true }, error: null },
      b: { data: [{ status: 'rejected', chat_id: 'chat-b', invitation_id: 'inv-b', name: 'Claude 2、B' }], error: null },
      c: { data: { status: 'already_member', chat_id: 'chat-c', name: 'Claude 2、C', created: false }, error: null },
    })

    const outcomes = await shareAgentWithFriends('agent-1', ['a', 'b', 'c'], 'note')

    expect(outcomes).toEqual([
      { friendUserId: 'a', status: 'pending' },
      { friendUserId: 'b', status: 'rejected' },
      { friendUserId: 'c', status: 'already_member', chatId: 'chat-c', name: 'Claude 2、C' },
    ])
    expect(logError).not.toHaveBeenCalled()
  })

  it('某位 RPC 报错只让那一位 failed,其他人照发;原文进日志', async () => {
    const dbError = { message: 'Selected person is not an owner friend', code: 'P0001', details: null, hint: null }
    replyPerFriend({
      a: { data: null, error: dbError },
      b: { data: { status: 'pending', chat_id: 'chat-b', invitation_id: 'inv-b' }, error: null },
    })

    const outcomes = await shareAgentWithFriends('agent-1', ['a', 'b'], 'note')

    expect(outcomes).toEqual([
      { friendUserId: 'a', status: 'failed', error: dbError },
      { friendUserId: 'b', status: 'pending' },
    ])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toMatchObject({ agentUserId: 'agent-1', friendUserId: 'a' })
    expect(String(logError.mock.calls[0][0].error)).toContain('not an owner friend')
  })

  it('已在小群里但 RPC 没给群名(MCP 同一 RPC 也按可空处理)⇒ 仍算已在小群里,❌ 判成邀请失败', async () => {
    rpc.mockResolvedValue({ data: { status: 'already_member', chat_id: 'chat-x', name: null }, error: null })

    const [outcome] = await shareAgentWithFriends('agent-1', ['a'], 'note')

    expect(outcome).toMatchObject({ friendUserId: 'a', status: 'already_member', chatId: 'chat-x' })
  })

  it.each([
    ['状态不在三种之内', { status: 'accepted', chat_id: 'chat-x' }],
    ['已在小群里却没给群 id', { status: 'already_member', name: 'Claude 2、A' }],
    ['什么都没回', null],
  ])('回了意外形状(%s)⇒ failed,❌ 当成已发邀请', async (_label, data) => {
    rpc.mockResolvedValue({ data, error: null })

    const [outcome] = await shareAgentWithFriends('agent-1', ['a'], 'note')

    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' && String(outcome.error)).toContain('unexpected row')
  })
})
