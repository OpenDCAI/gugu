// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chatDbMock, identityDbMock, identityRpcMock, schemaMock } = vi.hoisted(() => ({
  chatDbMock: { from: vi.fn(), rpc: vi.fn() },
  identityDbMock: { from: vi.fn() },
  identityRpcMock: vi.fn(),
  schemaMock: vi.fn(),
}))

let chatMembers: Array<{ chat_id: string; user_id: string; role: string }>
let chatMembersSequence: Array<Array<{ chat_id: string; user_id: string; role: string }>> | null
let chatMembersAttempts: number
let chatErrorTables: Set<string>
let agentStates: Array<Record<string, unknown>>
let identityUsers: Array<Record<string, unknown>>
let chatMemberUpdatePayload: Record<string, unknown> | null
let chatMemberInsertPayload: Record<string, unknown> | null
let chatMemberUpsertPayload: Record<string, unknown> | null
let agentStateUpdatePayload: Record<string, unknown> | null
let existingChatMemberForJoin: { chat_id: string; user_id: string; role: string } | null

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'owner-1' } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
  },
  dataClient: {
    channel: vi.fn(),
    removeChannel: vi.fn(),
    realtime: { setAuth: vi.fn() },
    schema: schemaMock,
  },
  chatDb: chatDbMock,
  identityDb: identityDbMock,
  dbPayload: (value: unknown) => value,
  getCurrentAuthUserId: vi.fn(async () => 'owner-1'),
  syncSchemaClientSession: vi.fn(async () => undefined),
}))

import { chatService, GroupCollabEmptyError } from '../../../../apps/desktop/src/lib/chat'

type QueryResult = { data: unknown; error: { message: string } | null }

function chatTableResult(table: string): QueryResult {
  if (chatErrorTables.has(table)) {
    return { data: null, error: { message: `${table} transient failure` } }
  }
  switch (table) {
    case 'group_scheduler_states':
      return { data: null, error: null }
    case 'active_members': {
      const rows = chatMembersSequence
        ? chatMembersSequence[Math.min(chatMembersAttempts, chatMembersSequence.length - 1)]
        : chatMembers
      if (chatMembersSequence) chatMembersAttempts++
      return {
        data: rows,
        error: null,
      }
    }
    case 'group_tasks':
      return { data: [], error: null }
    case 'group_agent_states':
      return {
        data: agentStates,
        error: null,
      }
    case 'group_outputs':
      return { data: [], error: null }
    default:
      throw new Error(`unexpected chat table ${table}`)
  }
}

function chatFrom(table: string) {
  const result = chatTableResult(table)
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => {
        if (table === 'group_scheduler_states') {
          return { maybeSingle: vi.fn(async () => result) }
        }
        if (table === 'group_tasks') {
          return {
            order: vi.fn(() => ({
              order: vi.fn(async () => result),
            })),
          }
        }
        if (table === 'group_outputs') {
          return {
            order: vi.fn(() => ({
              limit: vi.fn(async () => result),
            })),
          }
        }
        return Promise.resolve(result)
      }),
    })),
  }
}

function identityFrom(table: string) {
  if (table !== 'users') throw new Error(`unexpected identity table ${table}`)
  return { select: vi.fn(() => ({ in: vi.fn(async () => ({ data: identityUsers, error: null })) })) }
}

describe('group collaboration removed agent residue', () => {
  beforeEach(() => {
    chatMembers = [
      { chat_id: 'group-1', user_id: 'owner-1', role: 'owner' },
      { chat_id: 'group-1', user_id: 'user-missing', role: 'member' },
      { chat_id: 'group-1', user_id: 'agent-missing', role: 'member' },
    ]
    agentStates = []
    identityUsers = [
      {
        id: 'owner-1',
        gugu_number: 100001,
        type: 'human',
        display_name: 'Alice',
        avatar: '/assets/user.svg',
        bio: null,
        owner_user_id: null,
        agent_public: null,
        desired_status: null,
        device_id: null,
        category: null,
        is_official: null,
        local_path: null,
        created_at: null,
        updated_at: null,
      },
      {
        id: 'agent-1',
        gugu_number: 100002,
        type: 'agent',
        display_name: 'Agent One',
        avatar: null,
        bio: null,
        owner_user_id: 'owner-1',
        agent_public: false,
        desired_status: 'offline',
        device_id: null,
        category: null,
        is_official: null,
        local_path: null,
        created_at: null,
        updated_at: null,
      },
    ]
    chatMemberUpdatePayload = null
    chatMemberInsertPayload = null
    chatMemberUpsertPayload = null
    agentStateUpdatePayload = null
    chatMembersSequence = null
    chatMembersAttempts = 0
    chatErrorTables = new Set()
    existingChatMemberForJoin = { chat_id: 'group-1', user_id: 'agent-1', role: 'member' }
    schemaMock.mockReset()
    identityRpcMock.mockReset()
    chatDbMock.from.mockReset()
    identityDbMock.from.mockReset()
    schemaMock.mockImplementation((schema: string) => {
      if (schema === 'chat') return { from: chatFrom, rpc: async (name: string) => {
        if (name !== 'list_member_ids') throw new Error(`unexpected collaboration RPC ${name}`)
        return chatTableResult('chat_members')
      } }
      if (schema === 'identity') return { from: identityFrom, rpc: identityRpcMock }
      throw new Error(`unexpected schema ${schema}`)
    })
    chatDbMock.from.mockImplementation((table: string) => {
      if (table === 'chat_members') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: existingChatMemberForJoin,
                  error: null,
                })),
              })),
            })),
          })),
          update: vi.fn((payload: Record<string, unknown>) => {
            chatMemberUpdatePayload = payload
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(async () => ({ error: null })),
              })),
            }
          }),
          insert: vi.fn((payload: Record<string, unknown>) => {
            chatMemberInsertPayload = payload
            return Promise.resolve({ error: null })
          }),
          upsert: vi.fn((payload: Record<string, unknown>) => {
            chatMemberUpsertPayload = payload
            return Promise.resolve({ error: null })
          }),
        }
      }
      if (table === 'group_agent_states') {
        return {
          update: vi.fn((payload: Record<string, unknown>) => {
            agentStateUpdatePayload = payload
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(async () => ({ error: null })),
              })),
            }
          }),
          upsert: vi.fn(() => Promise.resolve({ error: null })),
        }
      }
      throw new Error(`unexpected chat db table ${table}`)
    })
    identityDbMock.from.mockImplementation((table: string) => {
      if (table !== 'users') throw new Error(`unexpected identity db table ${table}`)
      return {
        select: vi.fn(() => ({
          in: vi.fn((_field: string, ids: string[]) => ({
            abortSignal: vi.fn(async () => ({
              data: identityUsers.filter((identity) => ids.includes(String(identity.id))),
              error: null,
            })),
          })),
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: { id: 'agent-1', type: 'agent', owner_user_id: 'owner-1' },
                error: null,
              })),
            })),
          })),
        })),
      }
    })
  })

  it('reads the roster from active_members and classifies members by their live identity, with no tombstone probe', async () => {
    chatMembers = [
      { chat_id: 'group-1', user_id: 'owner-1', role: 'owner' },
      { chat_id: 'group-1', user_id: 'agent-1', role: 'member' },
    ]
    const { snapshot } = await chatService.getGroupCollab('group-1')

    expect(snapshot.humans).toMatchObject([{ id: 'owner-1', account_status: null }])
    expect(snapshot.agents).toMatchObject([{ id: 'agent-1', type: 'agent', account_status: 'active' }])
    expect(snapshot.humans.every((member) => !('display_name' in member) && !('avatar' in member))).toBe(true)
    expect(snapshot.agents.every((member) => !('display_name' in member) && !('avatar' in member))).toBe(true)
    // Archived identities leave active_members at once, so the roster never probes presence for tombstones.
    expect(identityRpcMock).not.toHaveBeenCalled()
  })

  it('fails loud when an active member identity is not returned, instead of guessing human or removed', async () => {
    agentStates = [{ agent_user_id: 'agent-missing' }]

    await expect(chatService.getGroupCollab('group-1')).rejects.toThrow(
      'Active group member identity is unavailable: user-missing'
    )
    expect(identityRpcMock).not.toHaveBeenCalled()
  })

  it('读一次:空名册就是 GroupCollabEmptyError,❌ 原地重读四轮(#589 的拖动由下一条成员 / 修订事件再读)', async () => {
    chatMembersSequence = [[], [{ chat_id: 'group-1', user_id: 'owner-1', role: 'owner' }]]
    identityUsers = [identityUsers[0]]

    // @@@5856 在话题里「名册是空的」的正常含义是「你看得见它,但还不是参与者」(spec:参与靠说话),❌ 一律说成「没权限」。
    await expect(chatService.getGroupCollab('group-1')).rejects.toThrow(GroupCollabEmptyError)
    expect(chatMembersAttempts).toBe(1)
  })

  it('附属表读失败照实抛,❌ 当成「空」画出来', async () => {
    chatMembers = [{ chat_id: 'group-1', user_id: 'owner-1', role: 'owner' }]
    identityUsers = [identityUsers[0]]
    chatErrorTables = new Set(['group_outputs'])

    await expect(chatService.getGroupCollab('group-1')).rejects.toThrow('group_outputs')
  })

  it('成员读失败照实抛', async () => {
    chatErrorTables = new Set(['active_members'])

    await expect(chatService.getGroupCollab('group-1')).rejects.toThrow(
      'active_members transient failure'
    )
  })

  it('changes agent authority role without mutating runtime agent state', async () => {
    chatDbMock.rpc.mockResolvedValueOnce({ data: { chat_id: 'group-1', user_id: 'agent-1', role: 'admin' }, error: null })
    await chatService.setGroupMemberRole('group-1', 'agent-1', 'admin')
    expect(chatDbMock.rpc).toHaveBeenCalledWith('set_group_member_role_as', { p_chat_id: 'group-1', p_member_user_id: 'agent-1', p_role: 'admin', p_as_user_id: 'owner-1' })
    expect(chatMemberUpdatePayload).toBeNull()
    expect(agentStateUpdatePayload).toBeNull()
  })

  it('adds a new group agent through add_group_agent, never by a direct chat_members insert', async () => {
    // 「能否加此人」(上限 / 审批 / 邀请开关)只在库里一处判;直插会绕过「Agent 加入需审批」的队列。
    existingChatMemberForJoin = null
    chatDbMock.rpc.mockResolvedValueOnce({ data: { chat_id: 'group-1', status: 'joined' }, error: null })

    await expect(chatService.joinGroupAgent('group-1', 'agent-1', 'member')).resolves.toBe('joined')

    expect(chatDbMock.rpc).toHaveBeenCalledWith('add_group_agent', { p_chat_id: 'group-1', p_agent_user_id: 'agent-1', p_message: null, p_as_user_id: 'owner-1', p_as_task: false })
    expect(chatMemberInsertPayload).toBeNull()
    expect(chatMemberUpsertPayload).toBeNull()
  })
})
